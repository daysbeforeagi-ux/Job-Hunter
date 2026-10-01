import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const TrustSchema = z.object({ version: z.literal(1), domains: z.array(z.string()) });

export class TrustedDomains {
  constructor(readonly path = resolve("data/trusted-domains.json")) {}

  async list(): Promise<string[]> {
    try {
      return TrustSchema.parse(JSON.parse(await readFile(this.path, "utf8"))).domains;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async has(url: string): Promise<boolean> {
    return (await this.list()).includes(new URL(url).hostname.toLowerCase());
  }

  async add(url: string): Promise<string> {
    const domain = new URL(url).hostname.toLowerCase();
    const domains = [...new Set([...(await this.list()), domain])].sort();
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, domains }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return domain;
  }
}
