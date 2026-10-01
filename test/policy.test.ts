import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSuitability, matchBand } from "../src/policy.js";
import { ProfileSchema, type JobAnalysis } from "../src/types.js";

const profile = ProfileSchema.parse({
  identity: { firstName: "A", lastName: "B", email: "a@example.com", phone: "1", city: "X", country: "India" },
  links: {}, workAuthorization: { authorizedCountries: ["India"], requiresSponsorship: false },
  experience: { currentTitle: "Consultant", years: 5, skills: [], summary: "Verified summary" },
  education: [], preferences: {},
  applicationPolicy: { dailyTarget: 30, acceptedMatchBands: ["top", "medium"] },
  voluntaryDisclosures: {},
  resumeSets: [{ id: "one", name: "One", targetRoles: ["Consultant"], skills: [], summary: "Set", resumePath: "resume.pdf", coverLetterPath: "" }]
});

const analysis = (score: number, blockers: string[] = []): JobAnalysis => ({
  jobTitle: "Consultant", company: "Company", selectedResumeSetId: "one", matchScore: score,
  recommendation: blockers.length ? "skip" : "possible_match", matchedRequirements: [], missingRequirements: [], blockers, rationale: "Test"
});

test("uses stable match bands and blocks hard conflicts", () => {
  assert.equal(matchBand(80), "top");
  assert.equal(matchBand(65), "medium");
  assert.equal(matchBand(64), "low");
  assert.equal(evaluateSuitability(profile, analysis(75)).allowed, true);
  assert.equal(evaluateSuitability(profile, analysis(90, ["Requires clearance"])).allowed, false);
});
