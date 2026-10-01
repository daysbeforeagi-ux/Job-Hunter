import assert from "node:assert/strict";
import test from "node:test";
import { parseGreenhouse, parseLever, potentialMatch, type DiscoverySource } from "../src/discovery.js";
import { ProfileSchema } from "../src/types.js";

const profile = ProfileSchema.parse({
  identity: { firstName: "A", lastName: "B", email: "a@example.com", phone: "1", city: "Delhi", country: "India" },
  links: {}, workAuthorization: { authorizedCountries: ["India"], requiresSponsorship: false },
  experience: { currentTitle: "Consultant", years: 5, skills: [], summary: "Verified" },
  education: [], preferences: { preferredLocations: ["Delhi", "Mumbai"] },
  applicationPolicy: { dailyTarget: 30, acceptedMatchBands: ["top", "medium"] }, voluntaryDisclosures: {},
  resumeSets: [{ id: "strategy", name: "Strategy", targetRoles: ["Strategy Consultant"], skills: [], summary: "Strategy", resumePath: "resume.pdf", coverLetterPath: "" }]
});

const greenhouse: DiscoverySource = { type: "greenhouse", name: "Example", boardToken: "example", titleIncludes: [], locationIncludes: [] };
const lever: DiscoverySource = { type: "lever", name: "Example", site: "example", titleIncludes: [], locationIncludes: [] };

test("parses supported public ATS payloads", () => {
  const greenJobs = parseGreenhouse({ jobs: [{ title: "Strategy Consultant", absolute_url: "https://example.com/1", content: "<p>Transformation &amp; AI</p>", location: { name: "Delhi" } }] }, greenhouse as Extract<DiscoverySource, { type: "greenhouse" }>);
  const leverJobs = parseLever([{ text: "Strategy Manager", hostedUrl: "https://example.com/2", descriptionPlain: "Role", additionalPlain: "More", categories: { location: "Mumbai" } }], lever as Extract<DiscoverySource, { type: "lever" }>);
  assert.equal(greenJobs[0]?.descriptionText, "Transformation & AI");
  assert.equal(leverJobs[0]?.descriptionText, "Role\nMore");
  assert.equal(potentialMatch(greenJobs[0]!, profile, greenhouse), true);
  assert.equal(potentialMatch({ title: "Software Engineer", location: "London" }, profile, greenhouse), false);
});
