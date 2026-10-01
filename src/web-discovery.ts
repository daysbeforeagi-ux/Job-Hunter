import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { DiscoveredJob } from "./discovery.js";
import type { Profile } from "./types.js";

const WebJobSchema = z.object({
  title: z.string().trim().min(2).max(200),
  company: z.string().trim().min(1).max(160),
  location: z.string().trim().max(160).default("India"),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "Job URL must use HTTPS."),
  summary: z.string().trim().max(8_000).default(""),
  postedDate: z.string().trim().max(80).optional()
});

const WebDiscoverySchema = z.object({ jobs: z.array(WebJobSchema).max(5) });
type WebJob = z.infer<typeof WebJobSchema>;

export type WebSearchPlan = {
  roles: string[];
  preferredLocations: string[];
  country: string;
};

type SearchExecutor = (prompt: string) => Promise<string>;

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function buildWebSearchPlans(profile: Profile, limit = 40): WebSearchPlan[] {
  const count = Math.max(1, Math.min(12, Math.ceil(limit / 5)));
  const preferred = Array.isArray(profile.preferences.preferredLocations)
    ? profile.preferences.preferredLocations.filter((value): value is string => typeof value === "string")
    : [];
  const locationGroups = chunks(preferred, 3);
  if (!locationGroups.length) locationGroups.push([profile.identity.city]);

  const roleGroups = profile.resumeSets.flatMap((set) => chunks([...new Set(set.targetRoles)], 2));
  const fallbackRoles = roleGroups.length ? roleGroups : [[profile.experience.currentTitle]];
  const plans: WebSearchPlan[] = [];
  for (let index = 0; plans.length < count; index++) {
    plans.push({
      roles: fallbackRoles[index % fallbackRoles.length]!,
      preferredLocations: locationGroups[index % locationGroups.length]!,
      country: profile.identity.country
    });
  }
  return plans;
}

export function buildWebSearchPrompt(plan: WebSearchPlan, now = new Date()): string {
  return [
    "Use no more than ONE Google Search call.",
    `Today is ${now.toISOString().slice(0, 10)}. Find up to 5 currently open job postings for these roles: ${plan.roles.join(" or ")}.`,
    `Search in ${plan.country}, prioritizing ${plan.preferredLocations.join(", ")}. Remote roles open to candidates in ${plan.country} are also acceptable.`,
    "Search LinkedIn Jobs (site:linkedin.com/jobs/view) and Naukri (site:naukri.com/job-listings) explicitly, alongside employer career pages and ATS postings. Include relevant portal-hosted listings rather than preferring employer pages exclusively.",
    "Return direct links to individual job postings, not search-result pages or generic company pages. Exclude internships, expired postings, and staffing spam.",
    "Return ONLY compact JSON using this exact shape:",
    '{"jobs":[{"title":"...","company":"...","location":"...","url":"https://...","summary":"2-5 sentences describing responsibilities and requirements","postedDate":"date if visible"}]}',
    "Every URL must identify one specific job. A Google grounding redirect URL is acceptable. If nothing reliable is found, return {\"jobs\":[]}. Do not perform a second search."
  ].join("\n");
}

function extractJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("Gemini web search returned no JSON object.");
  }
}

export function parseWebSearchOutput(text: string): WebJob[] {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !Object.hasOwn(parsed, "jobs")) {
    return Object.keys(parsed).length ? [WebJobSchema.parse(parsed)] : [];
  }
  return WebDiscoverySchema.parse(parsed).jobs;
}

function description(job: WebJob): string {
  return [
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || "India"}`,
    job.postedDate ? `Posting date: ${job.postedDate}` : "",
    job.summary
  ].filter(Boolean).join("\n").slice(0, 100_000);
}

function identity(job: Pick<WebJob, "title" | "company" | "location">): string {
  return [job.title, job.company, job.location].map(compact).join("|");
}

function safeRedirectTarget(value: string, base: string): string {
  const target = new URL(value, base);
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:") throw new Error("Grounding redirect attempted to leave HTTPS.");
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "127.0.0.1" || hostname === "::1") {
    throw new Error("Grounding redirect attempted to use a local address.");
  }
  return target.toString();
}

async function resolveGroundingUrl(raw: string): Promise<string> {
  let current = raw;
  if (new URL(current).hostname !== "vertexaisearch.cloud.google.com") return current;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": "SupervisedJobAgent/0.1" },
        signal: AbortSignal.timeout(15_000)
      });
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400) return current;
      current = safeRedirectTarget(location, current);
      if (new URL(current).hostname !== "vertexaisearch.cloud.google.com") return current;
    }
  } catch {
    // The signed grounding link remains usable if the destination blocks automated resolution.
  }
  return raw;
}

async function defaultSearchExecutor(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Add it to .env before automatic web discovery.");
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 60_000, retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 8 } }
  });
  const interaction = await client.interactions.create({
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    input: prompt,
    tools: [{ type: "google_search" }],
    store: false
  });
  if (!interaction.output_text) throw new Error("Gemini web search returned no text output.");
  return interaction.output_text;
}

export async function discoverJobsWithGemini(profile: Profile, options: {
  limit?: number;
  executor?: SearchExecutor;
  delayMs?: number;
} = {}): Promise<{ jobs: DiscoveredJob[]; errors: string[]; searches: number }> {
  const limit = Math.max(1, Math.min(60, options.limit ?? 40));
  const plans = buildWebSearchPlans(profile, limit);
  const executor = options.executor || defaultSearchExecutor;
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const jobs: DiscoveredJob[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let searches = 0;

  for (const plan of plans) {
    if (jobs.length >= limit) break;
    try {
      searches++;
      const found = parseWebSearchOutput(await executor(buildWebSearchPrompt(plan)));
      for (const job of found) {
        const key = identity(job);
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({
          url: await resolveGroundingUrl(job.url),
          source: "gemini-google-search",
          title: job.title,
          company: job.company,
          location: job.location || profile.identity.country,
          descriptionText: description(job)
        });
        if (jobs.length >= limit) break;
      }
    } catch (error) {
      errors.push(`${plan.roles.join(" / ")}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (delayMs && jobs.length < limit) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { jobs, errors, searches };
}
