import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { applyPlan, collectFields } from "../src/browser.js";

test("fills verified fields and blocks unconfigured sensitive fields", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label>First name <input name="firstName"></label>
      <label>Gender <select name="gender"><option></option><option>Male</option><option>Female</option></select></label>
      <label>Date of birth <input type="date" name="dob"></label>
      <label>Race or ethnicity <input name="race"></label>
      <button>Submit application</button>
    `);
    const fields = await collectFields(page);
    await applyPlan(page, fields, {
      fields: fields.map((field) => ({
        index: field.index,
        value: field.name === "firstName" ? "Ujjwal" : "MODEL_VALUE_MUST_NOT_OVERRIDE_VERIFIED_DATA",
        confidence: 1,
        source: "test",
        reason: "test"
      }))
    }, {
      id: "test", name: "Test", targetRoles: ["Test"], skills: [], summary: "Test", resumePath: "unused.pdf", coverLetterPath: ""
    }, {
      gender: "Male",
      dateOfBirth: "1995-11-11"
    });

    assert.equal(await page.locator('[name="firstName"]').inputValue(), "Ujjwal");
    assert.equal(await page.locator('[name="gender"]').inputValue(), "Male");
    assert.equal(await page.locator('[name="dob"]').inputValue(), "1995-11-11");
    assert.equal(await page.locator('[name="race"]').inputValue(), "");
  } finally {
    await browser.close();
  }
});
