/**
 * Table analysis (v0.14.0): exact figures from the spreadsheets attached to a chat.
 *
 * The model says WHAT to calculate (filters, grouping, metrics, sorting) and this module turns it into one database
 * query built only from fixed pieces: columns become positions in the stored row (numbers we control), operators and
 * date buckets come from fixed lists, and every value the model gives is a bound parameter. The model never writes
 * SQL. The database then does the arithmetic over every row (in the database, not in the Worker, so the free plan's
 * 10 ms of computing time per request isn't an issue).
 *
 * Rows are stored in blocks: data_chunks.rows = [[row number, cell, cell, …], …]. json_each() walks the rows of each
 * block and json_extract() reads a cell: '$[0]' is the spreadsheet row number, '$[k]' column k (1-based).
 */
import { z } from "zod";
import type { SourceDto, TableCell, TableColumnDto, TableColumnType, TableResultColumnDto, TableResultDto } from "../../shared/types";
import { addTableRowsRead, conversationTables, tableRowsReadToday, type TableMeta } from "../db/tables";
import { define, ToolInputError } from "./types";

export const TABLE_TOOL = "query_table";

/** The model's result must stay under the agent's 8,000-character cut, with room for the wrapping. */
const MAX_RESULT_CHARS = 7_000;
/**
 * Result rows per calculation. The model sees the first ones (up to MAX_RESULT_CHARS); the user's chart, table and
 * CSV download under the answer get them all (v0.14.1), up to MAX_KEPT_RESULT_CHARS.
 */
const DEFAULT_GROUPS = 100;
const MAX_GROUPS = 500;
const DEFAULT_ROWS = 20;
const MAX_ROWS = 200;
/** The result kept with the answer, as JSON: later rows are left out beyond this (the card says how many are kept). */
export const MAX_KEPT_RESULT_CHARS = 40_000;
/** Rows mode without a column list shows at most this many columns. */
const DEFAULT_ROW_COLUMNS = 12;

const OPS = ["=", "!=", ">", ">=", "<", "<=", "between", "in", "not_in", "contains", "not_contains", "starts_with", "is_blank", "not_blank"] as const;
type Op = (typeof OPS)[number];
const OP_ALIASES: Record<string, Op> = {
  "==": "=",
  eq: "=",
  equals: "=",
  is: "=",
  "<>": "!=",
  ne: "!=",
  not: "!=",
  not_equals: "!=",
  "is not": "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  "not in": "not_in",
  notin: "not_in",
  like: "contains",
  includes: "contains",
  "not contains": "not_contains",
  "starts with": "starts_with",
  startswith: "starts_with",
  "is blank": "is_blank",
  "is empty": "is_blank",
  is_empty: "is_blank",
  empty: "is_blank",
  is_null: "is_blank",
  "not blank": "not_blank",
  "not empty": "not_blank",
  not_empty: "not_blank",
  is_not_blank: "not_blank",
  is_not_empty: "not_blank",
  not_null: "not_blank",
  is_not_null: "not_blank",
  range: "between",
};

const BUCKETS = ["value", "year", "quarter", "month", "week", "day", "weekday", "hour"] as const;
type Bucket = (typeof BUCKETS)[number];
const BUCKET_LABEL: Record<Bucket, string> = {
  value: "",
  year: "year",
  quarter: "quarter",
  month: "month",
  week: "week starting Monday",
  day: "day",
  weekday: "weekday",
  hour: "hour of day",
};

const METRICS = ["count", "count_distinct", "sum", "avg", "min", "max", "median"] as const;
type MetricOp = (typeof METRICS)[number];
const METRIC_ALIASES: Record<string, MetricOp> = {
  average: "avg",
  mean: "avg",
  total: "sum",
  distinct: "count_distinct",
  unique: "count_distinct",
  count_unique: "count_distinct",
  distinct_count: "count_distinct",
  minimum: "min",
  maximum: "max",
};

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
/** Models sometimes send null for "not given": treat it as missing. */
const withoutNulls = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v;

const scalar = z.union([z.string().max(300), z.number(), z.boolean()]);
const columnName = z.string().trim().min(1).max(200);

