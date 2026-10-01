import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeJobUrl, JobStore } from "../src/store.js";

test("canonicalizes tracking URLs without removing job identifiers", () => {
  assert.equal(
    canonicalizeJobUrl("https://example.com/jobs/123/?utm_source=email&candidate=abc#apply"),
    "https://example.com/jobs/123?candidate=abc"
  );
  assert.throws(() => canonicalizeJobUrl("http://example.com/job"), /HTTPS/);
});

test("stores jobs atomically and rejects duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-store-"));
  try {
    const path = join(directory, "jobs.json");
    const store = new JobStore(path);
    const first = await store.add("https://example.com/jobs/123?utm_source=a", "test");
    const duplicate = await store.add("https://example.com/jobs/123?utm_source=b", "test");
    const groundedDuplicate = await store.add("https://redirect.example.net/token", "search", {
      discoveredTitle: "Strategy Consultant", discoveredCompany: "Example", discoveredLocation: "Delhi"
    });
    const alternateGroundingUrl = await store.add("https://redirect.example.net/other-token", "search", {
      discoveredTitle: "Strategy Consultant", discoveredCompany: "Example", discoveredLocation: "Delhi"
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(groundedDuplicate.created, true);
    assert.equal(alternateGroundingUrl.created, false);
    assert.equal((await store.list()).length, 2);
    await store.update(first.job.id, { lastScannedAt: new Date().toISOString() });
    assert.equal(await store.scannedToday(), 1);
    await store.update(first.job.id, { status: "submitted", submittedAt: new Date().toISOString() });
    assert.equal(await store.submittedToday(), 1);
    await store.update(first.job.id, { status: "saved", previousStatus: "submitted", statusNote: "Review later" });
    assert.equal((await store.get(first.job.id))?.status, "saved");
    assert.equal((await store.counts()).saved, 1);
    assert.doesNotReject(async () => JSON.parse(await readFile(path, "utf8")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
