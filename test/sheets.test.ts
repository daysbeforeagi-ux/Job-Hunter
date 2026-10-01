import assert from "node:assert/strict";
import test from "node:test";
import { jobsToSheetValues, loadSheetsConfig } from "../src/sheets.js";
import { JobRecordSchema } from "../src/store.js";

test("detects incomplete Sheets configuration without exposing secrets", () => {
  assert.equal(loadSheetsConfig({}), null);
  assert.equal(loadSheetsConfig({ GOOGLE_SHEET_ID: "id", GOOGLE_SERVICE_ACCOUNT_EMAIL: "a@example.com" }), null);
});

test("creates stable application-tracker rows", () => {
  const job = JobRecordSchema.parse({
    id: "abc", url: "https://example.com/job", canonicalUrl: "https://example.com/job", source: "test",
    status: "ready", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", attempts: 1,
    discoveredTitle: "Strategy Consultant", discoveredCompany: "Example", discoveredLocation: "Delhi",
    analysis: { jobTitle: "Strategy Consultant", company: "Example", selectedResumeSetId: "strategy_ai", matchScore: 85, recommendation: "strong_match", matchedRequirements: [], missingRequirements: [], blockers: [], rationale: "Strong" },
    selectedResumeSetId: "strategy_ai"
  });
  const values = jobsToSheetValues([job]);
  assert.equal(values[0]?.length, 14);
  assert.equal(values[1]?.[3], "top");
  assert.equal(values[1]?.[4], "Strategy Consultant");
});
