import type { FormField } from "./types.js";

const SENSITIVE: Array<[string, RegExp]> = [
  ["gender", /gender|\bsex\b/i],
  ["sexualOrientation", /sexual orientation|sexuality/i],
  ["raceEthnicity", /race|ethni|national origin/i],
  ["religion", /relig/i],
  ["disabilityStatus", /disab/i],
  ["veteranStatus", /veteran/i],
  ["maritalStatus", /marital/i],
  ["pregnancyStatus", /pregnan/i],
  ["dateOfBirth", /date of birth|birth date|dob|\bage\b/i],
  ["geneticInformation", /genetic/i],
  ["pronouns", /pronoun/i],
  ["governmentId", /social security|\bssn\b|aadhaar|passport number/i]
];

const SUBMIT = [/submit/i, /send application/i, /apply now/i, /complete application/i];
const NEXT = [/^next$/i, /^continue$/i, /^review(?: application)?$/i, /^save (?:and|&) continue$/i];
const CAPTCHA = /captcha|verify (?:that )?you(?:'re| are) human|i am not a robot|security challenge/i;
const ASSESSMENT = /assessment|coding challenge|video interview|record (?:a )?video|personality test|aptitude test/i;
const LEGAL = /certify|under penalty|legally binding|terms and conditions|privacy (?:policy|notice)|electronic signature|background check|arbitration/i;
const SALARY = /salary|compensation|expected (?:ctc|pay)|current ctc|desired pay/i;
const LONG_ANSWER = /essay|in detail|at least \d+ words|minimum \d+ words|writing sample/i;

export function isSensitive(field: FormField): boolean {
  return sensitiveCategory(field) !== null;
}

export function sensitiveCategory(field: FormField): string | null {
  const text = `${field.label} ${field.name}`;
  return SENSITIVE.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

export function looksLikeSubmit(text: string): boolean {
  return SUBMIT.some((pattern) => pattern.test(text));
}

export function looksLikeNext(text: string): boolean {
  return NEXT.some((pattern) => pattern.test(text.trim()));
}

export function pageBlocker(text: string): "captcha" | "assessment" | null {
  if (CAPTCHA.test(text)) return "captcha";
  if (ASSESSMENT.test(text)) return "assessment";
  return null;
}

export function isLegalDeclaration(field: FormField): boolean {
  return LEGAL.test(`${field.label} ${field.name}`);
}

export function isSalaryField(field: FormField): boolean {
  return SALARY.test(`${field.label} ${field.name}`);
}

export function isLongEssay(field: FormField): boolean {
  return LONG_ANSWER.test(`${field.label} ${field.name}`);
}