const filterSchema = z.preprocess(
  (raw) => {
    const v = withoutNulls(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return v;
    const out = { ...v };
    // "in" with a list in `value`, "between" with [from, to] in `value`.
    if (Array.isArray(out.value)) {
      const list = out.value as unknown[];
      if (lower(out.op) === "between" && list.length === 2) {
        out.value = list[0];
        out.value2 = list[1];
      } else {
        out.values = list;
        delete out.value;
      }
    }
    return out;
  },
  z.object({
    column: columnName,
    op: z.preprocess((v) => {
      const op = lower(v);
      return typeof op === "string" ? (OP_ALIASES[op] ?? op) : op;
    }, z.enum(OPS)),
    value: scalar.optional(),
    value2: scalar.optional(),
    values: z.array(scalar).max(50).optional(),
  }),
);

const groupSchema = z.preprocess(
  (v) => (typeof v === "string" ? { column: v } : withoutNulls(v)),
  z.object({ column: columnName, by: z.preprocess(lower, z.enum(BUCKETS)).optional() }),
);

const metricSchema = z.preprocess(
  (v) => (typeof v === "string" ? { op: v } : withoutNulls(v)),
  z.object({
    op: z.preprocess((v) => {
      const op = lower(v);
      return typeof op === "string" ? (METRIC_ALIASES[op] ?? op) : op;
    }, z.enum(METRICS)),
    column: columnName.optional(),
  }),
);

export const tableQuerySchema = z.preprocess(
  withoutNulls,
  z.object({
    table: z.union([z.string().trim().max(200), z.number()]).optional(),
    filters: z.array(filterSchema).max(10).optional(),
    group_by: z.array(groupSchema).max(3).optional(),
    metrics: z.array(metricSchema).max(6).optional(),
    columns: z.array(columnName).max(30).optional(),
    sort_by: z.string().trim().max(200).optional(),
    descending: z.boolean().optional(),
    // More than the most a calculation returns just means "all of it".
    limit: z.preprocess((v) => (typeof v === "number" && v > MAX_GROUPS ? MAX_GROUPS : v), z.number().int().min(1)).optional(),
    describe: z.boolean().optional(),
  }),
);
export type TableQueryArgs = z.infer<typeof tableQuerySchema>;

// ------------------------------------------------------------------ values

const norm = (s: string) => s.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").toLowerCase();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const show = (v: unknown) => clip(String(v), 60);

/** "1,234.50", "$1,200", "(45)", "12%" → number; anything else → null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/[\s ,]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^(?:US\$|\$|€|£|¥|₹|Rs\.?|PKR|USD|EUR|GBP|INR)/i, "").replace(/(?:%|\$|€|£|USD|EUR|GBP|PKR|INR)$/i, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/**
 * A date written as a year, month, day or moment, in the stored form: "2026", "2026-03", "2026-03-05",
 * "2026-03-05T14:30" or "2026-03-05T14:30:00". Slashes and dots are accepted between the parts. Null otherwise.
 */
export function toDatePrefix(v: unknown): string | null {
  const s = String(v).trim();
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?)?)?$/.exec(s);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  const pad = (x: string) => x.padStart(2, "0");
  if (month === undefined) return year!;
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (day === undefined) return `${year}-${pad(month)}`;
  if (Number(day) < 1 || Number(day) > 31) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (hour === undefined) return date;
  if (Number(hour) > 23) return null;
  return `${date}T${pad(hour)}:${minute}${second !== undefined ? `:${second}` : ""}`;
}

function toBool(v: unknown): 1 | 0 | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : v;
  if (s === true || s === 1 || s === "true" || s === "yes" || s === "y" || s === "1") return 1;
  if (s === false || s === 0 || s === "false" || s === "no" || s === "n" || s === "0") return 0;
  return null;
}

// ------------------------------------------------------------------ columns and tables

interface ColumnRef {
  /** Position in the table's column list; -1 for the spreadsheet row number. */
  index: number;
  name: string;
  type: TableColumnType;
  column: TableColumnDto | null;
}

const ROW_NAMES = new Set(["_row", "row", "row number", "row_number", "_row_number", "spreadsheet row"]);

function resolveColumn(t: TableMeta, name: string): ColumnRef {
  const wanted = norm(name);
  const index = t.columns.findIndex((c) => norm(c.name) === wanted);
  if (index >= 0) return { index, name: t.columns[index]!.name, type: t.columns[index]!.type, column: t.columns[index]! };
  if (ROW_NAMES.has(wanted)) return { index: -1, name: "row", type: "number", column: null };
  throw new ToolInputError(
    `${t.ref} has no column "${clip(name, 80)}". Its columns are: ${t.columns.map((c) => JSON.stringify(c.name)).join(", ")} (and _row for the spreadsheet row number).`,
  );
}

const cellSql = (c: ColumnRef) => `json_extract(r.value, '$[${c.index + 1}]')`;

/** What a table is called under the answer: the file, plus the sheet when the file has several. */
export const tableTitle = (t: TableMeta) => (t.sheet && t.sheetsInFile > 1 ? `${t.fileName} › ${t.sheet}` : t.fileName);
const unitOf = (c: TableColumnDto | null) => (c?.unit ? ` (${c.unit})` : "");

/** The table the model means: T1/1, a file or sheet name, or the only table in the chat. */
export function pickTable(tables: TableMeta[], ref: string | number | undefined): TableMeta {
  const list = () => tables.map((t) => `${t.ref} (${tableTitle(t)})`).join(", ");
  if (ref === undefined || String(ref).trim() === "") {
    if (tables.length === 1) return tables[0]!;
    throw new ToolInputError(`Say which table to use: ${list()}.`);
  }
  const wanted = norm(String(ref));
  const numbered = /^t?\s*(\d+)$/.exec(wanted);
  if (numbered) {
    const t = tables[Number(numbered[1]) - 1];
    if (t) return t;
  }
  const named = tables.filter((t) =>
    [t.fileName, t.sheet ?? "", tableTitle(t), `${t.fileName} ${t.sheet ?? ""}`, t.fileName.replace(/\.[a-z0-9]{2,5}$/i, "")]
      .map(norm)
      .includes(wanted),
  );
  if (named.length === 1) return named[0]!;
  throw new ToolInputError(`No table "${clip(String(ref), 80)}" in this chat. Use one of: ${list()}.`);
}

// ------------------------------------------------------------------ the query

interface Params {
  values: (string | number)[];
  add(v: string | number): string;
}
function params(tableId: string): Params {
  const values: (string | number)[] = [tableId];
  return {
    values,
    add(v) {
      values.push(v);
      return `?${values.length}`;
    },
  };
}

const OP_TEXT: Record<Op, string> = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  between: "from",
  in: "is one of",
  not_in: "is none of",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  is_blank: "is empty",
  not_blank: "is not empty",
};

