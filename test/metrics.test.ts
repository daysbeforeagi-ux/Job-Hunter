import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOutcomeMetrics, parseMetricsPeriod } from "../src/metrics.js";

test("counts timestamped outcomes in calendar periods and excludes undone marks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-metrics-"));
  try {
    const path = join(directory, "audit.jsonl");
    const now = new Date("2026-09-30T12:00:00.000Z");
    const records = [
      { timestamp: "2026-09-26T12:00:00.000Z", action: "job-disposition", jobId: "a", outcome: "success", details: { from: "ready", to: "submitted" } },
      { timestamp: "2026-09-28T19:00:00.000Z", action: "job-disposition", jobId: "b", outcome: "success", details: { from: "ready", to: "job_closed" } },
      { timestamp: "2026-09-29T12:00:00.000Z", action: "job-disposition", jobId: "c", outcome: "success", details: { from: "ready", to: "application_blocked" } },
      { timestamp: "2026-09-29T13:00:00.000Z", action: "queue-scan", jobId: "e", outcome: "success", details: { score: 88 } },
      { timestamp: "2026-09-29T14:00:00.000Z", action: "queue-scan", jobId: "f", outcome: "blocked", details: { score: 42 } },
      { timestamp: "2026-09-29T15:00:00.000Z", action: "queue-scan", jobId: "g", outcome: "failure", details: { error: "synthetic" } },
      { timestamp: "2026-09-29T12:00:00.000Z", action: "job-disposition-undo", jobId: "a", outcome: "success", details: { from: "submitted", to: "ready" } },
      { timestamp: "2026-09-01T12:00:00.000Z", action: "manual-status", jobId: "d", outcome: "success", details: { status: "submitted" } }
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));

    const metrics = await loadOutcomeMetrics("week", now, path, "Asia/Kolkata", [
      { createdAt: "2026-09-29T08:00:00.000Z" },
      { createdAt: "2026-09-26T08:00:00.000Z" }
    ]);
    assert.equal(metrics.total, 5);
    assert.equal(metrics.added, 1);
    assert.equal(metrics.counts.submitted, 0);
    assert.equal(metrics.counts.job_closed, 1);
    assert.equal(metrics.counts.application_blocked, 1);
    assert.equal(metrics.counts.ready, 1);
    assert.equal(metrics.counts.skipped, 1);
    assert.equal(metrics.counts.failed, 1);
    assert.equal(metrics.from, "2026-09-27T18:30:00.000Z");
    const monthly = await loadOutcomeMetrics("month", now, path, "Asia/Kolkata");
    const yearly = await loadOutcomeMetrics("year", now, path, "Asia/Kolkata");
    assert.equal(monthly.from, "2026-08-31T18:30:00.000Z");
    assert.equal(yearly.from, "2025-12-31T18:30:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates dashboard metrics period names", () => {
  assert.equal(parseMetricsPeriod("week"), "week");
  assert.equal(parseMetricsPeriod("month"), "month");
  assert.equal(parseMetricsPeriod("year"), "year");
  assert.equal(parseMetricsPeriod("today"), undefined);
});