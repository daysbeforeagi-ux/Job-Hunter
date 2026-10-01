import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type ImportedJob = { url: string; source: string };

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim());
  return values;
}

export async function importJobFile(path: string): Promise<ImportedJob[]> {
  const content = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (extension === ".json") {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("JSON import must be an array.");
    return parsed.map((item) => typeof item === "string"
      ? { url: item, source: "json-import" }
      : { url: String((item as { url?: unknown }).url || ""), source: String((item as { source?: unknown }).source || "json-import") }
    );
  }
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (extension === ".csv") {
    const rows = lines.map(parseCsvLine);
    const header = rows[0]?.map((cell) => cell.toLowerCase()) || [];
    const urlIndex = header.indexOf("url");
    const sourceIndex = header.indexOf("source");
    if (urlIndex < 0) throw new Error("CSV import requires a 'url' column.");
    return rows.slice(1).map((row) => ({ url: row[urlIndex] || "", source: row[sourceIndex] || "csv-import" }));
  }
  return lines.filter((line) => !line.startsWith("#")).map((url) => ({ url, source: "text-import" }));
}