type Filter = NonNullable<TableQueryArgs["filters"]>[number];

function filterSql(t: TableMeta, f: Filter, p: Params): { sql: string; text: string } {
  const c = resolveColumn(t, f.column);
  const x = cellSql(c);
  const op = f.op;
  if (op === "is_blank") return { sql: `${x} IS NULL`, text: `${c.name} is empty` };
  if (op === "not_blank") return { sql: `${x} IS NOT NULL`, text: `${c.name} is not empty` };
  const many = op === "in" || op === "not_in";
  const list = many ? (f.values?.length ? f.values : f.value !== undefined ? [f.value] : []) : [];
  if (many && list.length === 0) throw new ToolInputError(`The "${op}" filter on ${c.name} needs a list in "values".`);
  if (op === "between" && (f.value === undefined || f.value2 === undefined)) {
    throw new ToolInputError(`The "between" filter on ${c.name} needs "value" (from) and "value2" (to).`);
  }
  if (!many && f.value === undefined) throw new ToolInputError(`The "${op}" filter on ${c.name} needs a "value".`);
  const a = f.value;
  const b = f.value2;
  const text = (shown: (v: unknown) => string) =>
    op === "between"
      ? `${c.name} from ${shown(a)} to ${shown(b)}`
      : many
        ? `${c.name} ${OP_TEXT[op]} ${list.map(shown).join(", ")}`
        : `${c.name} ${OP_TEXT[op]} ${shown(a)}`;
  const textOps = op === "contains" || op === "not_contains" || op === "starts_with";

  switch (c.type) {
    case "number": {
      if (textOps) throw new ToolInputError(`${c.name} holds numbers: filter it with =, !=, >, >=, <, <=, between or in.`);
      const num = (v: unknown) => {
        const n = toNumber(v);
        if (n === null) throw new ToolInputError(`${c.name} holds numbers, so its filter needs a number (got "${show(v)}").`);
        return n;
      };
      if (op === "between") return { sql: `${x} BETWEEN ${p.add(num(a))} AND ${p.add(num(b))}`, text: text(show) };
      if (many) {
        const marks = list.map((v) => p.add(num(v))).join(", ");
        return { sql: op === "in" ? `${x} IN (${marks})` : `(${x} IS NULL OR ${x} NOT IN (${marks}))`, text: text(show) };
      }
      const k = p.add(num(a));
      return { sql: op === "!=" ? `(${x} IS NULL OR ${x} != ${k})` : `${x} ${op} ${k}`, text: text(show) };
    }
    case "date": {
      if (textOps) throw new ToolInputError(`${c.name} holds dates: filter it with =, !=, >, <, between or in, using 2026, 2026-03 or 2026-03-05.`);
      const date = (v: unknown) => {
        const d = toDatePrefix(v);
        if (!d) throw new ToolInputError(`Write dates for ${c.name} like 2026, 2026-03 or 2026-03-05 (got "${show(v)}").`);
        return d;
      };
      // A date filter compares the same number of characters: "2026" means the whole year, "2026-03" the month.
      const part = (d: string) => `substr(${x}, 1, ${d.length})`;
      const equal = (d: string) => `${part(d)} = ${p.add(d)}`;
      if (op === "between") {
        const from = date(a);
        const to = date(b);
        return { sql: `(${part(from)} >= ${p.add(from)} AND ${part(to)} <= ${p.add(to)})`, text: text((v) => date(v)) };
      }
      if (many) {
        const any = `(${list.map((v) => equal(date(v))).join(" OR ")})`;
        return { sql: op === "in" ? any : `(${x} IS NULL OR NOT ${any})`, text: text((v) => date(v)) };
      }
      const d = date(a);
      if (op === "=") return { sql: equal(d), text: `${c.name} in ${d}` };
      if (op === "!=") return { sql: `(${x} IS NULL OR NOT ${equal(d)})`, text: `${c.name} not in ${d}` };
      return { sql: `${part(d)} ${op} ${p.add(d)}`, text: text(() => d) };
    }
    case "boolean": {
      const bool = (v: unknown) => {
        const n = toBool(v);
        if (n === null) throw new ToolInputError(`${c.name} holds yes/no values: use true or false (got "${show(v)}").`);
        return n;
      };
      const word = (v: unknown) => (bool(v) ? "yes" : "no");
      if (op === "=") return { sql: `${x} = ${p.add(bool(a))}`, text: `${c.name} = ${word(a)}` };
      if (op === "!=") return { sql: `(${x} IS NULL OR ${x} != ${p.add(bool(a))})`, text: `${c.name} ≠ ${word(a)}` };
      throw new ToolInputError(`${c.name} holds yes/no values: filter it with = or != (true or false).`);
    }
    default: {
      const s = (v: unknown) => String(v).trim();
      const quoted = (v: unknown) => JSON.stringify(clip(s(v), 60));
      const nocase = `${x} COLLATE NOCASE`;
      if (op === "contains") return { sql: `instr(lower(${x}), lower(${p.add(s(a))})) > 0`, text: text(quoted) };
      if (op === "not_contains") return { sql: `(${x} IS NULL OR instr(lower(${x}), lower(${p.add(s(a))})) = 0)`, text: text(quoted) };
      if (op === "starts_with") {
        const k = p.add(s(a));
        return { sql: `substr(lower(${x}), 1, length(${k})) = lower(${k})`, text: text(quoted) };
      }
      if (op === "between") return { sql: `${nocase} BETWEEN ${p.add(s(a))} AND ${p.add(s(b))}`, text: text(quoted) };
      if (many) {
        const marks = list.map((v) => p.add(s(v))).join(", ");
        return { sql: op === "in" ? `${nocase} IN (${marks})` : `(${x} IS NULL OR ${nocase} NOT IN (${marks}))`, text: text(quoted) };
      }
      const k = p.add(s(a));
      return { sql: op === "!=" ? `(${x} IS NULL OR ${nocase} != ${k})` : `${nocase} ${op} ${k}`, text: text(quoted) };
    }
  }
}

