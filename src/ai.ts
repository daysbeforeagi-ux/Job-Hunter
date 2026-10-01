import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";

export const JOB_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    jobTitle: { type: "string" },
    company: { type: "string" },
    selectedResumeSetId: { type: "string" },
    matchScore: { type: "integer", minimum: 0, maximum: 100 },
    recommendation: { type: "string", enum: ["strong_match", "possible_match", "skip"] },
    matchedRequirements: { type: "array", items: { type: "string" } },
    missingRequirements: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    rationale: { type: "string" }
  },
  required: ["jobTitle", "company", "selectedResumeSetId", "matchScore", "recommendation", "matchedRequirements", "missingRequirements", "blockers", "rationale"],
  additionalProperties: false
} as const;

export const APPLICATION_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    coverLetter: { type: "string" },
    resumeAlignmentNotes: { type: "array", items: { type: "string" } },
    likelyScreeningQuestions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["coverLetter", "resumeAlignmentNotes", "likelyScreeningQuestions", "warnings"],
  additionalProperties: false
} as const;

export const FILL_PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: { type: "string" },
          reason: { type: "string" }
        },
        required: ["index", "value", "confidence", "source", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["fields"],
  additionalProperties: false
} as const;

export function geminiReadiness(env = process.env) {
  return {
    configured: Boolean(env.GEMINI_API_KEY),
    model: env.GEMINI_MODEL || "gemini-3.8-flash"
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export async function generateStructured<T>(args: {
  systemInstruction: string;
  input: unknown;
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
}): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Add it to .env before using AI features.");
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 60_000, retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 8 } }
  });
  const interaction = await client.interactions.create({
    model,
    input: JSON.stringify(args.input),
    system_instruction: args.systemInstruction,
    response_format: { type: "text", mime_type: "application/json", schema: args.jsonSchema },
    store: false
  });
  if (!interaction.output_text) throw new Error("Gemini returned no structured text output.");
  try {
    return args.validator.parse(parseJson(interaction.output_text));
  } catch (error) {
    throw new Error(`Gemini returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
