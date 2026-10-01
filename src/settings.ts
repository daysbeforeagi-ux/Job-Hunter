import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const DailyScanSettingsSchema = z.object({
  version: z.literal(1),
  activeDailyLimit: z.number().int().min(1).max(100),
  pendingDailyLimit: z.number().int().min(1).max(100).optional(),
  pendingEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  updatedAt: z.string().datetime()
}).refine(
  (value) => Boolean(value.pendingDailyLimit) === Boolean(value.pendingEffectiveDate),
  "A pending limit and effective date must be stored together."
);

export type DailyScanSettings = z.infer<typeof DailyScanSettingsSchema>;

export function localDateInZone(date = new Date(), timeZone = process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function nextLocalDate(date = new Date(), timeZone = process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata"): string {
  const today = localDateInZone(date, timeZone);
  const noonUtc = new Date(`${today}T12:00:00.000Z`);
  return new Date(noonUtc.getTime() + 86_400_000).toISOString().slice(0, 10);
}

async function writeSettings(settings: DailyScanSettings, path: string): Promise<void> {
  const valid = DailyScanSettingsSchema.parse(settings);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadDailyScanSettings(options: {
  path?: string;
  defaultLimit?: number;
  now?: Date;
  timeZone?: string;
} = {}): Promise<DailyScanSettings> {
  const path = options.path || resolve("data/settings.json");
  const defaultLimit = Math.min(100, Math.max(1, Math.round(options.defaultLimit ?? 20)));
  const now = options.now || new Date();
  const timeZone = options.timeZone || process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata";
  let settings: DailyScanSettings;
  try {
    settings = DailyScanSettingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { version: 1, activeDailyLimit: defaultLimit, updatedAt: now.toISOString() };
  }

  if (settings.pendingDailyLimit && settings.pendingEffectiveDate && localDateInZone(now, timeZone) >= settings.pendingEffectiveDate) {
    settings = {
      version: 1,
      activeDailyLimit: settings.pendingDailyLimit,
      updatedAt: now.toISOString()
    };
    await writeSettings(settings, path);
  }
  return settings;
}

export async function scheduleDailyScanLimit(limit: number, options: {
  path?: string;
  defaultLimit?: number;
  now?: Date;
  timeZone?: string;
} = {}): Promise<DailyScanSettings> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Daily scan limit must be an integer from 1 to 100.");
  const path = options.path || resolve("data/settings.json");
  const now = options.now || new Date();
  const timeZone = options.timeZone || process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata";
  const current = await loadDailyScanSettings({ ...options, path, now, timeZone });
  if (limit === current.activeDailyLimit) {
    if (!current.pendingDailyLimit) return current;
    const restored: DailyScanSettings = {
      version: 1,
      activeDailyLimit: current.activeDailyLimit,
      updatedAt: now.toISOString()
    };
    await writeSettings(restored, path);
    return restored;
  }
  const updated: DailyScanSettings = {
    ...current,
    pendingDailyLimit: limit,
    pendingEffectiveDate: nextLocalDate(now, timeZone),
    updatedAt: now.toISOString()
  };
  await writeSettings(updated, path);
  return updated;
}