const WEEKDAY_SQL = (d: string) =>
  `CASE strftime('%w', ${d}) WHEN '1' THEN '1 Monday' WHEN '2' THEN '2 Tuesday' WHEN '3' THEN '3 Wednesday' ` +
  `WHEN '4' THEN '4 Thursday' WHEN '5' THEN '5 Friday' WHEN '6' THEN '6 Saturday' WHEN '0' THEN '7 Sunday' END`;

function bucketSql(x: string, by: Bucket): string {
  const day = `substr(${x}, 1, 10)`;
  switch (by) {
    case "year":
      return `substr(${x}, 1, 4)`;
    case "quarter":
      return `substr(${x}, 1, 4) || '-Q' || ((CAST(substr(${x}, 6, 2) AS INTEGER) + 2) / 3)`;
    case "month":
      return `substr(${x}, 1, 7)`;
    case "week":
      return `date(${day}, 'weekday 0', '-6 days')`;
    case "day":
      return day;
    case "weekday":
      return WEEKDAY_SQL(day);
    case "hour":
      return `substr(${x}, 12, 2)`;
    default:
      return x;
  }
}

interface GroupPlan {
  sql: string;
  label: string;
  name: string;
  by: Bucket;
  ref: ColumnRef;
}

function groupPlan(t: TableMeta, g: NonNullable<TableQueryArgs["group_by"]>[number]): GroupPlan {
  const c = resolveColumn(t, g.column);
  const by = g.by ?? "value";
  if (by !== "value" && c.type !== "date") throw new ToolInputError(`${c.name} isn't a date column, so it can only be grouped by value.`);
  if (by === "hour" && !c.column?.hasTime) throw new ToolInputError(`${c.name} has no times of day, so it can't be grouped by hour.`);
  return { sql: bucketSql(cellSql(c), by), label: by === "value" ? c.name : `${c.name} (${BUCKET_LABEL[by]})`, name: c.name, by, ref: c };
}

interface MetricPlan {
  op: MetricOp;
  label: string;
  /** The column it reads (null: count of rows). */
  ref: ColumnRef | null;
  /** The aggregate over the projected column `src`. */
  agg: (src: string) => string;
}

function metricPlan(t: TableMeta, m: NonNullable<TableQueryArgs["metrics"]>[number]): MetricPlan {
  if (m.op === "count" && !m.column) return { op: "count", label: "rows", ref: null, agg: () => "COUNT(*)" };
  if (!m.column) throw new ToolInputError(`The "${m.op}" metric needs a column.`);
  const c = resolveColumn(t, m.column);
  const unit = unitOf(c.column);
  const numeric = m.op === "sum" || m.op === "avg" || m.op === "median";
  if (numeric && c.type !== "number") {
    throw new ToolInputError(`${c.name} isn't a number column, so it has no ${m.op === "avg" ? "average" : m.op}. Use count, count_distinct, min or max.`);
  }
  if ((m.op === "min" || m.op === "max") && c.type === "boolean") throw new ToolInputError(`${c.name} holds yes/no values: count them instead.`);
  switch (m.op) {
    case "count":
      return { op: "count", label: `count of ${c.name} (not empty)`, ref: c, agg: (s) => `COUNT(${s})` };
    case "count_distinct":
      return { op: "count_distinct", label: `different ${c.name}`, ref: c, agg: (s) => `COUNT(DISTINCT ${s})` };
    case "sum":
      // TOTAL never overflows; empty (no numbers at all) stays empty instead of 0.
      return { op: "sum", label: `sum of ${c.name}${unit}`, ref: c, agg: (s) => `CASE WHEN COUNT(${s}) > 0 THEN TOTAL(${s}) END` };
    case "avg":
      return { op: "avg", label: `average ${c.name}${unit}`, ref: c, agg: (s) => `AVG(${s})` };
    case "min":
      return { op: "min", label: `lowest ${c.name}${unit}`, ref: c, agg: (s) => `MIN(${s})` };
    case "max":
      return { op: "max", label: `highest ${c.name}${unit}`, ref: c, agg: (s) => `MAX(${s})` };
    case "median":
      return { op: "median", label: `median ${c.name}${unit}`, ref: c, agg: () => "NULL" };
  }
}

export interface TablePlan {
  mode: "aggregate" | "rows";
  sql: string;
  params: (string | number)[];
  /** What is calculated, in plain words (shown under the answer). */
  text: string;
  /** The result's columns: labels, types (yes/no become true/false; dates stay as written), units, how they were made. */
  columns: TableResultColumnDto[];
  groups: number;
  limit: number;
  notes: string[];
}

const orderKey = (key: string, desc: boolean) => `${key} IS NULL, ${key} ${desc ? "DESC" : "ASC"}`;

