import assert from "node:assert/strict";
import test from "node:test";
import { isSensitive, looksLikeSubmit, sensitiveCategory } from "../src/safety.js";

const field = (label: string) => ({ index: 0, tag: "input", type: "text", name: "", label, required: false, options: [] });

test("blocks protected and highly sensitive fields", () => {
  for (const label of ["Gender", "Race / ethnicity", "Veteran status", "Disability", "SSN"]) {
    assert.equal(isSensitive(field(label)), true, label);
  }
  assert.equal(isSensitive(field("Portfolio URL")), false);
  assert.equal(sensitiveCategory(field("Date of birth")), "dateOfBirth");
  assert.equal(sensitiveCategory(field("Gender")), "gender");
});

test("recognizes final submission controls", () => {
  assert.equal(looksLikeSubmit("Submit application"), true);
  assert.equal(looksLikeSubmit("Save and continue"), false);
});
