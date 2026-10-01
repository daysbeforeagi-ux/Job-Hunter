import assert from "node:assert/strict";
import test from "node:test";
import { loadAutomationConfig, selectDiscoveryBatch } from "../src/automation.js";

function job(index: number, source: string) {
  return {
    url: `https://example.com/jobs/${index}`,
    source,
    title: `Role ${index}`,
    company: `Company ${index}`,
    location: "Remote",
    descriptionText: `Description ${index}`
  };
}

test("uses defaults consistent with manual 30-job screening", () => {
  assert.deepEqual(loadAutomationConfig({}), {
    enabled: false,
    intervalMinutes: 360,
    discoveryLimit: 60,
    scanLimit: 30,
    minimumScore: 65,
    defaultDailyScanLimit: 30
  });
});

test("loads safe bounded automation settings", () => {
  const config = loadAutomationConfig({
    AUTOMATION_ENABLED: "yes",
    AUTOMATION_INTERVAL_MINUTES: "2",
    AUTO_DISCOVERY_LIMIT: "500",
    AUTO_SCAN_LIMIT: "0",
    AUTO_MINIMUM_SCORE: "72"
  });
  assert.deepEqual(config, {
    enabled: true,
    intervalMinutes: 30,
    discoveryLimit: 60,
    scanLimit: 1,
    minimumScore: 72,
    defaultDailyScanLimit: 30
  });
});

test("caps combined web and ATS results fairly and skips duplicate roles", () => {
  const web = Array.from({ length: 8 }, (_, index) => job(index, "web"));
  const ats = [job(0, "ats-duplicate"), ...Array.from({ length: 8 }, (_, index) => job(index + 10, "ats"))];
  const selected = selectDiscoveryBatch(web, ats, 5);
  assert.equal(selected.length, 5);
  assert.equal(selected.filter((item) => item.source === "web").length, 3);
  assert.equal(selected.filter((item) => item.source === "ats").length, 2);
  assert.equal(new Set(selected.map((item) => item.url)).size, selected.length);
  assert.equal(selectDiscoveryBatch(web, ats, 0).length, 0);
});
