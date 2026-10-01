import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Profile } from "./types.js";

const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("greenhouse"), name: z.string(), boardToken: z.string(), titleIncludes: z.array(z.string()).default([]), locationIncludes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("lever"), name: z.string(), site: z.string(), titleIncludes: z.array(z.string()).default([]), locationIncludes: z.array(z.string()).default([]) })
]);
const SourcesSchema = z.object({ version: z.literal(1), sources: z.array(SourceSchema) });
export type DiscoverySource = z.infer<typeof SourceSchema>;

export type DiscoveredJob = {
  url: string;
  source: string;
  title: string;
  company: string;
  location: string;
  descriptionText: string;
};

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim().slice(0, 100_000);
}

const ROLE_STOPWORDS = new Set(["and", "the", "for", "senior", "lead", "associate", "principal"]);

export function potentialMatch(job: Pick<DiscoveredJob, "title" | "location">, profile: Profile, source: DiscoverySource): boolean {
  const configuredRoles = source.titleIncludes.length ? source.titleIncludes : profile.resumeSets.flatMap((set) => set.targetRoles);
  const roleTokens = new Set(configuredRoles.flatMap((role) => role.toLowerCase().split(/[^a-z0-9]+/)).filter((token) => token.length > 2 && !ROLE_STOPWORDS.has(token)));
  const titleTokens = job.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const roleMatch = titleTokens.some((token) => roleTokens.has(token));
  const configuredLocations = source.locationIncludes.length ? source.locationIncludes : (profile.preferences.preferredLocations as string[] | undefined) || [];
  const location = job.location.toLowerCase();
  const locationMatch = /remote|india|multiple locations/i.test(job.location) || !configuredLocations.length || configuredLocations.some((item) => location.includes(item.toLowerCase()));
  return roleMatch && locationMatch;
}

export function parseGreenhouse(payload: unknown, source: Extract<DiscoverySource, { type: "greenhouse" }>): DiscoveredJob[] {
  const data = z.object({ jobs: z.array(z.object({
    title: z.string(), absolute_url: z.string().url(), content: z.string().default(""),
    location: z.object({ name: z.string().default("") }).default({ name: "" })
  })) }).parse(payload);
  return data.jobs.map((job) => ({
    url: job.absolute_url, source: `greenhouse:${source.name}`, title: job.title,
    company: source.name, location: job.location.name, descriptionText: stripHtml(job.content)
  }));
}

export function parseLever(payload: unknown, source: Extract<DiscoverySource, { type: "lever" }>): DiscoveredJob[] {
  const data = z.array(z.object({
    text: z.string(), hostedUrl: z.string().url(), descriptionPlain: z.string().default(""), additionalPlain: z.string().default(""),
    categories: z.object({ location: z.string().default("") }).passthrough().default({ location: "" })
  })).parse(payload);
  return data.map((job) => ({
    url: job.hostedUrl, source: `lever:${source.name}`, title: job.text,
    company: source.name, location: job.categories.location,
    descriptionText: `${job.descriptionPlain}\n${job.additionalPlain}`.trim().slice(0, 100_000)
  }));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": "SupervisedJobAgent/0.1" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Discovery request failed (${response.status}) for ${url}`);
  return response.json();
}

export async function discoverJobs(profile: Profile, path = resolve("sources.json")): Promise<{ jobs: DiscoveredJob[]; errors: string[] }> {
  const config = SourcesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const jobs: DiscoveredJob[] = [];
  const errors: string[] = [];
  for (const source of config.sources) {
    try {
      const payload = source.type === "greenhouse"
        ? await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.boardToken)}/jobs?content=true`)
        : await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(source.site)}?mode=json`);
      const parsed = source.type === "greenhouse" ? parseGreenhouse(payload, source) : parseLever(payload, source);
      jobs.push(...parsed.filter((job) => potentialMatch(job, profile, source)));
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { jobs, errors };
}