/** Turn the model's request into one SQL query with bound values. Throws ToolInputError for anything it can't do. */
export function planTableQuery(t: TableMeta, args: TableQueryArgs): TablePlan {
  const p = params(t.id);
  const filters = (args.filters ?? []).map((f) => filterSql(t, f, p));
  const where = ["c.table_id = ?1", ...filters.map((f) => f.sql)].join(" AND ");
  const filterText = filters.length ? ` · where ${filters.map((f) => f.text).join(" and ")}` : "";
  const notes: string[] = [];
  const from = "FROM data_chunks c, json_each(c.rows) r";

  if (args.group_by?.length || args.metrics?.length) {
    const groups = (args.group_by ?? []).map((g) => groupPlan(t, g));
    const metrics = (args.metrics?.length ? args.metrics : [{ op: "count" as const }]).map((m) => metricPlan(t, m));
    const keys = groups.map((_, i) => `g${i}`);
    const projected = [
      ...groups.map((g, i) => `${g.sql} AS g${i}`),
      ...metrics.flatMap((m, j) => (m.ref ? [`${cellSql(m.ref)} AS m${j}`] : [])),
    ];
    const groupBy = keys.length ? ` GROUP BY ${keys.join(", ")}` : "";
    let sql = `WITH f AS (SELECT ${projected.length ? projected.join(", ") : "1 AS one"} ${from} WHERE ${where}), `;
    sql += `agg AS (SELECT ${[...keys, "COUNT(*) AS n", ...metrics.map((m, j) => `${m.agg(`m${j}`)} AS a${j}`)].join(", ")} FROM f${groupBy})`;
    // Median: the middle value (or the average of the two middle values) of each group.
    const partition = keys.length ? `PARTITION BY ${keys.join(", ")} ` : "";
    const lead = keys.length ? `${keys.join(", ")}, ` : "";
    metrics.forEach((m, j) => {
      if (m.op !== "median") return;
      sql +=
        `, med${j} AS (SELECT ${lead}AVG(m${j}) AS val FROM (SELECT ${lead}m${j}, ` +
        `ROW_NUMBER() OVER (${partition}ORDER BY m${j}) AS rn, COUNT(*) OVER (${partition.trim()}) AS cnt FROM f WHERE m${j} IS NOT NULL) ` +
        `WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)${groupBy})`;
    });
    const joins = metrics
      .map((m, j) =>
        m.op === "median" ? ` LEFT JOIN med${j} ON ${keys.length ? keys.map((k) => `med${j}.${k} IS agg.${k}`).join(" AND ") : "1"}` : "",
      )
      .join("");

    // Sorting: by a group or a metric the model names; otherwise dates in order, other groups biggest first.
    let order: string;
    const wanted = args.sort_by ? norm(args.sort_by) : null;
    if (wanted) {
      const gi = groups.findIndex((g) => norm(g.label) === wanted || norm(g.name) === wanted);
      const mi = metrics.findIndex(
        (m, j) =>
          norm(m.label) === wanted ||
          wanted === `metric${j + 1}` ||
          wanted === String(j + 1) ||
          norm(`${m.op} ${m.ref?.name ?? ""}`) === wanted ||
          norm(`${m.op} of ${m.ref?.name ?? ""}`) === wanted ||
          (m.ref !== null && norm(m.ref.name) === wanted) ||
          (m.ref === null && (wanted === "count" || wanted === "rows")),
      );
      if (gi >= 0) order = orderKey(`g${gi}`, args.descending ?? false);
      else if (mi >= 0) order = orderKey(`a${mi}`, args.descending ?? true);
      else {
        throw new ToolInputError(
          `sort_by must be one of the result columns: ${[...groups.map((g) => g.label), ...metrics.map((m) => m.label)].map((l) => JSON.stringify(l)).join(", ")}.`,
        );
      }
    } else if (groups[0] && groups[0].by !== "value") order = orderKey("g0", args.descending ?? false);
    else if (groups.length) order = orderKey("a0", args.descending ?? true);
    else order = "n";
    const tieBreak = keys.length ? `, ${keys.join(", ")}` : "";
    const limit = Math.min(args.limit ?? DEFAULT_GROUPS, MAX_GROUPS);
    const select = [
      ...keys.map((k) => `agg.${k} AS ${k}`),
      ...metrics.map((m, j) => (m.op === "median" ? `med${j}.val AS a${j}` : `agg.a${j} AS a${j}`)),
      "agg.n AS n",
      "COUNT(*) OVER () AS total_groups",
      "SUM(agg.n) OVER () AS matched",
    ];
    sql += ` SELECT ${select.join(", ")} FROM agg${joins} ORDER BY ${order}${tieBreak} LIMIT ${limit}`;

    for (const m of metrics) {
      if ((m.op === "sum" || m.op === "avg" || m.op === "median") && m.ref?.column?.blanks) {
        notes.push(`${m.ref.name} has empty cells; they are left out of the ${m.op === "avg" ? "average" : m.op}.`);
      }
    }
    const metricText = metrics.map((m) => (m.ref === null ? "number of rows" : m.label)).join(", ");
    const groupText = groups.length ? ` by ${groups.map((g) => g.label).join(" and ")}` : "";
    return {
      mode: "aggregate",
      sql,
      params: p.values,
      text: `${metricText}${groupText}${filterText}`,
      columns: [
        // A date grouped by a period comes back as text in a fixed form ("2026-03", "2026-Q1", "1 Monday"…).
        ...groups.map((g): TableResultColumnDto => ({ label: g.label, kind: "group", type: g.by === "value" ? g.ref.type : "text", by: g.by })),
        ...metrics.map((m): TableResultColumnDto => {
          // The lowest or highest value keeps its column's type (a date, a text); every other figure is a number.
          const type = m.op === "min" || m.op === "max" ? m.ref!.type : "number";
          const unit = type === "number" && m.op !== "count" && m.op !== "count_distinct" ? m.ref?.column?.unit : undefined;
          return { label: m.ref === null ? "rows" : m.label, kind: "metric", type, op: m.op, ...(unit ? { unit } : {}) };
        }),
      ],
      groups: groups.length,
      limit,
      notes: [...new Set(notes)],
    };
  }

  // Rows mode: list the matching rows (chosen columns, sorted), with their spreadsheet row numbers.
  const columns: ColumnRef[] = args.columns?.length
    ? args.columns.map((name) => resolveColumn(t, name))
    : t.columns.slice(0, DEFAULT_ROW_COLUMNS).map((column, index) => ({ index, name: column.name, type: column.type, column }));
  if (!args.columns?.length && t.columns.length > DEFAULT_ROW_COLUMNS) {
    notes.push(`Only the first ${DEFAULT_ROW_COLUMNS} of ${t.columns.length} columns are shown; pass "columns" to choose others.`);
  }
  let order = "c.seq, r.key";
  let sortText = "";
  if (args.sort_by) {
    const s = resolveColumn(t, args.sort_by);
    const desc = args.descending ?? false;
    const key = s.index < 0 ? cellSql(s) : s.type === "text" ? `${cellSql(s)} COLLATE NOCASE` : cellSql(s);
    order = `${cellSql(s)} IS NULL, ${key} ${desc ? "DESC" : "ASC"}, c.seq, r.key`;
    sortText = `, sorted by ${s.name} (${desc ? "highest" : "lowest"} first)`;
  }
  const limit = Math.min(args.limit ?? DEFAULT_ROWS, MAX_ROWS);
  const select = [`json_extract(r.value, '$[0]') AS _row`, ...columns.map((c, i) => `${cellSql(c)} AS c${i}`), "COUNT(*) OVER () AS matched"];
  return {
    mode: "rows",
    sql: `SELECT ${select.join(", ")} ${from} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`,
    params: p.values,
    text: `rows${filters.length ? ` where ${filters.map((f) => f.text).join(" and ")}` : ""}${sortText}`,
    columns: [
      { label: "row", kind: "row", type: "number" },
      ...columns.map(
        (c): TableResultColumnDto => ({
          label: `${c.name}${unitOf(c.column)}`,
          kind: "column",
          type: c.type,
          ...(c.type === "number" && c.column?.unit ? { unit: c.column.unit } : {}),
        }),
      ),
    ],
    groups: 0,
    limit,
    notes,
  };
}

