import { APPLICATION_DRAFT_JSON_SCHEMA, FILL_PLAN_JSON_SCHEMA, generateStructured, JOB_ANALYSIS_JSON_SCHEMA } from "./ai.js";
import { sensitiveCategory } from "./safety.js";
import { ApplicationDraftSchema, FillPlanSchema, JobAnalysisSchema, type FormField, type JobAnalysis, type Profile, type ResumeSet } from "./types.js";
import { resumeEvidence } from "./resume-evidence.js";

export function profileForMatching(profile: Profile) {
  return {
    workAuthorization: profile.workAuthorization,
    experience: profile.experience,
    education: profile.education,
    preferences: profile.preferences,
    applicationPolicy: profile.applicationPolicy,
    resumeSets: profile.resumeSets.map(({ id, name, targetRoles, skills, summary }) => ({ id, name, targetRoles, skills, summary }))
  };
}

export async function analyzeJob(profile: Profile, jobText: string) {
  const analysis = await generateStructured({
    systemInstruction: [
      "Evaluate a job against the candidate's verified profile and every available resume set.",
      "Choose exactly one supplied resume-set id. Score conservatively; do not infer missing qualifications.",
      "A blocker is a clear conflict such as location, work authorization, required clearance, or a mandatory qualification.",
      "Treat explicit candidate exclusions in applicationPolicy as blockers.",
      "Recommend skip when blockers exist or the role is materially outside all target roles."
    ].join(" "),
    input: { candidate: profileForMatching(profile), jobPosting: jobText },
    jsonSchema: JOB_ANALYSIS_JSON_SCHEMA,
    validator: JobAnalysisSchema
  });
  if (!profile.resumeSets.some((set) => set.id === analysis.selectedResumeSetId)) {
    throw new Error("Gemini selected an unknown resume set.");
  }
  return analysis;
}

export async function buildApplicationDraft(profile: Profile, resumeSet: ResumeSet, analysis: JobAnalysis, jobText: string) {
  const selectedResumeEvidence = await resumeEvidence(resumeSet);
  return generateStructured({
    systemInstruction: [
      "Prepare a truthful application package using only facts explicitly present in the candidate profile and selected resume evidence.",
      "Do not invent metrics, responsibilities, employers, credentials, dates, or motivations.",
      "Write naturally and specifically for the role, without generic AI phrasing. Keep the cover letter concise and do not include addresses or a date header.",
      "Do not claim that the text was written by the candidate if the form explicitly asks about authorship or AI assistance.",
      "Resume alignment notes are suggestions for the human; never claim the PDF was modified."
    ].join(" "),
    input: { candidate: profileForMatching(profile), selectedResumeSet: resumeSet, selectedResumeEvidence, analysis, jobPosting: jobText },
    jsonSchema: APPLICATION_DRAFT_JSON_SCHEMA,
    validator: ApplicationDraftSchema
  });
}

export async function buildPlan(profile: Profile, resumeSet: ResumeSet, fields: FormField[], jobText = "") {
  const eligible = fields.filter((field) => {
    const category = sensitiveCategory(field);
    return !category || Boolean(profile.voluntaryDisclosures[category]);
  });
  const selectedResumeEvidence = await resumeEvidence(resumeSet);
  return generateStructured({
    systemInstruction: [
      "Map a job application profile to browser form fields.",
      "Use only facts explicitly present in the profile. Never invent credentials, dates, employers, degrees, legal status, salary, or experience.",
      "For sensitive or demographic fields, use only an exact value in voluntaryDisclosures with the corresponding category; otherwise skip it.",
      "Skip ambiguous fields. Write short free-text answers in natural first-person language, tailored to the job, and grounded only in the supplied profile and resume evidence.",
      "Never answer salary, legal declarations, assessments, CAPTCHAs, identity verification, or requests for long essays.",
      "Set confidence below 0.9 unless the exact answer is directly supported. Name the specific profile or resume evidence in source.",
      "Return only eligible field indexes supplied by the user. For a file input, use the value RESUME when it is clearly a resume/CV upload."
    ].join(" "),
    input: { profile, selectedResumeSet: resumeSet, selectedResumeEvidence, jobPosting: jobText.slice(0, 30_000), fields: eligible },
    jsonSchema: FILL_PLAN_JSON_SCHEMA,
    validator: FillPlanSchema
  });
}
