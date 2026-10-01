import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDailyScanSettings, localDateInZone, nextLocalDate, scheduleDailyScanLimit } from "../src/settings.js";

test("schedules daily scan changes for the next India calendar day", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-settings-"));
  const path = join(directory, "settings.json");
  try {
    const now = new Date("2026-09-28T18:45:00.000Z");
    assert.equal(localDateInZone(now, "Asia/Kolkata"), "2026-09-29");
    assert.equal(nextLocalDate(now, "Asia/Kolkata"), "2026-09-30");

    const scheduled = await scheduleDailyScanLimit(35, { path, defaultLimit: 20, now, timeZone: "Asia/Kolkata" });
    assert.equal(scheduled.activeDailyLimit, 20);
    assert.equal(scheduled.pendingDailyLimit, 35);
    assert.equal(scheduled.pendingEffectiveDate, "2026-09-30");

    const nextDay = await loadDailyScanSettings({ path, defaultLimit: 20, now: new Date("2026-09-30T00:00:00.000Z"), timeZone: "Asia/Kolkata" });
    assert.equal(nextDay.activeDailyLimit, 35);
    assert.equal(nextDay.pendingDailyLimit, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels a pending change when the active daily limit is selected again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-settings-cancel-"));
  const path = join(directory, "settings.json");
  try {
    const now = new Date("2026-09-28T18:45:00.000Z");
    await scheduleDailyScanLimit(35, { path, defaultLimit: 20, now, timeZone: "Asia/Kolkata" });
    const restored = await scheduleDailyScanLimit(20, { path, defaultLimit: 20, now, timeZone: "Asia/Kolkata" });
    assert.equal(restored.activeDailyLimit, 20);
    assert.equal(restored.pendingDailyLimit, undefined);
    assert.equal(restored.pendingEffectiveDate, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