// ------------------------------------------------------------------ results

/** A database value as a cell: tidy numbers (12 significant digits), true/false for yes/no columns, null when empty. */
function cleanValue(v: unknown, type: TableColumnType): TableCell {
  if (v === null || v === undefined) return null;
  if (type === "boolean" && (v === 1 || v === 0)) return v === 1;
  if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toPrecision(12));
  if (typeof v === "string" || typeof v === "boolean") return v;
  return String(v);
}

/** The query's rows as cells, in the result's columns and order. */
function resultValues(plan: TablePlan, rows: Record<string, unknown>[]): TableCell[][] {
  return rows.map((row) =>
    plan.columns.map((c, i) => {
      if (plan.mode === "rows") return cleanValue(i === 0 ? row._row : row[`c${i - 1}`], c.type);
      return cleanValue(i < plan.groups ? row[`g${i}`] : row[`a${i - plan.groups}`], c.type);
    }),
  );
}

/** Rows that matched the filters, and how many result rows there are in all (the query returns at most its limit). */
function resultCounts(plan: TablePlan, rows: Record<string, unknown>[]): { matched: number; total: number } {
  const first = rows[0];
  const matched = first ? Number(first.matched ?? 0) : 0;
  if (plan.mode === "rows") return { matched, total: matched };
  return { matched, total: plan.groups > 0 ? (first ? Number(first.total_groups ?? 0) : 0) : rows.length };
}

export interface TableResult {
  content: string;
  shown: number;
  matched: number;
}

/** The model's view of the result, kept under the size the agent passes on (rows are dropped from the end if needed). */
export function formatTableResult(t: TableMeta, plan: TablePlan, rows: Record<string, unknown>[]): TableResult {
  const { matched, total } = resultCounts(plan, rows);
  // The model sees an empty group as "(empty)", so it can talk about it.
  const values = resultValues(plan, rows).map((cells) => cells.map((v, i) => (v === null && i < plan.groups ? "(empty)" : v)));
  const base = {
    table: `${t.ref} · ${tableTitle(t)}`,
    calculation: plan.text,
    rows_in_table: t.rows,
    rows_matched: matched,
    ...(plan.mode === "aggregate" && plan.groups > 0 ? { groups: total } : {}),
    columns: plan.columns.map((c) => c.label),
  };
  let shown = values.length;
  const build = () => {
    const notes = [...plan.notes];
    if (shown < total) {
      notes.push(
        plan.mode === "rows"
          ? `Showing ${shown} of the ${total.toLocaleString("en-US")} matching rows.`
          : `Showing ${shown} of ${total.toLocaleString("en-US")} groups (in the sort order).`,
      );
    }
    if (matched === 0) notes.push("No rows match these filters.");
    return JSON.stringify({ ...base, rows: values.slice(0, shown), ...(notes.length ? { notes } : {}) });
  };
  let content = build();
  while (content.length > MAX_RESULT_CHARS && shown > 1) {
    shown = Math.max(1, Math.floor(shown * 0.8));
    content = build();
  }
  return { content, shown, matched };
}

