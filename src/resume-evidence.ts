import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ResumeSet } from "./types.js";

const cache = new Map<string, string>();

export async function extractResumeText(bytes: Uint8Array): Promise<string> {
  const document = await getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false }).promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
    }
    const text = pages.join("\n").replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 40_000);
    if (!text) throw new Error("No extractable text found in resume PDF.");
    return text;
  } finally {
    await document.destroy();
  }
}

export async function resumeEvidence(resumeSet: ResumeSet): Promise<string> {
  const path = resolve(resumeSet.resumePath);
  const existing = cache.get(path);
  if (existing !== undefined) return existing;
  try {
    const bytes = new Uint8Array(await readFile(path));
    const evidence = await extractResumeText(bytes);
    cache.set(path, evidence);
    return evidence;
  } catch {
    const fallback = `${resumeSet.summary}\nSkills: ${resumeSet.skills.join(", ")}\nTarget roles: ${resumeSet.targetRoles.join(", ")}`;
    cache.set(path, fallback);
    return fallback;
  }
}
