/**
 * Number check (admin-only): after an answer that used tools, every number in it should appear in what the tools
 * returned, the knowledge-base passages, the question or the chat so far. Numbers that don't are listed for the
 * admin under the answer ("Not found in any source: 63%"). The answer itself is never changed, and users never see it.
 *
 * Numbers are compared by value: "46%" = "46 percent", "4.5 million" = "4.5M" = "4,500,000", "$1,200" = "1200 USD",
 * and a rounder figure counts ("4.5 million" for 4,512,000, "46%" for 46.2%). Not checked: years, dates, times,
 * list numbers, page references, ordinals ("21st"), small whole numbers (under 10) and anything in code or links.
 * Version numbers like 3.15.2 must appear exactly.
 *
 * Simple calculations count too (v0.9.9): a figure that is the difference, sum, percentage change or share of two
 * other figures **stated in the same answer and found in the sources** ("207.7 million to 241.5 million, up 33.8
 * million, about 16%"). Only pairs the answer itself states are tried, so a made-up number can't pass by chance.
 */
import type { ToolEventDto } from "../../shared/types";

export const ANSWER_CHECK = "answer_check";

const SCALE: Record<string, number> = {
  k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, mn: 1e6, million: 1e6, B: 1e9, bn: 1e9, billion: 1e9, T: 1e12, tn: 1e12, trillion: 1e12,
  lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7,
};
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const CURRENCY = String.raw`(?:US\$|\$|€|£|¥|₹|Rs\.?|PKR|USD|EUR|GBP|INR)\s?`;
// Single letters scale only in capitals (4.5M, 200K) or "k": a lone "m" is usually metres.
const UNIT = String.raw`(?:\s?(%|[Pp]er ?cent\b|[Tt]housand\b|[Mm]illion\b|[Bb]illion\b|[Tt]rillion\b|[Ll]akhs?\b|[Cc]rores?\b|mn\b|bn\b|tn\b|[KMBT]\b|k\b))?`;
const NUMBER = new RegExp(String.raw`(?<![\w.])(${CURRENCY})?(\d{1,3}(?:,\d{3})+|\d+)(?!\d)(\.\d+)?(?!\d)(?!\.\d)(?!(?:st|nd|rd|th)\b)${UNIT}`, "g");
const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:\.\d+)?)(?![\w.]*\d)/g;

interface Figure {
  text: string;
  value: number;
  decimals: number;
  /** Significant digits as written, for scaled figures ("4.5 million" → 2). */
  significant: number;
  scaled: boolean;
  plain: boolean; // no unit, currency or decimals
}

function figures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const [whole, currency, int, fraction, unit] = m;
    const digits = int!.replace(/,/g, "");
    const scale = unit ? (SCALE[unit] ?? (/^(%|per ?cent)$/i.test(unit) ? 1 : SCALE[unit.toLowerCase()] ?? 1)) : 1;
    const base = Number(digits + (fraction ?? ""));
    out.push({
      text: whole.trim(),
      value: base * scale,
      decimals: fraction ? fraction.length - 1 : 0,
      significant: (digits.replace(/^0+/, "") + (fraction ?? "").slice(1)).replace(/^0+/, "").length || 1,
      scaled: scale !== 1,
      plain: !currency && !unit && !fraction && !int!.includes(","),
    });
  }
  return out;
}

/** The answer without the parts whose numbers aren't claims: code, links, citations, dates, times, list markers. */
function claimText(answer: string): string {
  return answer
    .replace(/[    ]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:pages?|pp?\.)\s*\d+(?:\s*(?:,|and|&|–|-|to)\s*\d+)*/gi, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, " ")
    .replace(new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS})\b\.?(?:,?\s+\d{4})?`, "gi"), " ")
    .replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?`, "gi"), " ")
    .replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{4}\b`, "gi"), " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi, " ")
    .replace(/^\s*\d+[.)]\s/gm, " ");
}

const isYear = (f: Figure) => f.plain && f.value >= 1900 && f.value <= 2100;
const isSmallCount = (f: Figure) => f.plain && f.value < 10;
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function roundTo(value: number, significant: number): number {
  if (value === 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(Math.abs(value))) - significant + 1);
  return Math.round(value / step) * step;
}

/** The evidence has this figure, or a more precise one that rounds to it. */
function supported(claim: Figure, evidence: Figure[]): boolean {
  return evidence.some(
    (e) =>
      same(claim.value, e.value) ||
      (claim.scaled && same(roundTo(e.value, claim.significant), claim.value)) ||
      (claim.decimals < e.decimals && same(Number(e.value.toFixed(claim.decimals)), claim.value)),
  );
}

/** A computed value written the way the claim is written (its significant digits or decimals). */
function writtenAs(claim: Figure, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return (
    same(claim.value, value) ||
    (claim.scaled && same(roundTo(value, claim.significant), claim.value)) ||
    same(Number(value.toFixed(claim.decimals)), claim.value)
  );
}

/** The claim is a sum, difference, percentage change or share (as a percentage) of two of the given figures. */
function derived(claim: Figure, from: number[]): boolean {
  for (const a of from) {
    for (const b of from) {
      if (a === b) continue;
      if (writtenAs(claim, a - b) || writtenAs(claim, a + b)) return true;
      if (b !== 0 && (writtenAs(claim, ((a - b) / b) * 100) || writtenAs(claim, (a / b) * 100))) return true;
    }
  }
  return false;
}

export interface NumberCheck {
  /** How many numbers in the answer were checked. */
  checked: number;
  /** The ones no source contains, as written in the answer. */
  missing: string[];
}

export function checkNumbers(answer: string, evidenceText: string): NumberCheck {
  const evidence = evidenceText.replace(/[    ]/g, " ");
  let text = claimText(answer);
  const missing: string[] = [];
  let checked = 0;
  for (const m of text.matchAll(VERSION)) {
    checked++;
    if (!evidence.includes(m[1]!)) missing.push(m[0]);
  }
  text = text.replace(VERSION, " ");
  const known = figures(evidence);
  const unsupported: Figure[] = [];
  const stated: number[] = []; // figures in the answer that the sources support: the inputs for calculations
  for (const claim of figures(text)) {
    if (isYear(claim) || isSmallCount(claim)) continue;
    checked++;
    if (supported(claim, known)) {
      if (!stated.some((v) => same(v, claim.value))) stated.push(claim.value);
    } else unsupported.push(claim);
  }
  for (const claim of unsupported) if (!derived(claim, stated.slice(0, 40))) missing.push(claim.text);
  return { checked, missing: [...new Set(missing)] };
}

/** The admin-only step shown under the answer, or null when there was nothing to check. */
export function numberCheckEvent(answer: string, evidence: string[]): ToolEventDto | null {
  const { checked, missing } = checkNumbers(answer, evidence.join("\n"));
  if (checked === 0) return null;
  const listed = missing.slice(0, 6).join(", ") + (missing.length > 6 ? ` and ${missing.length - 6} more` : "");
  return {
    id: "answer-check",
    name: ANSWER_CHECK,
    label: "Number check",
    args: {},
    status: missing.length ? "error" : "done",
    summary: missing.length ? `Not found in any source: ${listed}` : `All ${checked} number${checked === 1 ? "" : "s"} found in the sources`,
  };
}