/**
 * The whole result for the user (v0.14.1): kept with the answer and shown under it as a chart or table with a CSV
 * download. Exact values; an empty group stays null. Rows are left out from the end only beyond MAX_KEPT_RESULT_CHARS
 * (`total` still says how many there are, so the card can say "the first N of M").
 */
export function tableResultDto(t: TableMeta, plan: TablePlan, rows: Record<string, unknown>[]): TableResultDto {
  const { matched, total } = resultCounts(plan, rows);
  const values = resultValues(plan, rows);
  const base: TableResultDto = {
    table: tableTitle(t),
    title: plan.text,
    mode: plan.mode,
    columns: plan.columns,
    rows: [],
    total,
    matched,
    ...(plan.notes.length ? { notes: plan.notes } : {}),
  };
  let room = MAX_KEPT_RESULT_CHARS - JSON.stringify(base).length;
  let kept = 0;
  for (const cells of values) {
    room -= JSON.stringify(cells).length + 1; // the row and its comma
    if (room < 0) break;
    kept++;
  }
  return { ...base, rows: values.slice(0, kept) };
}

// ------------------------------------------------------------------ the overview (system prompt and describe)

const fmt = (v: number | string | undefined) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v ?? ""));
const q = (s: string, max = 40) => JSON.stringify(clip(s, max));

function columnLine(c: TableColumnDto, detail: 0 | 1 | 2): string {
  const parts: string[] = [];
  const empty = c.blanks ? `, ${c.blanks.toLocaleString("en-US")} empty` : "";
  const invalid = c.invalid ? ` (${c.invalid.toLocaleString("en-US")} of them unreadable as ${c.type === "date" ? "dates" : "numbers"})` : "";
  switch (c.type) {
    case "number":
      parts.push(`number${c.unit ? ` in ${c.unit}` : ""}`, `${fmt(c.min)} to ${fmt(c.max)}`);
      break;
    case "date":
      parts.push(`date${c.hasTime ? " and time" : ""}`, `${fmt(c.min)} to ${fmt(c.max)}`);
      if (c.dateOrder) parts.push(`read as ${c.dateOrder === "dmy" ? "day/month/year" : "month/day/year"}`);
      break;
    case "boolean":
      parts.push("yes/no");
      break;
    default:
      parts.push(`text, ${c.distinct.toLocaleString("en-US")} different`);
  }
  if (detail < 2 && c.top?.length) {
    const top = c.top.slice(0, detail === 0 ? 8 : 4);
    parts.push(`${c.top.length > top.length || c.distinct > top.length ? "most common" : "values"}: ${top.map((v) => `${q(v.value)} ${v.count.toLocaleString("en-US")}`).join(", ")}`);
  } else if (detail < 2 && c.examples?.length) {
    parts.push(`e.g. ${c.examples.slice(0, detail === 0 ? 3 : 2).map((v) => q(v)).join(", ")}`);
  }
  return `- ${q(c.name, 60)}: ${parts.join("; ")}${empty}${invalid}`;
}

/**
 * A table's overview for the model: name, size, each column's type and range, common values, example rows and the
 * notes from reading. Shortened step by step to fit `budget` characters.
 */
export function tableOverview(t: TableMeta, budget: number): string {
  const head = `${t.ref} · file ${q(t.fileName, 80)}${t.sheet ? `, sheet ${q(t.sheet, 60)}` : ""} · ${t.rows.toLocaleString("en-US")} rows (spreadsheet rows ${t.firstRow.toLocaleString("en-US")}–${t.lastRow.toLocaleString("en-US")}) · ${t.columns.length} columns`;
  const notes = t.notes.slice(0, 5).map((n) => `  Note: ${clip(n, 300)}`);
  const sample = (count: number) => {
    if (count === 0 || t.samples.length === 0) return [];
    const cols = t.columns.slice(0, 12);
    return [
      `  Example rows (${cols.map((c) => clip(c.name, 20)).join(" | ")}${t.columns.length > cols.length ? " | …" : ""}):`,
      ...t.samples.slice(0, count).map((row) => `    ${cols.map((_, i) => clip(row[i] === null || row[i] === undefined ? "" : String(row[i]), 30)).join(" | ")}`),
    ];
  };
  const levels: [0 | 1 | 2, number][] = [
    [0, 3],
    [1, 2],
    [2, 0],
  ];
  for (const [detail, samples] of levels) {
    const text = [head, ...t.columns.map((c) => columnLine(c, detail)), ...sample(samples), ...notes].join("\n");
    if (text.length <= budget) return text;
  }
  const names = `  Columns: ${t.columns.map((c) => `${q(c.name, 40)} (${c.type})`).join(", ")}`;
  return clip([head, names, `  (Call ${TABLE_TOOL} with describe: true for the full overview.)`, ...notes].join("\n"), Math.max(budget, 400));
}

/** Rows the database is expected to read for one calculation on this table: each row twice, plus its blocks. */
export const estimatedRowsRead = (t: TableMeta) => 2 * t.rows + Math.ceil(t.rows / 500);

