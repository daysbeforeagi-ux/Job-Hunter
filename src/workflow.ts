import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { audit } from "./audit.js";
import { saveApplicationArtifacts } from "./artifacts.js";
import { applyPlan, collectFields, collectJobText, findSubmitButtons } from "./browser.js";
import { buildApplicationDraft, analyzeJob, buildPlan } from "./planner.js";
import { evaluateSuitability } from "./policy.js";
import { sensitiveCategory } from "./safety.js";
import { JobStore, type JobRecord } from "./store.js";
import { TrustedDomains } from "./trust.js";
import { ProfileSchema } from "./types.js";
import { readUploadedResumeSets, withUploadedResumeSets } from "./resume-library.js";

export type WorkflowOptions = { allowSubmit: boolean; minimumScore: number; profilePath?: string };

export async function loadProfile(path = resolve("profile.json")) {
  const profile = ProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return withUploadedResumeSets(profile, await readUploadedResumeSets());
}

export async function runJob(job: JobRecord, store: JobStore, options: WorkflowOptions): Promise<void> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing. Add it to .env before running a job.");
  const profile = await loadProfile(options.profilePath);
  const rl = createInterface({ input, output });
  const trusted = new TrustedDomains();
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const domain = new URL(job.url).hostname.toLowerCase();
    if (!await trusted.has(job.url)) {
      const confirmation = (await rl.question(`First visit to ${domain}. Type TRUST ${domain} to allow it: `)).trim();
      if (confirmation !== `TRUST ${domain}`) {
        await audit({ action: "trust-domain", jobId: job.id, outcome: "blocked", details: { domain } });
        return;
      }
      await trusted.add(job.url);
      await audit({ action: "trust-domain", jobId: job.id, outcome: "success", details: { domain } });
    }

    await store.update(job.id, { attempts: job.attempts + 1, lastError: undefined });
    browser = await chromium.launchPersistentContext(resolve(".job-agent-browser"), { headless: false });
    const page = browser.pages()[0] || await browser.newPage();
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let jobText = job.descriptionText || "";
    let analysis = job.analysis;
    if (!analysis) {
      await store.update(job.id, { status: "analyzing" });
      console.log("\nReview the job page in the browser.");
      await rl.question("Press Enter when the complete job description is visible... ");
      jobText = await collectJobText(page);
      analysis = await analyzeJob(profile, jobText);
    } else {
      console.log("\nUsing the pre-scanned job analysis. Verify that the browser still shows the same active role.");
    }
    const resumeSet = profile.resumeSets.find((set) => set.id === analysis.selectedResumeSetId);
    if (!resumeSet) throw new Error("Analysis selected an unknown resume set.");
    const suitability = evaluateSuitability(profile, analysis, options.minimumScore);
    await store.update(job.id, { analysis, selectedResumeSetId: resumeSet.id, status: suitability.allowed ? "ready" : "skipped" });

    console.log(`\n${analysis.jobTitle} at ${analysis.company}`);
    console.log(`Match: ${analysis.matchScore}/100 (${suitability.band}); résumé: ${resumeSet.name}`);
    console.log(`Rationale: ${analysis.rationale}`);
    if (analysis.matchedRequirements.length) console.log(`Matches: ${analysis.matchedRequirements.join("; ")}`);
    if (analysis.missingRequirements.length) console.log(`Gaps: ${analysis.missingRequirements.join("; ")}`);
    if (!suitability.allowed) {
      console.log(`Skipped: ${suitability.reasons.join("; ")}`);
      await audit({ action: "job-analysis", jobId: job.id, outcome: "blocked", details: { score: analysis.matchScore, reason: suitability.reasons.join("; ") } });
      return;
    }

    const approval = (await rl.question("Type APPLY to prepare this application: ")).trim();
    if (approval !== "APPLY") {
      await audit({ action: "job-approval", jobId: job.id, outcome: "cancelled" });
      return;
    }

    const draft = await buildApplicationDraft(profile, resumeSet, analysis, jobText);
    const artifactDirectory = await saveApplicationArtifacts(job.id, analysis, resumeSet, draft);
    await store.update(job.id, { artifactDirectory });
    console.log(`Application package saved to ${artifactDirectory}`);
    if (draft.warnings.length) console.log(`Warnings: ${draft.warnings.join("; ")}`);

    let readyToSubmit = false;
    for (let pageNumber = 1; pageNumber <= 20 && !readyToSubmit; pageNumber++) {
      console.log("Navigate to the next application form page in the browser.");
      await rl.question(`Press Enter when form page ${pageNumber} is ready... `);
      const fields = await collectFields(page);
      if (!fields.length) {
        console.log("No fillable fields found on this page.");
      } else {
        const blocked = fields.filter((field) => {
          const category = sensitiveCategory(field);
          return Boolean(category && !profile.voluntaryDisclosures[category]);
        });
        console.log(`Found ${fields.length} fields; ${blocked.length} unconfigured sensitive fields will remain blank.`);
        const plan = await buildPlan(profile, resumeSet, fields);
        console.table(plan.fields.map((item) => {
          const field = fields[item.index];
          const category = field ? sensitiveCategory(field) : null;
          return {
            field: field?.label || field?.name || item.index,
            value: category ? profile.voluntaryDisclosures[category] : item.value,
            confidence: item.confidence,
            source: item.source
          };
        }));
        const fill = (await rl.question("Type FILL to apply this page's draft, or press Enter to leave it untouched: ")).trim();
        if (fill === "FILL") {
          await store.update(job.id, { status: "filling" });
          const applied = await applyPlan(page, fields, plan, resumeSet, profile.voluntaryDisclosures);
          console.log(`Filled ${applied.length} fields. Review them in the browser.`);
          await audit({ action: "fill-form", jobId: job.id, outcome: "success", details: { page: pageNumber, fields: applied.length } });
        }
      }
      await store.update(job.id, { status: "review" });
      const next = (await rl.question("Type NEXT for another form page, SUBMIT for final review, or STOP to pause: ")).trim();
      if (next === "NEXT") continue;
      if (next === "SUBMIT") readyToSubmit = true;
      else {
        await audit({ action: "application-paused", jobId: job.id, outcome: "cancelled", details: { page: pageNumber } });
        return;
      }
    }

    if (!options.allowSubmit) {
      console.log("Submission is disabled for this run. The application remains in review status.");
      return;
    }
    const buttons = await findSubmitButtons(page);
    if (buttons.length !== 1) throw new Error(`Expected exactly one visible final-submit control, found ${buttons.length}. Submit manually if appropriate.`);
    const confirmation = (await rl.question("Type SUBMIT APPLICATION to click the final submit control: ")).trim();
    if (confirmation !== "SUBMIT APPLICATION") {
      await audit({ action: "submit", jobId: job.id, outcome: "cancelled" });
      return;
    }
    await buttons[0]!.click();
    await store.update(job.id, { status: "submission_pending" });
    await audit({ action: "submit-click", jobId: job.id, outcome: "success" });
    const confirmed = (await rl.question("After the website shows success, type CONFIRMED: ")).trim();
    if (confirmed === "CONFIRMED") {
      await store.update(job.id, { status: "submitted", submittedAt: new Date().toISOString() });
      await audit({ action: "submission-confirmed", jobId: job.id, outcome: "success" });
      console.log("Application recorded as submitted.");
    } else {
      console.log("Application remains pending confirmation; it was not counted as submitted.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await store.get(job.id);
    if (current && !["submitted", "skipped", "review", "submission_pending"].includes(current.status)) {
      await store.update(job.id, { status: "failed", lastError: message.slice(0, 500) });
    }
    await audit({ action: "workflow", jobId: job.id, outcome: "failure", details: { error: message.slice(0, 500) } });
    throw error;
  } finally {
    rl.close();
    await browser?.close();
  }
}
