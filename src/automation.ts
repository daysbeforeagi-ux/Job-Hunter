import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { discoverJobs, type DiscoveredJob } from "./discovery.js";
import { scanQueuedJobs } from "./scanner.js";
import { loadDailyScanSettings } from "./settings.js";
import { canonicalizeJobUrl, type JobStore } from "./store.js";
import type { Profile } from "./types.js";
import { discoverJobsWithGemini } from "./web-discovery.js";

export type AutomationConfig = {
  enabled: boolean;
  intervalMinutes: number;
  discoveryLimit: number;
  scanLimit: number;
  minimumScore: number;
  defaultDailyScanLimit: number;
};

const AutomationResultSchema = z.object({
  trigger: z.enum(["startup", "schedule", "manual", "cli"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  discovered: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  searches: z.number().int().nonnegative(),
  discoveryErrors: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  dailyScanLimit: z.number().int().nonnegative().default(0),
  scannedBefore: z.number().int().nonnegative().default(0),
  remainingToday: z.number().int().nonnegative().default(0)
});
export type AutomationResult = z.infer<typeof AutomationResultSchema>;

const AutomationStateSchema = z.object({
  version: z.literal(1),
  running: z.boolean(),
  lastStartedAt: z.string().datetime().optional(),
  lastCompletedAt: z.string().datetime().optional(),
  lastResult: AutomationResultSchema.optional(),
  lastError: z.string().max(1_000).optional()
});
export type AutomationState = z.infer<typeof AutomationStateSchema>;

function numberSetting(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

export function loadAutomationConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  return {
    enabled: /^(1|true|yes)$/i.test(env.AUTOMATION_ENABLED || "false"),
    intervalMinutes: numberSetting(env.AUTOMATION_INTERVAL_MINUTES, 360, 30, 1_440),
    discoveryLimit: numberSetting(env.AUTO_DISCOVERY_LIMIT, 60, 1, 60),
    scanLimit: numberSetting(env.AUTO_SCAN_LIMIT, 30, 1, 30),
    minimumScore: numberSetting(env.AUTO_MINIMUM_SCORE, 65, 0, 100),
    defaultDailyScanLimit: numberSetting(env.DAILY_SCAN_LIMIT, 30, 1, 100)
  };
}

function normalizedIdentity(job: DiscoveredJob): string {
  return [job.title, job.company, job.location].map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).join("|");
}

export function selectDiscoveryBatch(webJobs: DiscoveredJob[], atsJobs: DiscoveredJob[], limit: number): DiscoveredJob[] {
  const boundedLimit = Math.max(0, Math.min(60, Math.floor(limit)));
  const sources = [webJobs, atsJobs];
  const positions = [0, 0];
  const seenUrls = new Set<string>();
  const seenIdentities = new Set<string>();
  const selected: DiscoveredJob[] = [];
  let sourceIndex = 0;

  while (selected.length < boundedLimit && positions.some((position, index) => position < sources[index]!.length)) {
    const jobs = sources[sourceIndex]!;
    const job = jobs[positions[sourceIndex]!] ;
    if (job) {
      positions[sourceIndex] = positions[sourceIndex]! + 1;
      const canonicalUrl = canonicalizeJobUrl(job.url);
      const identity = normalizedIdentity(job);
      if (!seenUrls.has(canonicalUrl) && !seenIdentities.has(identity)) {
        selected.push(job);
        seenUrls.add(canonicalUrl);
        seenIdentities.add(identity);
      }
    }
    sourceIndex = (sourceIndex + 1) % sources.length;
  }
  return selected;
}

export async function loadAutomationState(path = resolve("data/automation.json")): Promise<AutomationState> {
  try {
    const parsed = AutomationStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return { ...parsed, running: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Ignoring invalid automation state: ${error instanceof Error ? error.message : String(error)}`);
    return { version: 1, running: false };
  }
}

export async function saveAutomationState(state: AutomationState, path = resolve("data/automation.json")): Promise<void> {
  const valid = AutomationStateSchema.parse(state);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function ingestDiscoveredJobs(store: JobStore, jobs: DiscoveredJob[]): Promise<{ added: number; duplicates: number }> {
  let added = 0;
  let duplicates = 0;
  for (const item of jobs) {
    const stored = await store.add(item.url, item.source, {
      discoveredTitle: item.title,
      discoveredCompany: item.company,
      discoveredLocation: item.location,
      descriptionText: item.descriptionText
    });
    stored.created ? added++ : duplicates++;
  }
  return { added, duplicates };
}

export async function discoverAndStore(profile: Profile, store: JobStore, options: {
  limit?: number;
  sourcesPath?: string;
} = {}) {
  const limit = options.limit ?? 40;
  const atsPromise = discoverJobs(profile, options.sourcesPath || resolve("sources.json")).catch((error) => ({
    jobs: [] as DiscoveredJob[],
    errors: [`ATS feeds: ${error instanceof Error ? error.message : String(error)}`]
  }));
  const webPromise = process.env.GEMINI_API_KEY
    ? discoverJobsWithGemini(profile, { limit })
    : Promise.resolve({ jobs: [] as DiscoveredJob[], errors: ["Gemini web discovery: GEMINI_API_KEY is not configured."], searches: 0 });
  const [ats, web] = await Promise.all([atsPromise, webPromise]);
  const all = selectDiscoveryBatch(web.jobs, ats.jobs, limit);
  const stored = await ingestDiscoveredJobs(store, all);
  return {
    discovered: all.length,
    ...stored,
    searches: web.searches,
    errors: [...web.errors, ...ats.errors]
  };
}

export async function scanWithinDailyBudget(profile: Profile, store: JobStore, config: AutomationConfig, requestedLimit = config.scanLimit) {
  const settings = await loadDailyScanSettings({ defaultLimit: config.defaultDailyScanLimit });
  const scannedBefore = await store.scannedToday();
  const available = Math.max(0, settings.activeDailyLimit - scannedBefore);
  const scan = available
    ? await scanQueuedJobs(profile, store, Math.min(requestedLimit, config.scanLimit, available), config.minimumScore)
    : { scanned: 0, ready: 0, skipped: 0, failed: 0 };
  return {
    ...scan,
    dailyScanLimit: settings.activeDailyLimit,
    scannedBefore,
    remainingToday: Math.max(0, settings.activeDailyLimit - scannedBefore - scan.scanned)
  };
}

export async function runAutomationCycle(profile: Profile, store: JobStore, config: AutomationConfig, trigger: AutomationResult["trigger"]): Promise<AutomationResult> {
  const startedAt = new Date().toISOString();
  const discovery = await discoverAndStore(profile, store, { limit: config.discoveryLimit });
  const scan = await scanWithinDailyBudget(profile, store, config);
  const result: AutomationResult = {
    trigger,
    startedAt,
    completedAt: new Date().toISOString(),
    discovered: discovery.discovered,
    added: discovery.added,
    duplicates: discovery.duplicates,
    searches: discovery.searches,
    discoveryErrors: discovery.errors.length,
    ...scan
  };
  await audit({
    action: "automation-cycle",
    outcome: discovery.errors.length || scan.failed ? "failure" : "success",
    details: {
      trigger, discovered: result.discovered, added: result.added, duplicates: result.duplicates,
      searches: result.searches, discoveryErrors: result.discoveryErrors, scanned: result.scanned,
      ready: result.ready, skipped: result.skipped, failed: result.failed
    }
  });
  return result;
}