// ------------------------------------------------------------------ the tool

export const queryTable = define({
  name: TABLE_TOOL,
  label: "Table analysis",
  description:
    "Calculate exact figures from a spreadsheet the user attached to this chat (tables T1, T2… are listed in your instructions), over every row. " +
    "Use it for every figure you give from a file: totals, averages, counts, top or bottom items, comparisons, trends, and to look up or list rows. " +
    "With metrics and/or group_by it calculates; without them it lists matching rows (choose columns, sort_by, descending, limit). " +
    "Filters: =, !=, >, >=, <, <=, between (value to value2), in / not_in (values), contains, not_contains, starts_with, is_blank, not_blank. " +
    "Text matching ignores upper/lower case. Dates are filtered with a year (2026), month (2026-03) or day (2026-03-05), each meaning the whole period. " +
    "Negative filters (!=, not_in, not_contains) keep empty cells. Use the column name _row for the spreadsheet row number. " +
    "describe: true returns the table's full column overview. " +
    "The user sees each result in full under your answer, as a chart when it suits (dates in order as a line, other groups as bars) or a table, with a CSV download; you see the first part of a long result.",
  risk: "read",
  requiresMemory: false,
  // Offered only in chats that have a spreadsheet (and in the tool lists when the admin has spreadsheets on).
  isAvailable: (server) => server.tables === true,
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", description: 'Which table, e.g. "T1" (optional when the chat has only one).' },
      filters: {
        type: "array",
        description: "Rows to include (all filters must match).",
        items: {
          type: "object",
          properties: {
            column: { type: "string", description: "Column name exactly as listed." },
            op: { type: "string", enum: [...OPS] },
            value: { type: "string", description: "The value to compare with (a number, a date such as 2026-03, or text)." },
            value2: { type: "string", description: 'The upper end for "between".' },
            values: { type: "array", items: { type: "string" }, description: 'The list for "in" / "not_in".' },
          },
          required: ["column", "op"],
        },
      },
      group_by: {
        type: "array",
        description: "Columns to group by (up to 3). Dates can be grouped by year, quarter, month, week, day, weekday or hour.",
        items: {
          type: "object",
          properties: { column: { type: "string" }, by: { type: "string", enum: [...BUCKETS] } },
          required: ["column"],
        },
      },
      metrics: {
        type: "array",
        description: 'What to calculate, e.g. [{"op":"sum","column":"Amount"}]. count without a column counts rows.',
        items: {
          type: "object",
          properties: { op: { type: "string", enum: [...METRICS] }, column: { type: "string" } },
          required: ["op"],
        },
      },
      columns: { type: "array", items: { type: "string" }, description: "Listing rows: the columns to show." },
      sort_by: { type: "string", description: "A column (listing rows), or a group or metric label such as \"sum of Amount\"." },
      descending: { type: "boolean", description: "Largest or latest first." },
      limit: {
        type: "integer",
        description: `How many result rows (default ${DEFAULT_GROUPS} groups or ${DEFAULT_ROWS} listed rows; at most ${MAX_GROUPS} groups or ${MAX_ROWS} listed rows, e.g. for a list the user wants to download).`,
      },
      describe: { type: "boolean", description: "Return the full column overview instead of calculating." },
    },
  },
  schema: tableQuerySchema,
  async run(args, ctx) {
    if (!ctx.conversationId) throw new ToolInputError("No spreadsheet is attached to this chat.");
    const tables = await conversationTables(ctx.db, ctx.userId, ctx.conversationId);
    if (tables.length === 0) throw new ToolInputError("No spreadsheet is attached to this chat. Ask the user to attach one.");
    const t = pickTable(tables, args.table);
    const source = (location: string): SourceDto => ({ title: tableTitle(t), location: clip(location, 120), kind: "table" });
    if (args.describe) {
      return {
        content: JSON.stringify({ table: `${t.ref} · ${tableTitle(t)}`, overview: tableOverview(t, MAX_RESULT_CHARS - 200) }),
        summary: `Described ${t.ref} (${t.columns.length} columns)`,
        sources: [source("column overview")],
      };
    }
    const plan = planTableQuery(t, args);
    // The free database allows 5 million rows read a day for the whole app (and refuses everything after that), so
    // calculations stay within their own daily share. A question reads each row about twice (scan, then group or
    // sort); the real count from the database is added afterwards.
    const budget = ctx.tables?.rowsPerDay ?? Number.POSITIVE_INFINITY;
    const estimate = estimatedRowsRead(t);
    if ((await tableRowsReadToday(ctx.db)) + estimate > budget) {
      throw new ToolInputError(
        "Spreadsheet calculations have used today's allowance for the whole app (it keeps the free database within its daily limit). " +
          "Tell the user it starts again at 00:00 UTC, and don't give figures from the file until then.",
      );
    }
    const { results, meta } = await ctx.db
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<Record<string, unknown>>();
    await addTableRowsRead(ctx.db, typeof meta?.rows_read === "number" ? meta.rows_read : estimate);
    const result = formatTableResult(t, plan, results);
    return {
      content: result.content,
      summary: `${t.ref}: ${plan.text} → ${result.shown} result row${result.shown === 1 ? "" : "s"} (${result.matched.toLocaleString("en-US")} matching rows)`,
      sources: [source(plan.text)],
      // The whole result goes under the answer as a chart or table with a CSV download.
      table: tableResultDto(t, plan, results),
    };
  },
});
