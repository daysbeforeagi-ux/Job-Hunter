import { audit } from "./audit.js";
import { analyzeJob } from "./planner.js";
import { evaluateSuitability } from "./policy.js";
import type { JobStore } from "./store.js";
import type { Profile } from "./types.js";

export async function scanQueuedJobs(profile: Profile, store: JobStore, limit = 50, minimumScore = 65) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing. Add it to .env before scanning jobs.");
  const candidates = (await store.list("queued")).filter((job) => Boolean(job.descriptionText)).slice(0, limit);
  let ready = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of candidates) {
    try {
      await store.update(job.id, { status: "analyzing", attempts: job.attempts + 1, lastScannedAt: new Date().toISOString(), lastError: undefined });
      const analysis = await analyzeJob(profile, job.descriptionText!);
      const suitability = evaluateSuitability(profile, analysis, minimumScore);
      await store.update(job.id, {
        status: suitability.allowed ? "ready" : "skipped",
        analysis,
        selectedResumeSetId: analysis.selectedResumeSetId
      });
      suitability.allowed ? ready++ : skipped++;
      await audit({ action: "queue-scan", jobId: job.id, outcome: suitability.allowed ? "success" : "blocked", details: { score: analysis.matchScore, band: suitability.band } });
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await store.update(job.id, { status: "failed", lastError: message.slice(0, 500) });
      await audit({ action: "queue-scan", jobId: job.id, outcome: "failure", details: { error: message.slice(0, 500) } });
    }
  }
  return { scanned: candidates.length, ready, skipped, failed };
}
