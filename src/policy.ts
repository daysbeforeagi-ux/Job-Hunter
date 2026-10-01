import type { JobAnalysis, Profile } from "./types.js";

export type MatchBand = "top" | "medium" | "low";

export function matchBand(score: number): MatchBand {
  if (score >= 80) return "top";
  if (score >= 65) return "medium";
  return "low";
}

export function evaluateSuitability(profile: Profile, analysis: JobAnalysis, minimumScore = 65) {
  const band = matchBand(analysis.matchScore);
  const reasons: string[] = [];
  if (analysis.matchScore < minimumScore) reasons.push(`score ${analysis.matchScore} is below minimum ${minimumScore}`);
  if (!profile.applicationPolicy.acceptedMatchBands.includes(band)) reasons.push(`${band} match band is not enabled`);
  if (analysis.recommendation === "skip") reasons.push("analysis recommends skipping");
  if (analysis.blockers.length) reasons.push(`blockers: ${analysis.blockers.join("; ")}`);
  return { allowed: reasons.length === 0, band, reasons };
}
