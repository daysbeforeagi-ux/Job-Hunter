import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localDateInZone } from "./settings.js";

export type MetricsPeriod = "week" | "month" | "year";

const statuses = ["ready", "skipped", "failed", "saved", "submitted", "not_interested", "job_closed", "application_blocked", "withdrawn"] as const;
export type OutcomeStatus = typeof statuses[number];

type StatusEvent = {
  timestamp: string;
  jobId: string;
  status: OutcomeStatus;
  reversed: boolean;
};

export type OutcomeMetrics = {
  period: MetricsPeriod;
  from: string;
  through: string;
  added: number;
  total: number;
  counts: Record<OutcomeStatus, number>;
};

function isPeriod(value: string | null): value is MetricsPeriod {
  return value === "week" || value === "month" || value === "year";
}

function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return typeof value === "string" && (statuses as readonly string[]).includes(value);
}

function periodStart(now: Date, period: MetricsPeriod, timeZone: string): Date {
  const [year, month, day] = localDateInZone(now, timeZone).split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, day!));
  if (period === "year") start.setUTCMonth(0, 1);
  else if (period === "month") start.setUTCDate(1);
  else {
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  }
  const target = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  let result = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(result)).map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    result += target - represented;
  }
  return new Date(result);
}

function readStatusEvent(value: unknown): { action: string; timestamp: string; jobId: string; outcome: string; from?: string; status?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
  if (typeof event.action !== "string" || typeof event.timestamp !== "string" || typeof event.jobId !== "string" || typeof event.outcome !== "string") return undefined;
  if (!Number.isFinite(Date.parse(event.timestamp))) return undefined;
  return {
    action: event.action,
    timestamp: event.timestamp,
    jobId: event.jobId,
    outcome: event.outcome,
    from: typeof details.from === "string" ? details.from : undefined,
    status: typeof details.to === "string" ? details.to : typeof details.status === "string" ? details.status : undefined
  };
}

export async function loadOutcomeMetrics(
  period: MetricsPeriod,
  now = new Date(),
  auditPath = resolve("data/audit.jsonl"),
  timeZone = process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata",
  jobs: Array<{ createdAt: string }> = []
): Promise<OutcomeMetrics> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<OutcomeStatus, number>;
  const through = now.getTime();
  const from = periodStart(now, period, timeZone).getTime();
  let source = "";
  try {
    source = await readFile(auditPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const events: StatusEvent[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = readStatusEvent(JSON.parse(line));
      if (!event) continue;
      if (event.action === "queue-scan") {
        const status = event.outcome === "success" ? "ready" : event.outcome === "blocked" ? "skipped" : event.outcome === "failure" ? "failed" : undefined;
        if (status) events.push({ timestamp: event.timestamp, jobId: event.jobId, status, reversed: false });
        continue;
      }
      if (event.outcome !== "success") continue;
      if (event.action === "job-disposition-undo") {
        const reversed = [...events].reverse().find((item) => !item.reversed && item.jobId === event.jobId && item.status === event.from);
        if (reversed) reversed.reversed = true;
        continue;
      }
      if (!(["job-disposition", "manual-status"] as string[]).includes(event.action) || !isOutcomeStatus(event.status)) continue;
      events.push({ timestamp: event.timestamp, jobId: event.jobId, status: event.status, reversed: false });
    } catch {
      continue;
    }
  }

  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!event.reversed && timestamp >= from && timestamp <= through) counts[event.status]++;
  }

  return {
    period,
    from: new Date(from).toISOString(),
    through: new Date(through).toISOString(),
    added: jobs.filter((job) => {
      const created = Date.parse(job.createdAt);
      return Number.isFinite(created) && created >= from && created <= through;
    }).length,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts
  };
}

export function parseMetricsPeriod(value: string | null): MetricsPeriod | undefined {
  return isPeriod(value) ? value : undefined;
}