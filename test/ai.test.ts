import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_DRAFT_JSON_SCHEMA, FILL_PLAN_JSON_SCHEMA, geminiReadiness, JOB_ANALYSIS_JSON_SCHEMA } from "../src/ai.js";

test("Gemini readiness is explicit and has a stable default model", () => {
  assert.deepEqual(geminiReadiness({}), { configured: false, model: "gemini-3.8-flash" });
  assert.deepEqual(geminiReadiness({ GEMINI_API_KEY: "test", GEMINI_MODEL: "gemini-custom" }), { configured: true, model: "gemini-custom" });
});

test("all Gemini structured-output contracts reject extra properties", () => {
  assert.equal(JOB_ANALYSIS_JSON_SCHEMA.additionalProperties, false);
  assert.equal(APPLICATION_DRAFT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(FILL_PLAN_JSON_SCHEMA.additionalProperties, false);
});
