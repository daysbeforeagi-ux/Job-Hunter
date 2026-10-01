import type { Locator, Page } from "playwright";
import { resolve } from "node:path";
import { looksLikeNext, looksLikeSubmit, sensitiveCategory } from "./safety.js";
import type { FillPlan, FormField, ResumeSet } from "./types.js";

const FIELD_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=password]), textarea, select";

export async function collectFields(page: Page): Promise<FormField[]> {
  return page.locator(FIELD_SELECTOR).evaluateAll((els) =>
    els.filter((raw) => {
      const element = raw as HTMLElement;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !element.hasAttribute("disabled");
    }).map((raw, index) => {
      const el = raw as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      el.setAttribute("data-job-agent-field", String(index));
      const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
      const wrapped = el.closest("label")?.textContent;
      const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      const options = el instanceof HTMLSelectElement
        ? Array.from(el.options).map((option) => option.text.trim()).filter(Boolean)
        : [];
      return {
        index, tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
        name: el.getAttribute("name") || el.id || "", label: (explicit || wrapped || aria || "").trim(),
        required: el.required || el.getAttribute("aria-required") === "true", options,
        value: el.value || "", checked: "checked" in el ? Boolean((el as HTMLInputElement).checked) : undefined
      };
    })
  );
}

function fieldAt(page: Page, index: number): Locator {
  const stable = page.locator(`[data-job-agent-field="${index}"]`);
  return stable.or(page.locator(FIELD_SELECTOR).nth(index)).first();
}

export async function applyPlan(page: Page, fields: FormField[], plan: FillPlan, resumeSet: ResumeSet, voluntaryDisclosures: Record<string, string>) {
  const applied: Array<{ label: string; value: string }> = [];
  for (const item of plan.fields) {
    const field = fields[item.index];
    if (!field || item.confidence < 0.75) continue;
    const sensitive = sensitiveCategory(field);
    if (sensitive && !voluntaryDisclosures[sensitive]) continue;
    const value = sensitive ? voluntaryDisclosures[sensitive]! : item.value;
    const locator = fieldAt(page, item.index);
    try {
      if (field.type === "file") {
        if (/resume|cv/i.test(`${field.label} ${field.name}`)) await locator.setInputFiles(resolve(resumeSet.resumePath));
        else if (/cover/i.test(`${field.label} ${field.name}`) && resumeSet.coverLetterPath) await locator.setInputFiles(resolve(resumeSet.coverLetterPath));
        else continue;
      } else if (field.tag === "select") {
        await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      } else if (field.type === "checkbox") {
        if (/^(true|yes|checked)$/i.test(value)) await locator.check();
      } else if (field.type === "radio") {
        const fieldValue = field.value || await locator.getAttribute("value") || "";
        if (value.localeCompare(fieldValue, undefined, { sensitivity: "accent" }) === 0 ||
            value.localeCompare(field.label, undefined, { sensitivity: "accent" }) === 0 ||
            (/^(true|yes|checked)$/i.test(value) && /^(true|yes|1|on)$/i.test(fieldValue))) {
          await locator.check();
        }
      } else {
        await locator.fill(value);
      }
      applied.push({ label: field.label || field.name || `Field ${item.index}`, value });
    } catch (error) {
      console.warn(`Skipped ${field.label || field.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return applied;
}

export async function collectJobText(page: Page): Promise<string> {
  const text = await page.locator("body").innerText();
  return text.replace(/\n{3,}/g, "\n\n").slice(0, 30_000);
}

export async function findSubmitButtons(page: Page): Promise<Locator[]> {
  const candidates = page.getByRole("button").or(page.locator("input[type=submit], a[role=button]"));
  const matches: Locator[] = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const candidate = candidates.nth(i);
    const text = (await candidate.innerText().catch(() => "")) || (await candidate.getAttribute("value")) || "";
    if (looksLikeSubmit(text) && await candidate.isVisible()) matches.push(candidate);
  }
  return matches;
}

export async function findNextButtons(page: Page): Promise<Locator[]> {
  const candidates = page.getByRole("button").or(page.locator("input[type=button], a[role=button]"));
  const matches: Locator[] = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const candidate = candidates.nth(i);
    const text = (await candidate.innerText().catch(() => "")) || (await candidate.getAttribute("value")) || "";
    if (looksLikeNext(text) && await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
  }
  return matches;
}

export async function findApplyEntrypoints(page: Page): Promise<Locator[]> {
  const candidates = page.getByRole("button").or(page.getByRole("link"));
  const matches: Locator[] = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const candidate = candidates.nth(i);
    const text = (await candidate.innerText().catch(() => "")).trim();
    if (/^(?:easy )?apply(?: now)?$|^start application$/i.test(text) && await candidate.isVisible() && await candidate.isEnabled()) {
      matches.push(candidate);
    }
  }
  return matches;
}

export async function unresolvedRequiredFields(page: Page): Promise<string[]> {
  return page.locator(FIELD_SELECTOR).evaluateAll((els) => els.flatMap((raw) => {
    const el = raw as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0 || el.disabled) return [];
    const required = el.required || el.getAttribute("aria-required") === "true";
    if (!required) return [];
    const complete = el.type === "radio"
      ? Boolean(el.name && document.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`))
      : el.type === "checkbox"
        ? (el as HTMLInputElement).checked
        : Boolean(el.value.trim());
    if (complete) return [];
    const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
    const label = (explicit || el.closest("label")?.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "Required field").trim();
    return [label.slice(0, 160)];
  }));
}

export async function submissionLooksSuccessful(page: Page): Promise<boolean> {
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 20_000);
  return /application (?:has been )?submitted|thanks? for applying|thank you for (?:your )?application|application received|we(?:'ve| have) received your application/i.test(text);
}
