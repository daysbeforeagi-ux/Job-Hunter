import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApplicationDraft, JobAnalysis, ResumeSet } from "./types.js";

export async function saveApplicationArtifacts(jobId: string, analysis: JobAnalysis, resumeSet: ResumeSet, draft: ApplicationDraft) {
  const directory = resolve("artifacts", jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "cover-letter.md"), `${draft.coverLetter.trim()}\n`, { mode: 0o600 });
  await writeFile(resolve(directory, "application-summary.json"), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    analysis,
    resumeSet: { id: resumeSet.id, name: resumeSet.name, resumePath: resumeSet.resumePath },
    resumeAlignmentNotes: draft.resumeAlignmentNotes,
    likelyScreeningQuestions: draft.likelyScreeningQuestions,
    warnings: draft.warnings
  }, null, 2)}\n`, { mode: 0o600 });
  return directory;
}
