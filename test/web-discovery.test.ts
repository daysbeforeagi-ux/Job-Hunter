import assert from "node:assert/strict";
import test from "node:test";
import { buildWebSearchPlans, buildWebSearchPrompt, discoverJobsWithGemini, parseWebSearchOutput } from "../src/web-discovery.js";
import { ProfileSchema } from "../src/types.js";

const profile = ProfileSchema.parse({
  identity: { firstName: "A", lastName: "B", email: "a@example.com", phone: "1", city: "Delhi", country: "India" },
  links: {}, workAuthorization: { authorizedCountries: ["India"], requiresSponsorship: false },
  experience: { currentTitle: "Consultant", years: 5, skills: ["Strategy"], summary: "Verified" },
  education: [], preferences: { preferredLocations: ["Delhi", "Noida", "Mumbai", "Bengaluru"] },
  applicationPolicy: { dailyTarget: 30, acceptedMatchBands: ["top", "medium"] }, voluntaryDisclosures: {},
  resumeSets: [
    { id: "strategy", name: "Strategy", targetRoles: ["Strategy Consultant", "AI Consultant", "Transformation Manager"], skills: [], summary: "Strategy", resumePath: "resume.pdf", coverLetterPath: "" },
    { id: "public", name: "Public", targetRoles: ["Public Sector Consultant", "Program Manager"], skills: [], summary: "Public", resumePath: "resume2.pdf", coverLetterPath: "" }
  ]
});

test("builds bounded search plans from résumé roles and preferred locations", () => {
  const plans = buildWebSearchPlans(profile, 40);
  assert.equal(plans.length, 8);
  assert.ok(plans.every((plan) => plan.roles.length <= 2));
  assert.ok(plans.some((plan) => plan.roles.includes("Public Sector Consultant")));
  assert.ok(plans.some((plan) => plan.preferredLocations.includes("Bengaluru")));
});

test("targets LinkedIn and Naukri while requiring direct job links", () => {
  const prompt = buildWebSearchPrompt({ roles: ["Strategy Consultant"], preferredLocations: ["Delhi"], country: "India" });
  assert.match(prompt, /site:linkedin\.com\/jobs\/view/);
  assert.match(prompt, /site:naukri\.com\/job-listings/);
  assert.match(prompt, /direct links to individual job postings/i);
});

test("parses fenced JSON and accepts empty results", () => {
  assert.equal(parseWebSearchOutput('{"jobs":[]}').length, 0);
  const jobs = parseWebSearchOutput('```json\n{"jobs":[{"title":"Strategy Consultant","company":"Example","location":"Delhi","url":"https://example.com/jobs/1","summary":"Transformation role"}]}\n```');
  assert.equal(jobs[0]?.company, "Example");
  assert.throws(() => parseWebSearchOutput('{"jobs":[{"title":"Role","company":"Example","location":"Delhi","url":"http://example.com/1","summary":"x"}]}'), /HTTPS/);
});

test("deduplicates grounded results across searches", async () => {
  const result = await discoverJobsWithGemini(profile, {
    limit: 10,
    delayMs: 0,
    executor: async () => JSON.stringify({ jobs: [{
      title: "Strategy Consultant", company: "Example", location: "Delhi",
      url: "https://example.com/jobs/1", summary: "A current strategy and transformation role."
    }] })
  });
  assert.equal(result.searches, 2);
  assert.equal(result.jobs.length, 1);
  assert.match(result.jobs[0]!.descriptionText, /Strategy Consultant/);
});
