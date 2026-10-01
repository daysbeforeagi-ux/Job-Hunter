import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { localDateInZone } from "./settings.js";
import { JobAnalysisSchema } from "./types.js";

export const JobStatusSchema = z.enum([
  "queued", "analyzing", "ready", "skipped", "filling", "review",
  "submission_pending", "submitted", "failed", "withdrawn", "saved",
  "not_interested", "job_closed", "application_blocked"
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRecordSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  source: z.string(),
  status: JobStatusSchema,
  previousStatus: JobStatusSchema.optional(),
  statusChangedAt: z.string().datetime().optional(),
  statusNote: z.string().max(1_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
  discoveredTitle: z.string().optional(),
  discoveredCompany: z.string().optional(),
  discoveredLocation: z.string().optional(),
  descriptionText: z.string().max(100_000).optional(),
  analysis: JobAnalysisSchema.optional(),
  selectedResumeSetId: z.string().optional(),
  artifactDirectory: z.string().optional(),
  submittedAt: z.string().datetime().optional(),
  lastScannedAt: z.string().datetime().optional(),
  lastError: z.string().optional()
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

const DatabaseSchema = z.object({ version: z.literal(1), jobs: z.array(JobRecordSchema) });
type Database = z.infer<typeof DatabaseSchema>;

const TRACKING_PARAMS = /^(utm_.+|ref|referrer|source|src|trk|trackingid)$/i;

export function canonicalizeJobUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only HTTPS job URLs are accepted.");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function jobId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

function normalizedIdentity(job: Pick<JobRecord, "discoveredTitle" | "discoveredCompany" | "discoveredLocation">): string | undefined {
  if (!job.discoveredTitle || !job.discoveredCompany) return undefined;
  const normalize = (value: string | undefined) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return [job.discoveredTitle, job.discoveredCompany, job.discoveredLocation].map(normalize).join("|");
}

export class JobStore {
  readonly path: string;

  constructor(path = resolve("data/jobs.json")) {
    this.path = path;
  }

  private async read(): Promise<Database> {
    try {
      return DatabaseSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
      throw error;
    }
  }

  private async write(database: Database): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async add(url: string, source = "manual", metadata: Partial<Pick<JobRecord, "discoveredTitle" | "discoveredCompany" | "discoveredLocation" | "descriptionText">> = {}): Promise<{ job: JobRecord; created: boolean }> {
    const canonicalUrl = canonicalizeJobUrl(url);
    const database = await this.read();
    const incomingIdentity = normalizedIdentity(metadata);
    const existing = database.jobs.find((job) =>
      job.canonicalUrl === canonicalUrl || (incomingIdentity && normalizedIdentity(job) === incomingIdentity)
    );
    if (existing) return { job: existing, created: false };
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: jobId(canonicalUrl), url, canonicalUrl, source, status: "queued",
      createdAt: now, updatedAt: now, attempts: 0, ...metadata
    };
    database.jobs.push(job);
    await this.write(database);
    return { job, created: true };
  }

  async list(status?: JobStatus): Promise<JobRecord[]> {
    const jobs = (await this.read()).jobs;
    return jobs.filter((job) => !status || job.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return (await this.read()).jobs.find((job) => job.id === id);
  }

  async next(): Promise<JobRecord | undefined> {
    const ready = (await this.list("ready")).sort((a, b) => (b.analysis?.matchScore || 0) - (a.analysis?.matchScore || 0));
    return ready[0] || (await this.list("queued"))[0];
  }

  async update(id: string, patch: Partial<Omit<JobRecord, "id" | "createdAt">>): Promise<JobRecord> {
    const database = await this.read();
    const index = database.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new Error(`Unknown job id: ${id}`);
    const updated = JobRecordSchema.parse({ ...database.jobs[index], ...patch, updatedAt: new Date().toISOString() });
    database.jobs[index] = updated;
    await this.write(database);
    return updated;
  }

  async submittedToday(now = new Date(), timeZone = process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata"): Promise<number> {
    const localDate = localDateInZone(now, timeZone);
    return (await this.list("submitted")).filter((job) =>
      job.submittedAt && localDateInZone(new Date(job.submittedAt), timeZone) === localDate
    ).length;
  }

  async scannedToday(now = new Date(), timeZone = process.env.JOB_AGENT_TIMEZONE || "Asia/Kolkata"): Promise<number> {
    const today = localDateInZone(now, timeZone);
    return (await this.list()).filter((job) => {
      const scannedAt = job.lastScannedAt || (job.analysis ? job.updatedAt : undefined);
      return scannedAt && localDateInZone(new Date(scannedAt), timeZone) === today;
    }).length;
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const result = Object.fromEntries(JobStatusSchema.options.map((status) => [status, 0])) as Record<JobStatus, number>;
    for (const job of await this.list()) result[job.status]++;
    return result;
  }
}
