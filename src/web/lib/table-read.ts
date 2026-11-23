/**
 * Reading spreadsheets for data analysis (v0.14.0): from cells as found in a CSV or Excel file to a clean table.
 *
 * - The header row is found (title rows above it are skipped); columns get names, duplicates are numbered.
 * - Each column gets one type: number, date, yes/no or text. "1,234.50", "$1,200", "(45)" and "12%" are numbers;
 *   "2026-03-05", "05/03/2026", "5 Mar 2026" are dates (day/month order decided per column); "n/a", "-" are empty.
 *   Codes such as "00123" stay text. A value that doesn't fit its column's type is left empty and counted.
 * - A "Total" row at the end is left out (so totals aren't counted twice), with a note.
 * - The overview (ranges, empty cells, common values) is worked out over every row, and the rows are cut into blocks
 *   for upload: [spreadsheet row number, cell, cell, …].
 *
 * Pure functions (no browser APIs), so the tests can run them; table-file.ts does the file and Excel part.
 */
import { TABLE_LIMITS } from "../../shared/tables";
import type { TableCell, TableColumnDto, TableColumnType, TableFileKind, TableSheetInput } from "../../shared/types";

/** One cell as found in the file, before its column's type is decided. */
export type RawCell =
  | null
  | { t: "s"; v: string }
  | { t: "n"; v: number; w?: string; unit?: string; percent?: boolean }
  | { t: "d"; v: string; time: boolean; w?: string }
  | { t: "b"; v: boolean }
  | { t: "e"; w?: string };

export interface RawSheet {
  /** Sheet name (Excel, OpenDocument); null for CSV. */
  name: string | null;
  /** Rows as found (they may have different lengths); rows[0] is spreadsheet row `firstRow`. */
  rows: RawCell[][];
  firstRow: number;
}

export interface ReadTable extends Omit<TableSheetInput, "chunks"> {
  /** The rows, cut into blocks for upload: each row is [spreadsheet row number, cell, cell, …]. */
  blocks: TableCell[][][];
}

export interface ReadFile {
  name: string;
  kind: TableFileKind;
  bytes: number;
  tables: ReadTable[];
}

/** A problem with the file itself, explained in plain words. */
export class TableReadError extends Error {}

export interface ReadOptions {
  /** Dates like 03/04/2026 that could be either way are read month-first (the browser's language is US English). */
  preferMdy: boolean;
}

const fmtCount = (n: number) => n.toLocaleString("en-US");

/** Size of text in UTF-8 bytes (what the upload limit counts). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // a surrogate pair (emoji and rarer characters) is one 4-byte character
      i++;
    } else bytes += 3;
  }
  return bytes;
}
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const tidy = (v: number) => Number(v.toPrecision(15));

/** Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ------------------------------------------------------------------ CSV

/** CSV/TSV text from the file's bytes: UTF-8, UTF-16 (with its byte-order mark) or, failing UTF-8, Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const DELIMITERS = [",", ";", "\t", "|"];

/** How many times `delimiter` appears outside quotes on each of the first lines. */
function countsPerLine(text: string, delimiter: string, maxLines: number): number[] {
  const counts: number[] = [];
  let count = 0;
  let quoted = false;
  for (let i = 0; i < text.length && counts.length < maxLines; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count++;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      counts.push(count);
      count = 0;
    }
  }
  if (count > 0) counts.push(count);
  return counts;
}

/** The separator a CSV file uses: the one that splits its first lines most consistently (comma, semicolon, tab, |). */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const lines = countsPerLine(sample, d, 30);
    if (lines.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of lines) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeFreq = 0;
    for (const [c, f] of freq) if (f > modeFreq || (f === modeFreq && c > mode)) [mode, modeFreq] = [c, f];
    if (mode === 0) continue;
    const score = (modeFreq / lines.length) * 1000 + Math.min(mode, 999);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

