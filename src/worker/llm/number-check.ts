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
 *
 * General-knowledge numbers aren't flagged (v0.11.0): a figure no source has is listed only when its sentence (or
 * list item, or table cell) is about what the sources say: it shares enough words with them, cites a source, or has
 * another figure the sources support. So "Sunscreen (SPF 30+)" or "Pakistan uses 230 V" in a packing list built from a
 * weather look-up is left alone, while a wrong figure in a sentence about the census is still caught. The words are
 * compared with what the tools returned only (not the chat or the prompt, which would match almost anything).
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

/** Where a sentence, list item, table cell or line ends: each part is judged on its own. */
const PART_BREAK = /\n|\||•|<[bB][rR]\s*\/?>|(?<=[.!?])\s+(?=[*_"'(\[]*[A-Z])/;
/** Common words that say nothing about the topic (only words of 4+ letters are compared). */
const STOP = new Set(
  (
    "about above after again also although among another around away back because been before being below between both " +
    "came come could does doing done down during each either else even ever every from gets give given goes going good " +
    "great have having here into just keep know last least less like likely made make many more most much must near need " +
    "never next only other over same should since some such sure take than that their them then there these they thing " +
    "things this those though through very want well were what when where which while will with within without would " +
    "your yours usually often always still today yesterday tomorrow note answer source sources according roughly " +
    "approximately nearly almost total thousand million billion trillion lakh lakhs crore crores percent"
  ).split(" "),
);
/** Topic words: 4+ letters, lower case, a plural "s" dropped, common words left out. */
function topicWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/\p{L}[\p{L}'’]{3,}/gu) ?? []) {
    const word = raw.replace(/['’]s?$/, "");
    if (word.length < 4 || STOP.has(word)) continue;
    out.add(word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return [...out];
}

/**
 * Is this part of the answer about what the sources say? Yes when it cites a source ([S1]) or enough of its topic
 * words appear in the sources: 1 for a part of up to 3 words, otherwise at least 2. A part with no words
 * at all (a bare figure) is checked.
 */
function aboutSources(part: string, sourceWords: Set<string>): boolean {
  if (/\[S\d{1,2}\]/.test(part)) return true;
  const words = topicWords(part);
  if (words.length === 0) return true;
  const shared = words.filter((w) => sourceWords.has(w)).length;
  return shared >= (words.length <= 3 ? 1 : 2);
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
  /** Numbers left out because their sentence isn't about the sources (general knowledge, e.g. "SPF 30"). */
  general: number;
}

/**
 * `evidenceText`: everything a figure may come from (what the tools returned, the question, the chat).
 * `sourceText`: what the tools returned only, to tell which sentences are about the sources. Without it, every
 * figure is checked.
 */
export function checkNumbers(answer: string, evidenceText: string, sourceText?: string): NumberCheck {
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
  const parts = text.split(PART_BREAK);
  const unsupported: { claim: Figure; part: number }[] = [];
  const backed = new Set<number>(); // parts with a figure the sources support: they state facts from the sources
  const stated: number[] = []; // figures in the answer that the sources support: the inputs for calculations
  parts.forEach((part, i) => {
    for (const claim of figures(part)) {
      if (isYear(claim) || isSmallCount(claim)) continue;
      if (supported(claim, known)) {
        checked++;
        backed.add(i);
        if (!stated.some((v) => same(v, claim.value))) stated.push(claim.value);
      } else unsupported.push({ claim, part: i });
    }
  });
  const sourceWords = sourceText === undefined ? null : new Set(topicWords(sourceText));
  let general = 0;
  for (const { claim, part } of unsupported) {
    if (derived(claim, stated.slice(0, 40))) {
      checked++;
    } else if (sourceWords && !backed.has(part) && !aboutSources(parts[part]!, sourceWords)) {
      general++;
    } else {
      checked++;
      missing.push(claim.text);
    }
  }
  return { checked, missing: [...new Set(missing)], general };
}

/**
 * The admin-only step shown under the answer, or null when there was nothing to check.
 * `evidence`: everything a figure may come from; `sources`: what the tools returned (see checkNumbers).
 */
export function numberCheckEvent(answer: string, evidence: string[], sources?: string[]): ToolEventDto | null {
  const { checked, missing, general } = checkNumbers(answer, evidence.join("\n"), sources?.join("\n"));
  if (checked === 0) return null;
  const listed = missing.slice(0, 6).join(", ") + (missing.length > 6 ? ` and ${missing.length - 6} more` : "");
  const skipped = general ? ` (${general} general number${general === 1 ? "" : "s"} not checked)` : "";
  return {
    id: "answer-check",
    name: ANSWER_CHECK,
    label: "Number check",
    args: {},
    status: missing.length ? "error" : "done",
    summary:
      (missing.length ? `Not found in any source: ${listed}` : `All ${checked} number${checked === 1 ? "" : "s"} found in the sources`) + skipped,
  };
}
