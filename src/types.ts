import { z } from "zod";

export const ResumeSetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  targetRoles: z.array(z.string()).min(1),
  skills: z.array(z.string()).default([]),
  summary: z.string().min(1),
  resumePath: z.string().min(1),
  coverLetterPath: z.string().default("")
});

export const ProfileSchema = z.object({
  identity: z.object({
    firstName: z.string(), lastName: z.string(), email: z.string().email(),
    phone: z.string(), city: z.string(), country: z.string()
  }),
  links: z.record(z.string()).default({}),
  workAuthorization: z.object({
    authorizedCountries: z.array(z.string()).default([]),
    requiresSponsorship: z.boolean().nullable()
  }),
  experience: z.object({
    currentTitle: z.string(), years: z.number().nonnegative(),
    skills: z.array(z.string()), summary: z.string()
  }),
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    graduationYear: z.number().int(),
    grade: z.string().default("")
  })).default([]),
  preferences: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  applicationPolicy: z.object({
    dailyTarget: z.number().int().positive(),
    acceptedMatchBands: z.array(z.enum(["top", "medium", "low"])),
    excludedIndustries: z.array(z.string()).default([]),
    excludedCompanies: z.array(z.string()).default([]),
    excludedEmploymentTypes: z.array(z.string()).default([])
  }),
  voluntaryDisclosures: z.record(z.string()).default({}),
  resumeSets: z.array(ResumeSetSchema).min(1)
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ResumeSet = z.infer<typeof ResumeSetSchema>;

export type FormField = {
  index: number;
  tag: string;
  type: string;
  name: string;
  label: string;
  required: boolean;
  options: string[];
  value?: string;
  checked?: boolean;
};

export const FillPlanSchema = z.object({
  fields: z.array(z.object({
    index: z.number().int().nonnegative(),
    value: z.string(),
    confidence: z.number().min(0).max(1),
    source: z.string(),
    reason: z.string()
  }))
});

export type FillPlan = z.infer<typeof FillPlanSchema>;

export const JobAnalysisSchema = z.object({
  jobTitle: z.string(),
  company: z.string(),
  selectedResumeSetId: z.string(),
  matchScore: z.number().int().min(0).max(100),
  recommendation: z.enum(["strong_match", "possible_match", "skip"]),
  matchedRequirements: z.array(z.string()),
  missingRequirements: z.array(z.string()),
  blockers: z.array(z.string()),
  rationale: z.string()
});

export type JobAnalysis = z.infer<typeof JobAnalysisSchema>;

export const ApplicationDraftSchema = z.object({
  coverLetter: z.string(),
  resumeAlignmentNotes: z.array(z.string()),
  likelyScreeningQuestions: z.array(z.string()),
  warnings: z.array(z.string())
});

export type ApplicationDraft = z.infer<typeof ApplicationDraftSchema>;
