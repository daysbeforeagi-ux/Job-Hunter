import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AuditEvent = {
  action: string;
  jobId?: string;
  outcome: "success" | "blocked" | "cancelled" | "failure";
  details?: Record<string, string | number | boolean | null>;
};

export async function audit(event: AuditEvent, path = resolve("data/audit.jsonl")): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const safe = { timestamp: new Date().toISOString(), ...event };
  await appendFile(path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}
