import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit.js";
import {
  discoverAndStore, loadAutomationConfig, loadAutomationState, runAutomationCycle,
  saveAutomationState, scanWithinDailyBudget, type AutomationResult, type AutomationState
} from "./automation.js";
import { loadOutcomeMetrics, parseMetricsPeriod } from "./metrics.js";
import { loadDailyScanSettings, scheduleDailyScanLimit } from "./settings.js";
import { loadSheetsConfig, syncJobsToGoogleSheet } from "./sheets.js";
import { addResumeSet, MAX_RESUME_UPLOAD_BYTES } from "./resume-library.js";
import { JobStatusSchema, JobStore, type JobRecord, type JobStatus } from "./store.js";
import { loadProfile } from "./workflow.js";

const host = "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT || "4317");
const store = new JobStore();
const automationConfig = loadAutomationConfig();
let automationState: AutomationState = await loadAutomationState();
let nextAutomationAt: string | null = null;
let activeAction: string | null = null;
let automationTimer: NodeJS.Timeout | undefined;

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: resolve("public/index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { path: resolve("public/app.js"), type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: resolve("public/styles.css"), type: "text/css; charset=utf-8" }
};

const dashboardStatuses = new Set<JobStatus>([
  "ready", "saved", "submitted", "not_interested", "job_closed", "application_blocked", "withdrawn"
]);

