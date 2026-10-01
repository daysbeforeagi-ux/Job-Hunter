import { createSign } from "node:crypto";
import type { JobRecord, JobStore } from "./store.js";
import { matchBand } from "./policy.js";

export type SheetsConfig = {
  spreadsheetId: string;
  serviceAccountEmail: string;
  privateKey: string;
  tabName: string;
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function loadSheetsConfig(env = process.env): SheetsConfig | null {
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!spreadsheetId || !serviceAccountEmail || !privateKey) return null;
  return { spreadsheetId, serviceAccountEmail, privateKey, tabName: env.GOOGLE_SHEET_TAB || "Applications" };
}

async function accessToken(config: SheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: config.serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Google authorization failed (${response.status}).`);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google authorization did not return an access token.");
  return body.access_token;
}

export function jobsToSheetValues(jobs: JobRecord[]): Array<Array<string | number>> {
  const header = [
    "Job ID", "Status", "Score", "Match Band", "Role", "Company", "Location",
    "Résumé Set", "Source", "URL", "Created", "Updated", "Submitted", "Last Error"
  ];
  const rows = [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((job) => [
    job.id,
    job.status,
    job.analysis?.matchScore ?? "",
    job.analysis ? matchBand(job.analysis.matchScore) : "",
    job.analysis?.jobTitle || job.discoveredTitle || "",
    job.analysis?.company || job.discoveredCompany || "",
    job.discoveredLocation || "",
    job.selectedResumeSetId || "",
    job.source,
    job.url,
    job.createdAt,
    job.updatedAt,
    job.submittedAt || "",
    job.lastError || ""
  ]);
  return [header, ...rows];
}

async function googleRequest(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Google Sheets request failed (${response.status}): ${detail}`);
  }
  return response;
}

async function ensureTab(config: SheetsConfig, token: string): Promise<void> {
  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}?fields=sheets.properties.title`;
  const metadata = await (await googleRequest(metadataUrl, token)).json() as { sheets?: Array<{ properties?: { title?: string } }> };
  if (metadata.sheets?.some((sheet) => sheet.properties?.title === config.tabName)) return;
  await googleRequest(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: config.tabName, frozenRowCount: 1 } } }] })
  });
}

export async function syncJobsToGoogleSheet(store: JobStore, config = loadSheetsConfig()) {
  if (!config) throw new Error("Google Sheets is not configured. Set GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in .env.");
  const token = await accessToken(config);
  await ensureTab(config, token);
  const range = encodeURIComponent(`'${config.tabName.replace(/'/g, "''")}'!A:N`);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${range}`;
  await googleRequest(`${base}:clear`, token, { method: "POST", body: "{}" });
  const values = jobsToSheetValues(await store.list());
  await googleRequest(`${base}?valueInputOption=RAW`, token, {
    method: "PUT",
    body: JSON.stringify({ range: `${config.tabName}!A1`, majorDimension: "ROWS", values })
  });
  return { rows: Math.max(0, values.length - 1), url: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit` };
}
