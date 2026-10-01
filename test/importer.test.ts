import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importJobFile } from "../src/importer.js";

test("imports text, CSV, and JSON job lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-import-"));
  try {
    const text = join(directory, "jobs.txt");
    const csv = join(directory, "jobs.csv");
    const json = join(directory, "jobs.json");
    await writeFile(text, "# jobs\nhttps://one.example/job\n");
    await writeFile(csv, 'url,source\n"https://two.example/job?a=1,b=2",newsletter\n');
    await writeFile(json, JSON.stringify(["https://three.example/job", { url: "https://four.example/job", source: "referral" }]));
    assert.deepEqual(await importJobFile(text), [{ url: "https://one.example/job", source: "text-import" }]);
    assert.equal((await importJobFile(csv))[0]?.source, "newsletter");
    assert.equal((await importJobFile(json)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