function securityHeaders(response: ServerResponse) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown) {
  securityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function mutationAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`) return true;
  return false;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function binaryBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maximumBytes) throw new Error("Résumé PDF exceeds the 10 MB upload limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("Résumé PDF exceeds the 10 MB upload limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function dashboardState() {
  const profile = await loadProfile();
  const jobs = await store.list();
  const counts = await store.counts();
  const scanSettings = await loadDailyScanSettings({ defaultLimit: automationConfig.defaultDailyScanLimit });
  const scannedToday = await store.scannedToday();
  const scored = jobs.filter((job) => job.analysis);
  let sourceCount = 0;
  try {
    const sources = JSON.parse(await readFile(resolve("sources.json"), "utf8")) as { sources?: unknown[] };
    sourceCount = sources.sources?.length || 0;
  } catch { /* surfaced as zero configured sources */ }
  return {
    resumeSets: profile.resumeSets.map((set) => ({ id: set.id, name: set.name, targetRoles: set.targetRoles })),
    applicationPolicy: { dailyTarget: profile.applicationPolicy.dailyTarget, acceptedMatchBands: profile.applicationPolicy.acceptedMatchBands },
    readiness: {
      apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
      sheetsConfigured: Boolean(loadSheetsConfig()),
      sourceCount,
      activeAction
    },
    automation: {
      enabled: automationConfig.enabled,
      intervalMinutes: automationConfig.intervalMinutes,
      discoveryLimit: automationConfig.discoveryLimit,
      scanLimit: automationConfig.scanLimit,
      minimumScore: automationConfig.minimumScore,
      nextRunAt: nextAutomationAt,
      ...automationState
    },
    dailyScanning: {
      activeLimit: scanSettings.activeDailyLimit,
      pendingLimit: scanSettings.pendingDailyLimit || null,
      pendingEffectiveDate: scanSettings.pendingEffectiveDate || null,
      scannedToday,
      remainingToday: Math.max(0, scanSettings.activeDailyLimit - scannedToday)
    },
    metrics: {
      counts,
      averageScore: scored.length ? Math.round(scored.reduce((sum, job) => sum + (job.analysis?.matchScore || 0), 0) / scored.length) : 0
    },
    jobs: [...jobs].sort((a, b) => {
      const priority = (job: JobRecord) => job.status === "ready" ? 0 : job.status === "saved" ? 1 : 2;
      return priority(a) - priority(b) || (b.analysis?.matchScore || 0) - (a.analysis?.matchScore || 0) || b.updatedAt.localeCompare(a.updatedAt);
    }).map((job) => ({
      id: job.id,
      url: job.url,
      source: job.source,
      status: job.status,
      previousStatus: job.previousStatus || null,
      statusChangedAt: job.statusChangedAt || null,
      statusNote: job.statusNote || null,
      title: job.analysis?.jobTitle || job.discoveredTitle || "Unscanned job",
      company: job.analysis?.company || job.discoveredCompany || new URL(job.url).hostname,
      location: job.discoveredLocation || "—",
      score: job.analysis?.matchScore ?? null,
      resumeSetId: job.selectedResumeSetId || null,
      updatedAt: job.updatedAt,
      submittedAt: job.submittedAt || null,
      lastError: job.lastError || null
    }))
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportCsv(response: ServerResponse) {
  const jobs = await store.list();
  const rows = [["Job ID", "Status", "Score", "Role", "Company", "Location", "Résumé Set", "Source", "URL", "Created", "Updated", "Applied", "Note"]];
  for (const job of jobs) rows.push([
    job.id, job.status, String(job.analysis?.matchScore ?? ""), job.analysis?.jobTitle || job.discoveredTitle || "",
    job.analysis?.company || job.discoveredCompany || "", job.discoveredLocation || "", job.selectedResumeSetId || "",
    job.source, job.url, job.createdAt, job.updatedAt, job.submittedAt || "", job.statusNote || ""
  ]);
  securityHeaders(response);
  response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=job-applications.csv" });
  response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
}

async function exclusive<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (activeAction) throw new Error(`Another action is already running: ${activeAction}`);
  activeAction = name;
  try { return await action(); }
  finally { activeAction = null; }
}

function armAutomation(delayMs = automationConfig.intervalMinutes * 60_000, trigger: "startup" | "schedule" = "schedule") {
  if (automationTimer) clearTimeout(automationTimer);
  if (!automationConfig.enabled || !process.env.GEMINI_API_KEY) {
    automationTimer = undefined;
    nextAutomationAt = null;
    return;
  }
  const safeDelay = Math.max(5_000, delayMs);
  nextAutomationAt = new Date(Date.now() + safeDelay).toISOString();
  automationTimer = setTimeout(async () => {
    await scheduledAutomation(trigger);
    armAutomation();
  }, safeDelay);
}

async function executeAutomation(trigger: AutomationResult["trigger"]): Promise<AutomationResult> {
  const startedAt = new Date().toISOString();
  automationState = { ...automationState, version: 1, running: true, lastStartedAt: startedAt, lastError: undefined };
  await saveAutomationState(automationState);
  try {
    const result = await runAutomationCycle(await loadProfile(), store, automationConfig, trigger);
    automationState = { version: 1, running: false, lastStartedAt: startedAt, lastCompletedAt: result.completedAt, lastResult: result };
    await saveAutomationState(automationState);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    automationState = { ...automationState, version: 1, running: false, lastStartedAt: startedAt, lastError: message.slice(0, 1_000) };
    await saveAutomationState(automationState);
    throw error;
  }
}

async function scheduledAutomation(trigger: "startup" | "schedule") {
  try {
    await exclusive("automatic discovery and ranking", () => executeAutomation(trigger));
  } catch (error) {
    console.error(`Automation cycle failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function updateJobStatus(jobId: string, status: JobStatus, note = ""): Promise<JobRecord> {
  if (!dashboardStatuses.has(status)) throw new Error("That dashboard status is not supported.");
  const current = await store.get(jobId);
  if (!current) throw new Error("Job not found.");
  const now = new Date().toISOString();
  const updated = await store.update(jobId, {
    status,
    previousStatus: current.status,
    statusChangedAt: now,
    statusNote: note.trim().slice(0, 1_000) || undefined,
    submittedAt: status === "submitted" ? now : current.submittedAt,
    lastError: status === "application_blocked" ? current.lastError : undefined
  });
  await audit({ action: "job-disposition", jobId, outcome: "success", details: { from: current.status, to: status } });
  return updated;
}

async function undoJobStatus(jobId: string): Promise<JobRecord> {
  const current = await store.get(jobId);
  if (!current) throw new Error("Job not found.");
  if (!current.previousStatus) throw new Error("There is no status change to undo.");
  const restored = current.previousStatus;
  const updated = await store.update(jobId, {
    status: restored,
    previousStatus: current.status,
    statusChangedAt: new Date().toISOString(),
    statusNote: undefined
  });
  await audit({ action: "job-disposition-undo", jobId, outcome: "success", details: { from: current.status, to: restored } });
  return updated;
}

async function migrateRetiredApplicationStates(): Promise<void> {
  const legacy = (await store.list()).filter((job) =>
    (job.status === "review" || job.status === "filling") && Boolean(job.analysis)
  );
  if (!legacy.length) return;
  const now = new Date().toISOString();
  for (const job of legacy) {
    await store.update(job.id, {
      status: "ready",
      statusChangedAt: now,
      statusNote: "Ready for manual review.",
      lastError: undefined
    });
  }
  await audit({ action: "retired-application-state-migration", outcome: "success", details: { restoredToReady: legacy.length } });
}

await migrateRetiredApplicationStates();

const server = createServer(async (request, response) => {
  try {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (method !== "GET" && !mutationAllowed(request)) return json(response, 403, { error: "Cross-origin request blocked." });

    if (method === "GET" && url.pathname === "/api/state") return json(response, 200, await dashboardState());
    if (method === "GET" && url.pathname === "/api/metrics") {
      const period = parseMetricsPeriod(url.searchParams.get("period"));
      if (!period) return json(response, 400, { error: "Choose a metrics period: week, month, or year." });
      return json(response, 200, await loadOutcomeMetrics(period, new Date(), undefined, undefined, await store.list()));
    }
    if (method === "GET" && url.pathname === "/api/export.csv") return await exportCsv(response);
    if (method === "POST" && url.pathname === "/api/resumes") {
      if (!/^application\/pdf(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
        return json(response, 415, { error: "Upload a PDF résumé." });
      }
      if (request.headers["x-resume-ai-consent"] !== "true") {
        return json(response, 400, { error: "Confirm that extracted résumé text may be sent to Gemini for indexing." });
      }
      try {
        const result = await exclusive("résumé upload and indexing", async () => {
          const added = await addResumeSet({
            bytes: await binaryBody(request, MAX_RESUME_UPLOAD_BYTES),
            name: url.searchParams.get("name") || ""
          });
          await audit({ action: "resume-set-added", outcome: "success", details: { resumeSetCount: added.resumeSetCount } });
          return added;
        });
        return json(response, 201, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const safeMessage = /^(Upload a valid PDF|Résumé PDF exceeds|Enter a name|GEMINI_API_KEY is missing)/.test(message)
          ? message
          : "Résumé indexing failed. Check that the PDF is readable and try again; existing résumé sets were not changed.";
        return json(response, 400, { error: safeMessage });
      }
    }
    if (method === "POST" && url.pathname === "/api/jobs") {
      const payload = await body(request);
      const result = await store.add(String(payload.url || ""), String(payload.source || "dashboard"));
      await audit({ action: "dashboard-add", jobId: result.job.id, outcome: "success", details: { created: result.created } });
      return json(response, result.created ? 201 : 200, { job: result.job, created: result.created });
    }
    if (method === "POST" && url.pathname === "/api/discover") {
      const result = await exclusive("discovery", async () => {
        const discovered = await discoverAndStore(await loadProfile(), store, { limit: automationConfig.discoveryLimit });
        await audit({ action: "dashboard-discovery", outcome: discovered.errors.length ? "failure" : "success", details: { added: discovered.added, duplicates: discovered.duplicates, errors: discovered.errors.length, searches: discovered.searches } });
        return discovered;
      });
      return json(response, 200, result);
    }
    if (method === "POST" && url.pathname === "/api/automation/run") {
      try {
        const result = await exclusive("automatic discovery and ranking", () => executeAutomation("manual"));
        return json(response, 200, result);
      } finally { armAutomation(); }
    }
    if (method === "POST" && url.pathname === "/api/scan") {
      const payload = await body(request);
      const limit = Math.min(100, Math.max(1, Number(payload.limit || 50)));
      const result = await exclusive("AI scan", async () => scanWithinDailyBudget(await loadProfile(), store, automationConfig, limit));
      return json(response, 200, result);
    }
    if (method === "POST" && url.pathname === "/api/settings/daily-scan-limit") {
      const payload = await body(request);
      const limit = Number(payload.limit);
      const settings = await scheduleDailyScanLimit(limit, { defaultLimit: automationConfig.defaultDailyScanLimit });
      await audit({ action: "daily-scan-limit-scheduled", outcome: "success", details: { limit, effectiveDate: settings.pendingEffectiveDate || "" } });
      return json(response, 200, { activeLimit: settings.activeDailyLimit, pendingLimit: settings.pendingDailyLimit, pendingEffectiveDate: settings.pendingEffectiveDate });
    }
    if (method === "POST" && url.pathname === "/api/sheets/sync") {
      const result = await exclusive("Google Sheets sync", async () => syncJobsToGoogleSheet(store));
      await audit({ action: "sheets-sync", outcome: "success", details: { rows: result.rows } });
      return json(response, 200, result);
    }

    const statusMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/status$/);
    if (method === "POST" && statusMatch) {
      const payload = await body(request);
      const status = JobStatusSchema.parse(payload.status);
      const job = await updateJobStatus(statusMatch[1]!, status, String(payload.note || ""));
      return json(response, 200, { job });
    }
    const undoMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/undo$/);
    if (method === "POST" && undoMatch) return json(response, 200, { job: await undoJobStatus(undoMatch[1]!) });

    const staticFile = method === "GET" ? staticFiles[url.pathname] : undefined;
    if (staticFile) {
      securityHeaders(response);
      response.writeHead(200, { "Content-Type": staticFile.type });
      response.end(await readFile(staticFile.path));
      return;
    }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(response, /already running/.test(message) ? 409 : 400, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Job Agent dashboard: http://${host}:${port}`);
  if (automationConfig.enabled && process.env.GEMINI_API_KEY) {
    const intervalMs = automationConfig.intervalMinutes * 60_000;
    const lastCompleted = automationState.lastCompletedAt ? new Date(automationState.lastCompletedAt).getTime() : 0;
    const remaining = lastCompleted ? Math.max(5_000, lastCompleted + intervalMs - Date.now()) : 5_000;
    armAutomation(remaining, lastCompleted ? "schedule" : "startup");
    console.log(`Screening autopilot enabled: runs every ${automationConfig.intervalMinutes} minutes.`);
  } else {
    console.log("Screening autopilot is disabled or waiting for GEMINI_API_KEY.");
  }
  console.log("Application submission is manual.");
  console.log("Press Ctrl+C to stop.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (automationTimer) clearTimeout(automationTimer);
    server.close(() => process.exit(0));
  });
}
