import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit.js";
import { discoverAndStore, loadAutomationConfig, runAutomationCycle } from "./automation.js";
import { importJobFile } from "./importer.js";
import { scanQueuedJobs } from "./scanner.js";
import { JobStatusSchema, JobStore, type JobStatus } from "./store.js";
import { loadProfile, runJob } from "./workflow.js";

const rawArgs = process.argv.slice(2);
const command = rawArgs[0]?.startsWith("--") ? "run" : (rawArgs.shift() || "help");

function option(name: string): string | undefined {
  const index = rawArgs.indexOf(name);
  return index >= 0 ? rawArgs[index + 1] : undefined;
}

function flag(name: string): boolean {
  return rawArgs.includes(name);
}

function help() {
  console.log(`
Supervised Job Application Agent

Commands:
  doctor                              Validate local setup (does not call the API)
  add --url <https-url>               Add one job to the queue
  import --file <jobs.txt|csv|json>   Bulk-add job URLs with duplicate detection
  discover [--sources sources.json]   Find jobs automatically via Gemini Search and optional ATS feeds
  automate                            Discover, deduplicate, and AI-rank jobs in one cycle
  scan [--limit 50]                   AI-rank discovered jobs before opening a browser
  queue [--status queued]             List tracked jobs
  stats                               Show pipeline totals and today's progress
  run --url <https-url>               Add/evaluate/apply to one job
  run-next                            Process the oldest queued job
  mark --id <id> --status <status>    Correct a tracking status manually

Run options:
  --profile <path>                    Candidate profile (default: profile.json)
  --min-score <0-100>                 Minimum fit score (default: 65)
  --allow-submit                      Enable the separate final submission gate
`);
}

const store = new JobStore();

