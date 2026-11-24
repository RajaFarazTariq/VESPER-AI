/**
 * Spreadsheet results under an answer (v0.14.1): which ones to show, how their values are written, the chart that
 * suits each one, and the CSV text. Plain logic with no page access (tested in tests/tables.test.ts); the card
 * (components/TableResultCard.tsx) draws it and saves the file.
 *
 * Chart rules (one figure at a time, never two scales on one chart):
 * - grouped by a date period (year, quarter, month, week, day, hour) and the result is complete or in date order →
 *   a line over time. A period with no rows counts as 0 for counts and sums and is a gap for averages, medians,
 *   lowest and highest (nothing to average).
 * - grouped by one other value (or a ranking of periods, e.g. "top 5 months") → bars in the result's order.
 * - grouped by a date period and one other value with up to 4 different values, complete → one line per value.
 * - anything else (a single figure, listed rows, three groupings, too many periods) → the table only.
 */
import type { TableBucket, TableCell, TableResultColumnDto, TableResultDto, ToolEventDto } from "../../shared/types";

const TABLE_TOOL = "query_table";
/** Lines with more points than this (after filling in empty periods) are shown as a table instead. */
export const MAX_LINE_POINTS = 1_500;
/** One line per value of a second grouping, up to this many (a legend and colors stay easy to tell apart). */
export const MAX_SERIES = 4;

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, word: string, locale?: string) => `${n.toLocaleString(locale)} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ which results

function isResult(r: unknown): r is TableResultDto {
  const v = r as TableResultDto | null;
  return Boolean(v && Array.isArray(v.rows) && Array.isArray(v.columns) && v.columns.length > 0 && typeof v.title === "string");
}

/** Worth a card: a list of rows, or a grouped result with more than one row (a single figure is already in the answer). */
function worthShowing(r: TableResultDto): boolean {
  if (r.rows.length === 0) return false;
  return r.mode === "rows" || r.rows.length > 1;
}

/** The results to show under an answer, in order; the same calculation done twice is shown once (the last one). */
export function shownResults(tools: ToolEventDto[] | null | undefined): TableResultDto[] {
  const byKey = new Map<string, TableResultDto>();
  for (const t of tools ?? []) {
    if (t.name !== TABLE_TOOL || t.status !== "done" || !isResult(t.table) || !worthShowing(t.table)) continue;
    const key = `${t.table.table}\u0000${t.table.title}`;
    byKey.delete(key);
    byKey.set(key, t.table);
  }
  return [...byKey.values()];
}

// ------------------------------------------------------------------ writing values

const TIME_BUCKETS = new Set<TableBucket>(["year", "quarter", "month", "week", "day", "hour"]);
/** A grouping by a date period that runs in time order (weekdays are categories: Monday … Sunday). */
export const isTimeBucket = (by: TableBucket | undefined): boolean => by !== undefined && TIME_BUCKETS.has(by);

const CURRENCY_SYMBOLS = new Set(["$", "€", "£", "¥", "₹"]);
const isCurrency = (unit: string | undefined) => Boolean(unit && unit !== "%");

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function formatDateParts(y: number, m: number, d: number, options: Intl.DateTimeFormatOptions, locale?: string, h = 0, min = 0): string {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) {
    // The values are calendar dates as written in the file: shown in UTC, so no time zone moves them.
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    dateFormats.set(key, f);
  }
  return f.format(new Date(Date.UTC(y, m - 1, d, h, min)));
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/;

/** "2026-03-05" → "5 Mar 2026"; with a time "5 Mar 2026, 14:30". Anything else is shown as it is. */
export function formatDate(v: string, locale?: string): string {
  const m = DATE_TEXT.exec(v);
  if (!m) return v;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return formatDateParts(y, mo, d, { day: "numeric", month: "short", year: "numeric" }, locale);
  return formatDateParts(y, mo, d, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale, Number(m[4]), Number(m[5]));
}

/** A whole year in a "Year" column reads 2026, not 2,026. */
const yearLike = (column: TableResultColumnDto, v: number) => Number.isInteger(v) && /\b(?:year|yr|fy)\b/i.test(column.label);

/**
 * A number for reading. "exact" keeps every digit the result has (tables); "short" rounds to 2 decimals, or 3
 * significant digits below 1 (charts). Currency amounts with cents show both decimals.
 */
export function formatNumber(v: number, style: "exact" | "short", unit?: string, locale?: string): string {
  if (style === "exact") return v.toLocaleString(locale, { maximumFractionDigits: 10 });
  const abs = Math.abs(v);
  if (isCurrency(unit) && !Number.isInteger(v) && abs >= 1) return v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs !== 0 && abs < 1) return v.toLocaleString(locale, { maximumSignificantDigits: 3 });
  return v.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/** "1,234.50" with its unit: "$1,234.50", "45%", "Rs 1,234", "1,234 PKR". */
export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  if (unit === "%") return `${text}%`;
  const negative = /^[-−]/.test(text);
  const digits = negative ? text.slice(1) : text;
  if (CURRENCY_SYMBOLS.has(unit)) return `${negative ? "-" : ""}${unit}${digits}`;
  if (unit === "Rs") return `${negative ? "-" : ""}Rs ${digits}`;
  return `${text} ${unit}`;
}

/** A group's name: "(empty)", "Q1 2026", "March 2026" / "Mar 2026", "Week of 2 Mar 2026", "Monday", "14:00". */
export function groupLabel(v: TableCell, column: TableResultColumnDto, style: "long" | "short", locale?: string): string {
  if (v === null || v === "") return "(empty)";
  const s = String(v);
  switch (column.by) {
    case "year":
      return s;
    case "quarter": {
      const m = /^(\d{4})-Q([1-4])$/.exec(s);
      return m ? `Q${m[2]} ${m[1]}` : s;
    }
    case "month": {
      const m = /^(\d{4})-(\d{2})$/.exec(s);
      if (!m) return s;
      // The axis writes the whole year: "Jan 26" could be read as 26 January.
      const options: Intl.DateTimeFormatOptions = style === "long" ? { month: "long", year: "numeric" } : { month: "short", year: "numeric" };
      return formatDateParts(Number(m[1]), Number(m[2]), 1, options, locale);
    }
    case "week":
    case "day": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return s;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (style === "short") return formatDateParts(y, mo, d, { day: "numeric", month: "short" }, locale);
      const day = formatDateParts(y, mo, d, { day: "numeric", month: "short", year: "numeric" }, locale);
      return column.by === "week" ? `Week of ${day}` : day;
    }
    case "weekday":
      return s.replace(/^\d\s+/, "");
    case "hour":
      return /^\d{2}$/.test(s) ? `${s}:00` : s;
    default:
      return cellText(v, column, "table", locale);
  }
}

/** A cell for reading: in the table ("exact": every digit, no unit; the header has it) or in a chart ("short", with its unit). */
export function cellText(v: TableCell, column: TableResultColumnDto, style: "table" | "chart", locale?: string): string {
  if (column.kind === "group" && (v === null || (column.by && column.by !== "value"))) return groupLabel(v, column, "long", locale);
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (column.kind === "row" || yearLike(column, v)) return String(v);
    return style === "table" ? formatNumber(v, "exact", column.unit, locale) : withUnit(formatNumber(v, "short", column.unit, locale), column.unit);
  }
  return column.type === "date" ? formatDate(v, locale) : v;
}

/** A column heading: "Sum of Amount (USD)", "Date (month)", "Number of rows", "Row". */
export function columnHeading(column: TableResultColumnDto): string {
  if (column.kind === "row") return "Row";
  if (column.kind === "metric" && column.op === "count" && column.label === "rows") return "Number of rows";
  return capitalize(column.label);
}

/** The card's heading and the line under it. */
export function resultHeading(r: TableResultDto, locale?: string): { title: string; detail: string } {
  const rows = r.mode === "rows" ? `${plural(r.matched, "matching row", locale)}` : `from ${plural(r.matched, "row", locale)}`;
  return { title: capitalize(r.title), detail: `${r.table} · ${rows}` };
}

/** What the card says under the result: how much of it is kept, and how the figures were worked out. */
export function resultNotes(r: TableResultDto, locale?: string): string[] {
  const notes: string[] = [];
  if (r.rows.length < r.total) {
    notes.push(
      r.mode === "rows"
        ? `Showing the first ${r.rows.length.toLocaleString(locale)} of ${plural(r.total, "matching row", locale)}.`
        : `Showing the first ${r.rows.length.toLocaleString(locale)} of ${r.total.toLocaleString(locale)} groups.`,
    );
  }
  return [...notes, ...(r.notes ?? [])];
}

// ------------------------------------------------------------------ charts

export interface ChartPoint {
  key: string;
  /** For the tooltip and the table ("March 2026"). */
  label: string;
  /** For the axis ("Mar 2026"). */
  short: string;
}

export interface LinePlan {
  kind: "line";
  points: ChartPoint[];
  /** One line, or one per value of the second grouping (name: its label). */
  series: { name: string | null; values: (number | null)[] }[];
  /** Periods with no rows count as 0 (counts and sums). */
  additive: boolean;
  notes: string[];
}

export interface BarsPlan {
  kind: "bars";
  items: { label: string; value: number | null }[];
  notes: string[];
}

export type ChartPlan = LinePlan | BarsPlan;

/** The result columns a chart can show: calculated figures that are numbers. */
export function chartMetrics(r: TableResultDto): number[] {
  if (r.mode !== "aggregate") return [];
  return r.columns.flatMap((c, i) => (c.kind === "metric" && c.type === "number" ? [i] : []));
}

const numberOf = (v: TableCell): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Every period from the first key to the last, so a line spaces time evenly and shows the periods with no rows.
 * null when a key isn't in the expected form (then the keys are used as they are), "too_many" beyond MAX_LINE_POINTS.
 */
export function fillPeriods(keys: string[], by: TableBucket): string[] | "too_many" | null {
  const sorted = [...new Set(keys)].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return null;
  const out: string[] = [];
  const push = (k: string) => {
    out.push(k);
    return out.length <= MAX_LINE_POINTS;
  };
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  switch (by) {
    case "year": {
      if (!sorted.every((k) => /^\d{4}$/.test(k))) return null;
      for (let y = Number(first); y <= Number(last); y++) if (!push(String(y))) return "too_many";
      break;
    }
    case "quarter": {
      const parse = (k: string) => /^(\d{4})-Q([1-4])$/.exec(k);
      if (!sorted.every((k) => parse(k))) return null;
      const [a, b] = [parse(first)!, parse(last)!];
      for (let i = Number(a[1]) * 4 + Number(a[2]) - 1; i <= Number(b[1]) * 4 + Number(b[2]) - 1; i++) {
        if (!push(`${Math.floor(i / 4)}-Q${(i % 4) + 1}`)) return "too_many";
      }
      break;
    }
    case "month": {
      const parse = (k: string) => /^(\d{4})-(\d{2})$/.exec(k);
      if (!sorted.every((k) => parse(k))) return null;
      const [a, b] = [parse(first)!, parse(last)!];
      for (let i = Number(a[1]) * 12 + Number(a[2]) - 1; i <= Number(b[1]) * 12 + Number(b[2]) - 1; i++) {
        if (!push(`${Math.floor(i / 12)}-${pad((i % 12) + 1)}`)) return "too_many";
      }
      break;
    }
    case "week":
    case "day": {
      if (!sorted.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))) return null;
      const step = (by === "week" ? 7 : 1) * 86_400_000;
      const [a, b] = [Date.parse(`${first}T00:00:00Z`), Date.parse(`${last}T00:00:00Z`)];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      if ((b - a) / step + 1 > MAX_LINE_POINTS) return "too_many";
      for (let t = a; t <= b; t += step) push(isoDay(t));
      break;
    }
    case "hour": {
      if (!sorted.every((k) => /^\d{2}$/.test(k) && Number(k) <= 23)) return null;
      for (let h = Number(first); h <= Number(last); h++) push(pad(h));
      break;
    }
    default:
      return null;
  }
  // Every key must be one of the periods (e.g. weeks all start on a Monday); otherwise use the keys as they are.
  const all = new Set(out);
  return sorted.every((k) => all.has(k)) ? out : null;
}

/** Sorted, filled time keys for a line, or null when there are too many to draw. */
function timeKeys(keys: string[], by: TableBucket): string[] | null {
  const filled = fillPeriods(keys, by);
  if (filled === "too_many") return null;
  return filled ?? [...new Set(keys)].sort();
}

/** The chart for one figure of a result, or null when a chart wouldn't help (see the rules at the top). */
export function chartPlan(r: TableResultDto, metric: number, locale?: string): ChartPlan | null {
  if (r.mode !== "aggregate" || r.rows.length < 2) return null;
  const column = r.columns[metric];
  if (!column || column.kind !== "metric" || column.type !== "number") return null;
  const groupCount = r.columns.filter((c) => c.kind === "group").length;
  if (groupCount === 0 || groupCount > 2) return null;
  const complete = r.rows.length >= r.total;
  const additive = column.op === "count" || column.op === "count_distinct" || column.op === "sum";
  const missing = additive ? 0 : null;
  const point = (key: string, g: TableResultColumnDto): ChartPoint => ({ key, label: groupLabel(key, g, "long", locale), short: groupLabel(key, g, "short", locale) });
  const withoutDate = (n: number) =>
    n ? [`${n === 1 ? "One group has" : `${n} groups have`} no date, so ${n === 1 ? "it isn't" : "they aren't"} in the chart (see Table).`] : [];

  if (groupCount === 1) {
    const g = r.columns[0]!;
    if (isTimeBucket(g.by)) {
      const dated = r.rows.filter((row) => typeof row[0] === "string" && row[0] !== "");
      const keys = dated.map((row) => row[0] as string);
      const ascending = keys.every((k, i) => i === 0 || keys[i - 1]! < k);
      const descending = keys.every((k, i) => i === 0 || keys[i - 1]! > k);
      if (complete || ascending || descending) {
        const all = timeKeys(keys, g.by!);
        if (!all || all.length < 2) return null;
        const byKey = new Map(dated.map((row) => [row[0] as string, numberOf(row[metric] ?? null)]));
        const values = all.map((k) => (byKey.has(k) ? byKey.get(k)! : missing));
        if (values.every((v) => v === null)) return null;
        return {
          kind: "line",
          points: all.map((k) => point(k, g)),
          series: [{ name: null, values }],
          additive,
          notes: withoutDate(r.rows.length - dated.length),
        };
      }
    }
    // Bars, in the result's order (biggest first unless asked otherwise). Numbers as groups (e.g. quantities) read
    // best in their own order when the result has them all.
    let rows = r.rows;
    if ((g.by ?? "value") === "value" && g.type === "number" && complete) {
      rows = [...rows].sort((a, b) => (numberOf(a[0] ?? null) ?? Infinity) - (numberOf(b[0] ?? null) ?? Infinity));
    }
    const items = rows.map((row) => ({ label: groupLabel(row[0] ?? null, g, "long", locale), value: numberOf(row[metric] ?? null) }));
    if (items.filter((i) => i.value !== null).length < 2) return null;
    return { kind: "bars", items, notes: [] };
  }

  // Two groupings: a date period and one other value with a few different values → one line per value.
  const [a, b] = [r.columns[0]!, r.columns[1]!];
  const t = isTimeBucket(a.by) && !isTimeBucket(b.by) ? 0 : isTimeBucket(b.by) && !isTimeBucket(a.by) ? 1 : -1;
  if (t < 0 || !complete) return null;
  const o = 1 - t;
  const time = r.columns[t]!;
  const other = r.columns[o]!;
  const dated = r.rows.filter((row) => typeof row[t] === "string" && row[t] !== "");
  const names = [...new Set(dated.map((row) => (row[o] === null ? null : String(row[o]))))];
  if (names.length < 1 || names.length > MAX_SERIES) return null;
  const all = timeKeys(dated.map((row) => row[t] as string), time.by!);
  if (!all || all.length < 2) return null;
  const series = names.map((name) => {
    const byKey = new Map(dated.filter((row) => (row[o] === null ? null : String(row[o])) === name).map((row) => [row[t] as string, numberOf(row[metric] ?? null)]));
    const values = all.map((k) => (byKey.has(k) ? byKey.get(k)! : missing));
    const total = values.reduce<number>((s, v) => s + (v ?? 0), 0);
    return { name: groupLabel(name, other, "long", locale), values, total };
  });
  // Biggest first for counts and sums (a stable, meaningful legend order); otherwise by name.
  series.sort((x, y) => (additive ? y.total - x.total : 0) || x.name.localeCompare(y.name));
  if (series.every((s) => s.values.every((v) => v === null))) return null;
  return {
    kind: "line",
    points: all.map((k) => point(k, time)),
    series: series.map(({ name, values }) => ({ name, values })),
    additive,
    notes: withoutDate(r.rows.length - dated.length),
  };
}

// ------------------------------------------------------------------ axis

/** Round tick values covering min…max: steps of 1, 2, 2.5 or 5 × a power of ten. */
export function niceScale(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo = lo === 0 ? 0 : lo - pad;
    hi = hi + pad;
  }
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude;
  const tidy = (v: number) => Number(v.toPrecision(12));
  const start = tidy(Math.floor(lo / step) * step);
  const end = tidy(Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let i = 0; tidy(start + i * step) <= end; i++) ticks.push(tidy(start + i * step));
  return { lo: start, hi: end, ticks };
}

/** Axis numbers: in full under 10,000 (0 / 2,500 / 5,000), compact from there (0 / 10K / 20K); % and currency signs kept. */
export function axisLabel(v: number, maxAbs: number, unit?: string, locale?: string): string {
  const text =
    maxAbs >= 10_000 ? new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(v) : v.toLocaleString(locale, { maximumFractionDigits: 2 });
  return unit === "%" || (unit && CURRENCY_SYMBOLS.has(unit)) ? withUnit(text, unit) : text;
}

// ------------------------------------------------------------------ CSV

/** Text Excel would run as a formula ("=…", "+…", "-…", "@…"): written with a leading apostrophe, so it stays text. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvValue(v: TableCell, column: TableResultColumnDto): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v;
  if (column.kind === "group" && column.by === "weekday") s = s.replace(/^\d\s+/, "");
  else if (column.kind === "group" && column.by === "hour" && /^\d{2}$/.test(s)) s = `${s}:00`;
  else if (column.type === "date") s = s.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/, "$1 $2");
  return FORMULA_START.test(s) ? `'${s}` : s;
}

const csvField = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The result as CSV text: a heading row, then the rows as kept, with exact values (numbers with a "." decimal point
 * and no thousands separators, dates as 2026-03-05, yes/no as Yes/No). Lines end in CRLF, as Excel expects.
 */
export function resultCsv(r: TableResultDto): string {
  const lines = [r.columns.map((c) => csvField(columnHeading(c))).join(",")];
  for (const row of r.rows) lines.push(r.columns.map((c, i) => csvField(csvValue(row[i] ?? null, c))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** "sales - sum of Amount by Region.csv": the file (and sheet) and what was calculated, safe as a file name. */
export function csvFileName(r: TableResultDto): string {
  const table = r.table.replace(/\.[a-z0-9]{2,5}(?=\s›|$)/i, "").replace(/\s›\s/g, " - ");
  const name = `${table} - ${r.title}`
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[\s.]+$/, "");
  return `${name || "result"}.csv`;
}