/** Split CSV text into records and fields (quotes, doubled quotes and line breaks inside quotes are handled). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  while (i <= n) {
    if (i === n) {
      if (row.length > 0) rows.push(row);
      break;
    }
    let field = "";
    if (text[i] === '"') {
      // Quoted field: up to the closing quote; "" is a quote inside it.
      i++;
      for (;;) {
        const end = text.indexOf('"', i);
        if (end < 0) {
          field += text.slice(i);
          i = n;
          break;
        }
        field += text.slice(i, end);
        if (text[end + 1] === '"') {
          field += '"';
          i = end + 2;
        } else {
          i = end + 1;
          break;
        }
      }
      // Anything after the closing quote up to the separator belongs to the field (lenient).
      while (i < n && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") field += text[i++];
    } else {
      let j = i;
      while (j < n && text[j] !== delimiter && text[j] !== "\n" && text[j] !== "\r") j++;
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (text[i] === delimiter) {
      i++;
      if (i === n) {
        row.push("");
        rows.push(row);
        break;
      }
      continue;
    }
    // Line break.
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    i++;
    rows.push(row);
    row = [];
    if (i === n) break;
  }
  return rows;
}

/** A CSV/TSV file's rows as raw cells (a first line "sep=;" written by Excel sets the separator and is skipped). */
export function csvSheet(text: string, forced?: string): RawSheet {
  let body = text;
  let firstRow = 1;
  let delimiter = forced;
  const hint = /^sep=(.)\r?\n/i.exec(body);
  if (hint) {
    delimiter = hint[1];
    body = body.slice(hint[0].length);
    firstRow = 2;
  }
  delimiter ??= sniffDelimiter(body);
  const rows = parseCsv(body, delimiter).map((fields) =>
    fields.map((f): RawCell => {
      const v = f.trim();
      return v ? { t: "s", v } : null;
    }),
  );
  return { name: null, rows, firstRow };
}

// ------------------------------------------------------------------ values in text

/** Cells that mean "no value". */
const PLACEHOLDER = /^(?:-+|—|–|n\/?a|#n\/a|na|null|none|nil|nan|\?|\.)$/i;
const CURRENCY = String.raw`US\$|\$|€|£|¥|₹|Rs\.?|PKR|USD|EUR|GBP|INR|AED|SAR|CAD|AUD`;
const CURRENCY_PREFIX = new RegExp(`^(${CURRENCY})\\s?`, "i");
const CURRENCY_SUFFIX = new RegExp(`\\s?(${CURRENCY})$`, "i");

function unitName(raw: string): string {
  const u = raw.trim();
  if (/^rs\.?$/i.test(u)) return "Rs";
  if (/^us\$$/i.test(u)) return "$";
  return /^[a-z]{3}$/i.test(u) ? u.toUpperCase() : u;
}

export interface ParsedNumber {
  v: number;
  unit?: string;
  percent?: boolean;
}

/**
 * A number written as text: "1,234.50", "-12", "(45)" (negative), "$1,200", "1 200 PKR", "12.5%", "1.2E+5".
 * With `decimalComma`, "1.234,56" and "12,5" are read the European way. Null when it isn't a number.
 */
export function parseNumberText(text: string, decimalComma = false): ParsedNumber | null {
  let s = text.trim().replace(/[   ]/g, " ");
  if (!s || s.length > 40) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (/^-\s*\D/.test(s)) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  let unit: string | undefined;
  const prefix = CURRENCY_PREFIX.exec(s);
  if (prefix) {
    unit = unitName(prefix[1]!);
    s = s.slice(prefix[0].length);
  } else {
    const suffix = CURRENCY_SUFFIX.exec(s);
    if (suffix) {
      unit = unitName(suffix[1]!);
      s = s.slice(0, -suffix[0].length);
    }
  }
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(s)) s = s.replace(/ /g, "");
  let normal: string;
  if (decimalComma) {
    if (!/^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/.test(s)) return null;
    normal = s.replace(/\./g, "").replace(",", ".");
  } else {
    if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
    normal = s.replace(/,/g, "");
  }
  const n = Number(normal);
  if (!Number.isFinite(n)) return null;
  return { v: tidy(negative ? -n : n), ...(unit ? { unit } : {}), ...(percent ? { percent: true } : {}) };
}

