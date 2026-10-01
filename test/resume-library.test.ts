import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addResumeSet, readUploadedResumeSets, ResumeIndexSchema, withUploadedResumeSets } from "../src/resume-library.js";
import { ProfileSchema } from "../src/types.js";

const profile = ProfileSchema.parse({
  identity: { firstName: "A", lastName: "B", email: "a@example.com", phone: "1", city: "Delhi", country: "India" },
  links: {}, workAuthorization: { authorizedCountries: ["India"], requiresSponsorship: false },
  experience: { currentTitle: "Consultant", years: 5, skills: ["Strategy"], summary: "Verified" },
  education: [], preferences: {}, applicationPolicy: { dailyTarget: 30, acceptedMatchBands: ["top", "medium"] },
  voluntaryDisclosures: {},
  resumeSets: [{ id: "original", name: "Original", targetRoles: ["Consultant"], skills: [], summary: "Existing profile", resumePath: "Resumes/original.pdf", coverLetterPath: "" }]
});

test("validates bounded resume matching metadata", () => {
  assert.equal(ResumeIndexSchema.parse({
    targetRoles: ["Strategy Consultant"], skills: ["Research"], summary: "Experienced consultant with strategy delivery and research experience."
  }).targetRoles[0], "Strategy Consultant");
  assert.throws(() => ResumeIndexSchema.parse({ targetRoles: [], skills: [], summary: "Too short" }));
});

test("adds a private PDF and appends its indexed set without exposing resume text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-resume-"));
  try {
    const profilePath = join(directory, "profile.json");
    const resumesDirectory = join(directory, "Resumes");
    const resumeSetPath = join(directory, "data", "resume-sets.json");
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
    const bytes = Buffer.from("%PDF-1.7 synthetic pdf bytes");
    const result = await addResumeSet({
      bytes,
      name: "Product Strategy",
      profilePath,
      resumesDirectory,
      resumeSetPath,
      extractText: async () => "synthetic private resume text",
      indexText: async () => ({
        targetRoles: ["Strategy Consultant"],
        skills: ["Research", "Roadmapping"],
        summary: "Consultant with evidenced strategy, research, and product roadmapping experience."
      })
    });

    const stored = ProfileSchema.parse(JSON.parse(await readFile(profilePath, "utf8")));
    const uploadedSets = await readUploadedResumeSets(resumeSetPath);
    assert.equal(result.resumeSetCount, 2);
    assert.equal(stored.resumeSets.length, 1);
    assert.equal(uploadedSets[0]?.id, result.resumeSet.id);
    assert.deepEqual(uploadedSets[0]?.targetRoles, ["Strategy Consultant"]);
    assert.match(uploadedSets[0]!.resumePath, /^Resumes\/resume-[a-f0-9-]+\.pdf$/);
    const merged = withUploadedResumeSets(stored, uploadedSets);
    assert.equal(merged.resumeSets.length, 2);
    assert.equal(merged.resumeSets[1]?.id, result.resumeSet.id);
    const savedPdf = await readFile(join(directory, uploadedSets[0]!.resumePath));
    assert.deepEqual(savedPdf, bytes);
    assert.equal((await stat(join(directory, uploadedSets[0]!.resumePath))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("synthetic private resume text"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-PDF uploads before extraction or persistence", async () => {
  let extracted = false;
  await assert.rejects(addResumeSet({
    bytes: Buffer.from("not a PDF"),
    name: "Invalid",
    profilePath: "/missing/profile.json",
    extractText: async () => { extracted = true; return "text"; },
    indexText: async () => ({ targetRoles: ["Role"], skills: [], summary: "This would otherwise be enough metadata." })
  }), /valid PDF résumé/);
  assert.equal(extracted, false);
});

test("does not persist a PDF or set when résumé indexing fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-resume-failure-"));
  try {
    const profilePath = join(directory, "profile.json");
    const resumesDirectory = join(directory, "Resumes");
    const resumeSetPath = join(directory, "data", "resume-sets.json");
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
    await assert.rejects(addResumeSet({
      bytes: Buffer.from("%PDF-1.7 synthetic pdf bytes"),
      name: "Unavailable index",
      profilePath,
      resumesDirectory,
      resumeSetPath,
      extractText: async () => "synthetic resume text",
      indexText: async () => { throw new Error("indexing unavailable"); }
    }), /indexing unavailable/);
    assert.deepEqual(ProfileSchema.parse(JSON.parse(await readFile(profilePath, "utf8"))), profile);
    await assert.rejects(stat(resumesDirectory), { code: "ENOENT" });
    await assert.rejects(readFile(resumeSetPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});