async function doctor() {
  const checks: Array<[string, boolean, string]> = [];
  try {
    const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
    checks.push(["Profile schema", true, `${profile.resumeSets.length} résumé sets`]);
    for (const set of profile.resumeSets) {
      try { await access(resolve(set.resumePath)); checks.push([`Résumé: ${set.name}`, true, set.resumePath]); }
      catch { checks.push([`Résumé: ${set.name}`, false, `missing ${set.resumePath}`]); }
    }
  } catch (error) {
    checks.push(["Profile schema", false, error instanceof Error ? error.message : String(error)]);
  }
  checks.push(["Gemini API key", Boolean(process.env.GEMINI_API_KEY), process.env.GEMINI_API_KEY ? "configured" : "not configured yet"]);
  checks.push(["Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version]);
  console.table(checks.map(([check, ok, detail]) => ({ check, result: ok ? "PASS" : "PENDING", detail })));
  const hardFailures = checks.filter(([name, ok]) => !ok && name !== "Gemini API key");
  if (hardFailures.length) process.exitCode = 1;
}

async function addUrl(url: string, source = "manual") {
  const result = await store.add(url, source);
  console.log(result.created ? `Added ${result.job.id}` : `Duplicate skipped; existing id ${result.job.id}`);
  await audit({ action: "queue-add", jobId: result.job.id, outcome: "success", details: { created: result.created, source } });
  return result.job;
}

async function importJobs(path: string) {
  const rows = await importJobFile(resolve(path));
  let added = 0;
  let duplicates = 0;
  let invalid = 0;
  for (const row of rows) {
    try {
      const result = await store.add(row.url, row.source);
      result.created ? added++ : duplicates++;
    } catch (error) {
      invalid++;
      console.warn(`Skipped ${row.url || "blank URL"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Import complete: ${added} added, ${duplicates} duplicates, ${invalid} invalid.`);
  await audit({ action: "queue-import", outcome: "success", details: { added, duplicates, invalid } });
}

async function discover() {
  const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
  const path = resolve(option("--sources") || "sources.json");
  const result = await discoverAndStore(profile, store, { limit: loadAutomationConfig().discoveryLimit, sourcesPath: path });
  console.log(`Discovery complete: ${result.added} added, ${result.duplicates} duplicates, ${result.searches} web searches, ${result.errors.length} errors.`);
  for (const error of result.errors) console.warn(error);
  await audit({ action: "discovery", outcome: result.errors.length ? "failure" : "success", details: { added: result.added, duplicates: result.duplicates, searches: result.searches, sourceErrors: result.errors.length } });
}

async function showQueue(status?: JobStatus) {
  const jobs = await store.list(status);
  console.table(jobs.map((job) => ({
    id: job.id,
    status: job.status,
    score: job.analysis?.matchScore ?? "",
    role: job.analysis?.jobTitle || "",
    company: job.analysis?.company || "",
    source: job.source,
    url: job.url
  })));
  if (!jobs.length) console.log("No matching jobs.");
}

async function stats() {
  const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
  const counts = await store.counts();
  const today = await store.submittedToday();
  console.table(Object.entries(counts).map(([status, count]) => ({ status, count })));
  console.log(`Today's confirmed submissions: ${today}/${profile.applicationPolicy.dailyTarget}`);
}

async function processJob(jobId?: string) {
  const job = jobId ? await store.get(jobId) : await store.next();
  if (!job) throw new Error(jobId ? `Unknown job id: ${jobId}` : "The queue has no pending jobs.");
  if (["submitted", "withdrawn"].includes(job.status)) throw new Error(`Job ${job.id} is already ${job.status}; refusing to run it again.`);
  if (job.status === "submission_pending") throw new Error(`Job ${job.id} may already have been submitted. Verify it and use the mark command instead of risking a duplicate.`);
  const minimumScore = Number(option("--min-score") || "65");
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) throw new Error("--min-score must be between 0 and 100.");
  const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
  const submitted = await store.submittedToday();
  if (submitted >= profile.applicationPolicy.dailyTarget) {
    console.log(`Daily target of ${profile.applicationPolicy.dailyTarget} is already met; continuing only with your interactive approvals.`);
  }
  await runJob(job, store, {
    allowSubmit: flag("--allow-submit"), minimumScore,
    profilePath: option("--profile") ? resolve(option("--profile")!) : undefined
  });
}

try {
  switch (command) {
    case "help": case "--help": case "-h": help(); break;
    case "doctor": await doctor(); break;
    case "add": {
      const url = option("--url");
      if (!url) throw new Error("add requires --url.");
      await addUrl(url, option("--source") || "manual");
      break;
    }
    case "import": {
      const file = option("--file");
      if (!file) throw new Error("import requires --file.");
      await importJobs(file);
      break;
    }
    case "discover": await discover(); break;
    case "automate": {
      const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
      const result = await runAutomationCycle(profile, store, loadAutomationConfig(), "cli");
      console.log(`Automation complete: ${result.added} added, ${result.ready} ready, ${result.skipped} skipped, ${result.failed} failed.`);
      break;
    }
    case "scan": {
      const profile = await loadProfile(option("--profile") ? resolve(option("--profile")!) : undefined);
      const limit = Number(option("--limit") || "50");
      const minimumScore = Number(option("--min-score") || "65");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500.");
      if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) throw new Error("--min-score must be between 0 and 100.");
      const result = await scanQueuedJobs(profile, store, limit, minimumScore);
      console.log(`Scan complete: ${result.scanned} scanned, ${result.ready} ready, ${result.skipped} skipped, ${result.failed} failed.`);
      break;
    }
    case "queue": {
      const rawStatus = option("--status");
      await showQueue(rawStatus ? JobStatusSchema.parse(rawStatus) : undefined);
      break;
    }
    case "stats": await stats(); break;
    case "run": {
      const url = option("--url");
      const id = option("--id");
      if (!url && !id) throw new Error("run requires --url or --id.");
      const job = url ? await addUrl(url, option("--source") || "manual") : await store.get(id!);
      if (!job) throw new Error(`Unknown job id: ${id}`);
      await processJob(job.id);
      break;
    }
    case "run-next": await processJob(); break;
    case "mark": {
      const id = option("--id");
      const status = option("--status");
      if (!id || !status) throw new Error("mark requires --id and --status.");
      const validated = JobStatusSchema.parse(status);
      const patch = validated === "submitted" ? { status: validated, submittedAt: new Date().toISOString() } : { status: validated };
      await store.update(id, patch);
      await audit({ action: "manual-status", jobId: id, outcome: "success", details: { status: validated } });
      console.log(`${id} marked ${validated}.`);
      break;
    }
    default: throw new Error(`Unknown command: ${command}. Run 'npm start -- help'.`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