/** Digits that are a code, not an amount: a leading zero ("00123") or more than 15 digits (IDs, card-like numbers). */
const isCode = (text: string) => /^[+-]?0\d+$/.test(text.trim()) || /\d{16,}/.test(text.replace(/[\s,.-]/g, ""));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const TIME_RE = String.raw`(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([ap]\.?m\.?)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)?`;
const ISO = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME_RE}$`, "i");
const SLASHED = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})${TIME_RE}$`, "i");
const DAY_MONTH = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?[\s-]+${MONTH_RE}[\s,-]+(\d{4}|\d{2})${TIME_RE}$`, "i");
const MONTH_DAY = new RegExp(String.raw`^${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})${TIME_RE}$`, "i");

const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 70 ? 2000 + Number(y) : 1900 + Number(y)) : Number(y));
const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

function buildDate(y: number, m: number, d: number, time: (string | undefined)[]): { date: string; time: string | null } | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null; // e.g. 31 April
  const date = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const [hh, mm, ss, ampm] = time;
  if (hh === undefined) return { date, time: null };
  let h = Number(hh);
  if (ampm) {
    if (h < 1 || h > 12) return null;
    const pm = ampm.toLowerCase().startsWith("p");
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return null;
  return { date, time: `${String(h).padStart(2, "0")}:${mm}:${(ss ?? "00").padStart(2, "0")}` };
}

/** The two leading numbers of a slashed date ("05/03/2026" → [5, 3]), for deciding day/month order. */
export function slashedParts(text: string): [number, number] | null {
  const m = SLASHED.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * A date written as text: "2026-03-05", "2026/3/5 14:30", "05/03/2026" (day/month order as given), "5 Mar 2026",
 * "March 5, 2026", with an optional time. Time zones are ignored (the time is kept as written).
 */
export function parseDateText(text: string, order: "dmy" | "mdy"): { date: string; time: string | null } | null {
  const s = text.trim();
  if (s.length < 6 || s.length > 40) return null;
  let m = ISO.exec(s);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]), m.slice(4, 8));
  m = SLASHED.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "dmy" ? buildDate(fullYear(m[3]!), b, a, m.slice(4, 8)) : buildDate(fullYear(m[3]!), a, b, m.slice(4, 8));
  }
  m = DAY_MONTH.exec(s);
  if (m) return buildDate(fullYear(m[3]!), monthOf(m[2]!), Number(m[1]), m.slice(4, 8));
  m = MONTH_DAY.exec(s);
  if (m) return buildDate(Number(m[3]), monthOf(m[1]!), Number(m[2]), m.slice(4, 8));
  return null;
}

const BOOL_TEXT = /^(?:true|false)$/i;

// ------------------------------------------------------------------ from raw cells to a table

const TOTAL_ROW = /^(?:grand\s+)?totals?\b|^sum\b|^overall\s+total\b/i;
const SUBTOTAL_ROW = /^sub[\s-]?totals?\b/i;

/** The name key two columns may not share (same rule as the server and the analysis tool). */
const nameKey = (name: string) => name.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").toLowerCase();

function cellText(c: RawCell): string {
  if (c === null) return "";
  switch (c.t) {
    case "s":
      return c.v;
    case "n":
      return c.w?.trim() || String(c.v);
    case "d":
      return c.w?.trim() || c.v;
    case "b":
      return c.v ? "TRUE" : "FALSE";
    default:
      return "";
  }
}

const isFilled = (c: RawCell | undefined): boolean => c !== null && c !== undefined && c.t !== "e" && !(c.t === "s" && PLACEHOLDER.test(c.v));
/** A header-like cell: text that isn't a number or a date. */
const isLabel = (c: RawCell | undefined) =>
  c !== null && c !== undefined && c.t === "s" && parseNumberText(c.v) === null && parseDateText(c.v, "dmy") === null;

interface Typed {
  type: TableColumnType;
  values: TableCell[];
  invalid: number;
  errors: number;
  unit?: string;
  hasTime?: boolean;
  dateOrder?: "dmy" | "mdy";
  clipped: number;
}

/** Decide a column's type from its cells and convert every cell to it. */
export function typeColumn(cells: RawCell[], options: ReadOptions): Typed {
  let nonBlank = 0;
  let errors = 0;
  let numbers = 0;
  let dates = 0;
  let bools = 0;
  let codes = false;
  // Decimal comma or point, and day/month order, are decided from the whole column.
  let commaEvidence = 0;
  let dotEvidence = 0;
  let firstOver12 = false;
  let secondOver12 = false;
  for (const c of cells) {
    if (c === null) continue;
    if (c.t === "e") {
      errors++;
      continue;
    }
    if (c.t !== "s") continue;
    const v = c.v.trim();
    if (/,\d{1,2}(?!\d)\D*$|\.\d{3},\d/.test(v)) commaEvidence++;
    if (/\.\d{1,2}(?!\d)\D*$|,\d{3}\.\d|\.\d{4,}/.test(v)) dotEvidence++;
    const parts = slashedParts(v);
    if (parts) {
      if (parts[0] > 12) firstOver12 = true;
      if (parts[1] > 12) secondOver12 = true;
    }
  }
  const decimalComma = commaEvidence > 0 && dotEvidence === 0;
  const slashedConflict = firstOver12 && secondOver12;
  const order: "dmy" | "mdy" = firstOver12 ? "dmy" : secondOver12 ? "mdy" : options.preferMdy ? "mdy" : "dmy";
  let slashedSeen = false;

  for (const c of cells) {
    if (!isFilled(c)) continue;
    nonBlank++;
    switch (c!.t) {
      case "n":
        numbers++;
        break;
      case "d":
        dates++;
        break;
      case "b":
        bools++;
        break;
      case "s": {
        const v = c!.v;
        if (BOOL_TEXT.test(v)) bools++;
        else if (parseNumberText(v, decimalComma)) {
          numbers++;
          if (isCode(v)) codes = true;
        } else if (!(slashedConflict && slashedParts(v)) && parseDateText(v, order)) {
          dates++;
          if (slashedParts(v)) slashedSeen = true;
        }
        break;
      }
    }
  }

  // Mostly one kind: at least 90% of the filled cells, with at most 1 (or 2%) that don't fit.
  const fits = (n: number) => n > 0 && n >= nonBlank * 0.9 && nonBlank - n <= Math.max(1, Math.floor(nonBlank * 0.02));
  const type: TableColumnType =
    nonBlank > 0 && bools === nonBlank ? "boolean" : !codes && fits(numbers) ? "number" : fits(dates) ? "date" : "text";

  let invalid = 0;
  let clipped = 0;
  const unitCounts = new Map<string, number>();
  let percents = 0;
  let timed = false;
  const values: TableCell[] = cells.map((c): TableCell => {
    if (!isFilled(c)) return null;
    const cell = c!;
    switch (type) {
      case "number": {
        const parsed: ParsedNumber | null =
          cell.t === "n" ? { v: cell.v, ...(cell.unit ? { unit: cell.unit } : {}), ...(cell.percent ? { percent: true } : {}) } : cell.t === "s" ? parseNumberText(cell.v, decimalComma) : null;
        if (!parsed) {
          invalid++;
          return null;
        }
        if (parsed.percent) percents++;
        if (parsed.unit) unitCounts.set(parsed.unit, (unitCounts.get(parsed.unit) ?? 0) + 1);
        return parsed.v;
      }
      case "date": {
        const parsed = cell.t === "d" ? { date: cell.v.slice(0, 10), time: cell.time ? cell.v.slice(11, 19) : null } : cell.t === "s" ? parseDateText(cell.v, order) : null;
        if (!parsed) {
          invalid++;
          return null;
        }
        if (parsed.time && parsed.time !== "00:00:00") timed = true;
        return parsed.time ? `${parsed.date}T${parsed.time}` : parsed.date;
      }
      case "boolean":
        return cell.t === "b" ? cell.v : /^true$/i.test((cell as { v: string }).v);
      default: {
        const text = cellText(cell).trim();
        if (!text) return null;
        if (text.length > TABLE_LIMITS.cellChars) {
          clipped++;
          return clip(text, TABLE_LIMITS.cellChars);
        }
        return text;
      }
    }
  });

  // Dates: all with a time of day, or all without.
  if (type === "date") {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (typeof v !== "string") continue;
      values[i] = timed ? (v.length === 10 ? `${v}T00:00:00` : v) : v.slice(0, 10);
    }
  }
  let unit: string | undefined;
  const counted = values.filter((v) => v !== null).length;
  if (type === "number" && counted > 0) {
    if (percents >= counted * 0.8) unit = "%";
    else {
      const [top, n] = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
      if (top && n >= counted * 0.8) unit = top;
    }
  }
  return {
    type,
    values,
    invalid,
    errors,
    clipped,
    ...(unit ? { unit } : {}),
    ...(type === "date" && timed ? { hasTime: true } : {}),
    ...(type === "date" && slashedSeen ? { dateOrder: order } : {}),
  };
}

/** The column overview: empty cells, different values, range, most common values or examples. */
export function profileColumn(name: string, typed: Typed): TableColumnDto {
  const filled = typed.values.filter((v): v is Exclude<TableCell, null> => v !== null);
  const counts = new Map<string, number>();
  for (const v of filled) {
    const key = typeof v === "boolean" ? String(v) : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const column: TableColumnDto = { name, type: typed.type, blanks: typed.values.length - filled.length, distinct: counts.size };
  if (typed.unit) column.unit = typed.unit;
  if (typed.hasTime) column.hasTime = true;
  if (typed.dateOrder) column.dateOrder = typed.dateOrder;
  if (typed.invalid) column.invalid = typed.invalid;
  if (filled.length > 0 && (typed.type === "number" || typed.type === "date")) {
    let min = filled[0]!;
    let max = filled[0]!;
    for (const v of filled) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    column.min = min as number | string;
    column.max = max as number | string;
  }
  if (typed.type === "text" || typed.type === "boolean") {
    // Most common first; ties in a fixed order (character codes), so every browser lists them the same way.
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // Values are shortened: the overview only needs to recognise them (the model sees 40 characters of each).
    if (sorted.length <= 12) column.top = sorted.map(([value, count]) => ({ value: clip(value, 100), count }));
    else {
      if ((sorted[0]?.[1] ?? 0) >= 2) column.top = sorted.slice(0, 5).map(([value, count]) => ({ value: clip(value, 100), count }));
      column.examples = [...counts.keys()].slice(0, 3).map((v) => clip(v, 100));
    }
  }
  return column;
}

/** One sheet (or a CSV file) as a table, or null when it has no data. */
export function buildTable(sheet: RawSheet, options: ReadOptions): ReadTable | null {
  const notes: string[] = [];
  const width = sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
  const used: number[] = [];
  for (let c = 0; c < width; c++) if (sheet.rows.some((row) => row[c] !== null && row[c] !== undefined)) used.push(c);
  if (used.length === 0) return null;
  let columns = used;
  if (columns.length > TABLE_LIMITS.columns) {
    notes.push(`Only the first ${TABLE_LIMITS.columns} of ${used.length} columns were read.`);
    columns = columns.slice(0, TABLE_LIMITS.columns);
  }
  const filledCount = (row: RawCell[]) => columns.reduce((n, c) => n + (isFilled(row[c]) ? 1 : 0), 0);
  const nonEmpty = sheet.rows.map((row, i) => ({ i, filled: filledCount(row) })).filter((r) => r.filled > 0);
  if (nonEmpty.length === 0) return null;

  // The header: the first wide-enough row of labels (title rows above it are skipped). A first row of numbers or
  // dates means there is no header.
  const early = nonEmpty.slice(0, 20);
  const widest = Math.max(...early.map((r) => r.filled));
  let header = -1;
  for (const { i, filled } of early) {
    if (filled < Math.max(1, Math.ceil(widest * 0.5))) continue;
    const row = sheet.rows[i]!;
    const labels = columns.filter((c) => isLabel(row[c])).length;
    if (labels / filled >= 0.6 && nonEmpty.some((r) => r.i > i)) header = i;
    break;
  }
  if (header < 0) notes.push("No header row was found, so the columns are named Column A, Column B, …");
  else if (header > nonEmpty[0]!.i) {
    const skipped = nonEmpty.filter((r) => r.i < header).map((r) => sheet.firstRow + r.i);
    notes.push(`Row${skipped.length === 1 ? "" : "s"} ${skipped.map(fmtCount).join(", ")} above the header (titles) ${skipped.length === 1 ? "was" : "were"} skipped.`);
  }

  // Column names: the header text, or the column letter; duplicates get (2), (3)…
  const seen = new Map<string, number>();
  const names = columns.map((c) => {
    const raw = header >= 0 ? cellText(sheet.rows[header]![c] ?? null).replace(/\s+/g, " ").trim() : "";
    let name = clip(raw, 100) || `Column ${columnLetter(c)}`;
    const key = nameKey(name);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) {
      let k = n;
      while (seen.has(nameKey(`${name} (${k})`))) k++;
      name = `${name} (${k})`;
      seen.set(nameKey(name), 1);
    }
    return name;
  });

  // Data rows: everything after the header with at least one value.
  let data = nonEmpty.filter((r) => r.i > header).map((r) => ({ row: sheet.rows[r.i]!, number: sheet.firstRow + r.i }));
  // A totals row at the end would count everything twice in a sum: leave it out (and say so).
  for (let removed = 0; removed < 3 && data.length > 1; removed++) {
    const last = data[data.length - 1]!;
    const first = columns.map((c) => last.row[c]).find((c) => isFilled(c));
    const hasNumber = columns.some((c) => {
      const cell = last.row[c];
      return cell?.t === "n" || (cell?.t === "s" && (parseNumberText(cell.v) ?? parseNumberText(cell.v, true)) !== null);
    });
    if (first?.t !== "s" || !TOTAL_ROW.test(first.v) || !hasNumber) break;
    notes.push(`Row ${fmtCount(last.number)} ("${clip(first.v, 40)}") looks like a totals row and was left out, so totals aren't counted twice.`);
    data = data.slice(0, -1);
  }
  if (data.length === 0) return null;
  const subtotals = data.filter((d) => {
    const first = columns.map((c) => d.row[c]).find((c) => isFilled(c));
    return first?.t === "s" && SUBTOTAL_ROW.test(first.v);
  });
  if (subtotals.length) {
    notes.push(
      `Row${subtotals.length === 1 ? "" : "s"} ${subtotals.slice(0, 5).map((d) => fmtCount(d.number)).join(", ")}${subtotals.length > 5 ? " and others" : ""} look like subtotals; leave them out of sums (filter on _row or the first column).`,
    );
  }

  const typed = columns.map((c) => typeColumn(data.map((d) => d.row[c] ?? null), options));
  const profiles = typed.map((t, k) => profileColumn(names[k]!, t));
  typed.forEach((t, k) => {
    if (t.errors) notes.push(`${names[k]}: ${fmtCount(t.errors)} cell${t.errors === 1 ? " has an Excel error" : "s have Excel errors"} (like #N/A) and count as empty.`);
    if (t.clipped) notes.push(`${names[k]}: ${fmtCount(t.clipped)} long text${t.clipped === 1 ? " was" : "s were"} shortened to ${fmtCount(TABLE_LIMITS.cellChars)} characters.`);
  });

  const rows: TableCell[][] = data.map((d, r) => [d.number, ...typed.map((t) => t.values[r]!)]);
  const blocks: TableCell[][][] = [];
  let block: TableCell[][] = [];
  let size = 2;
  for (const row of rows) {
    const length = utf8Bytes(JSON.stringify(row)) + 1;
    if (block.length > 0 && (block.length >= TABLE_LIMITS.chunkRows || size + length > TABLE_LIMITS.chunkBytes)) {
      blocks.push(block);
      block = [];
      size = 2;
    }
    block.push(row);
    size += length;
  }
  if (block.length) blocks.push(block);

  return {
    sheet: sheet.name,
    rows: rows.length,
    firstRow: data[0]!.number,
    lastRow: data[data.length - 1]!.number,
    columns: profiles,
    notes,
    samples: rows.slice(0, 3).map((row) => row.slice(1).map((v) => (typeof v === "string" ? clip(v, 100) : v))),
    blocks,
  };
}

/** A whole file: one table per sheet with data. Throws TableReadError for files VESPER can't take. */
export function buildFile(
  input: { name: string; kind: TableFileKind; bytes: number; sheets: RawSheet[]; notes?: string[] },
  options: ReadOptions,
): ReadFile {
  let tables = input.sheets.map((s) => buildTable(s, options)).filter((t): t is ReadTable => t !== null);
  if (tables.length === 0) throw new TableReadError(`"${input.name}" has no rows of data.`);
  const notes = [...(input.notes ?? [])];
  if (tables.length > TABLE_LIMITS.sheets) {
    notes.push(`Only the first ${TABLE_LIMITS.sheets} sheets with data were read.`);
    tables = tables.slice(0, TABLE_LIMITS.sheets);
  }
  const rows = tables.reduce((n, t) => n + t.rows, 0);
  if (rows > TABLE_LIMITS.rows) {
    throw new TableReadError(
      `"${input.name}" has ${fmtCount(rows)} rows of data; the limit is ${fmtCount(TABLE_LIMITS.rows)}. Remove rows you don't need, or split it into smaller files.`,
    );
  }
  if (notes.length) tables[0] = { ...tables[0]!, notes: [...notes, ...tables[0]!.notes].slice(0, 10) };
  return { name: input.name, kind: input.kind, bytes: input.bytes, tables: tables.map((t) => ({ ...t, notes: t.notes.slice(0, 10) })) };
}
