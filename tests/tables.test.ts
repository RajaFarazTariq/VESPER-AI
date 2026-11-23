/**
 * v0.14.0: spreadsheets in chat (data analysis). Reading CSV/Excel files, the Table analysis tool's calculations on a
 * real local D1, the upload API with its limits, and a chat turn where the (faked) model asks for a calculation.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { SseParser } from "../src/shared/sse";
import { TABLE_LIMITS } from "../src/shared/tables";
import { DEFAULT_SETTINGS, type ChatStreamEvent } from "../src/shared/types";
import { app } from "../src/worker/app";
import { createConversation } from "../src/worker/db/conversations";
import { cleanup } from "../src/worker/db/provider-state";
import { addTableChunks, completeTableFile, conversationTables, createTableFile, linkTableFiles, tableRowsReadToday } from "../src/worker/db/tables";
import { clearModelMemoryCache } from "../src/worker/llm/catalog";
import { buildSystemPrompt } from "../src/worker/llm/context";
import { estimatedRowsRead, planTableQuery, queryTable, tableOverview, toDatePrefix } from "../src/worker/tools/tables";
import { excelDate, readTableFile } from "../src/web/lib/table-file";
import { buildFile, csvSheet, parseCsv, parseNumberText, sniffDelimiter, utf8Bytes, type ReadFile } from "../src/web/lib/table-read";

const ORIGIN = "http://localhost";
const MODEL = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" };

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), { ...env, ...MODEL }, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}
async function login(name: string) {
  const { response } = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: name }) });
  const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  const me = await call("/api/auth/me", { cookie });
  return { cookie, id: me.json.user.id as string };
}
const post = (path: string, body: unknown, cookie: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const sse = (chunks: object[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const toolCall = (name: string, args: object) =>
  sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_t1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }]);
const answer = (t: string) => sse([{ choices: [{ delta: { content: t } }] }]);
const events = (body: string) => {
  const p = new SseParser();
  return [...p.feed(body), ...p.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
};

const opts = { preferMdy: false };
const csvFile = (name: string, text: string): ReadFile => buildFile({ name, kind: "csv", bytes: text.length, sheets: [csvSheet(text)] }, opts);

/** Eight sales rows (header is spreadsheet row 1). Amount: one empty; Region: "north" in lower case once. */
const SALES = [
  "Date,Region,Amount,Units,Paid",
  "2026-01-05,North,100,1,TRUE",
  "2026-01-20,South,250.5,2,FALSE",
  "2026-02-03,North,300,3,TRUE",
  "2026-02-14,East,,4,TRUE",
  "2026-02-28,South,50,5,FALSE",
  "2026-03-01,North,125.25,6,TRUE",
  "2026-03-15,north,74.75,7,TRUE",
  "2025-12-31,West,1000,8,FALSE",
].join("\n");

/** Store a read file for a user, as the upload API would, and attach it to a chat. */
async function seed(userId: string, read: ReadFile, conversationId?: string) {
  const file = await createTableFile(env.DB, userId, {
    name: read.name,
    kind: read.kind,
    bytes: read.bytes,
    tables: read.tables.map(({ blocks, ...t }) => ({ ...t, chunks: blocks.length })),
  });
  for (const [i, t] of read.tables.entries()) {
    for (const [seq, rows] of t.blocks.entries()) await addTableChunks(env.DB, userId, file.id, file.tables[i]!.id, [{ seq, rows }]);
  }
  await completeTableFile(env.DB, userId, file.id);
  if (conversationId) await linkTableFiles(env.DB, userId, [file.id], conversationId);
  return file;
}

/** A user with the sales file in a chat, and a way to run the tool there. */
async function salesChat() {
  const user = await login("ann");
  const conversation = await createConversation(env.DB, user.id, "Sales", "auto");
  await seed(user.id, csvFile("sales.csv", SALES), conversation.id);
  const run = async (args: object) => {
    const out = await queryTable.run(queryTable.schema.parse(args), {
      db: env.DB,
      userId: user.id,
      settings: DEFAULT_SETTINGS,
      now: new Date(),
      conversationId: conversation.id,
    });
    return { ...out, result: JSON.parse(out.content) };
  };
  return { user, conversation, run };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearModelMemoryCache();
});

describe("reading spreadsheets", () => {
  it("reads a CSV: title rows, separators, quotes, decimal commas, percentages, day/month dates, codes, a totals row", () => {
    const text = [
      "Sales report 2026",
      "",
      "Date;Region;Amount;Margin;Code;Paid;Note",
      '05/03/2026;North;"1.234,50";12,5%;00123;TRUE;"two\nlines"',
      "13/03/2026;South;99;7%;00124;FALSE;-",
      '20/03/2026;North;(10);n/a;00125;TRUE;"He said ""hi"""',
      "Total;;1.323,50;;;;",
    ].join("\r\n");
    expect(sniffDelimiter(text)).toBe(";");
    const [t] = csvFile("report.csv", text).tables;
    expect(t!.columns.map((c) => [c.name, c.type])).toEqual([
      ["Date", "date"],
      ["Region", "text"],
      ["Amount", "number"],
      ["Margin", "number"],
      ["Code", "text"],
      ["Paid", "boolean"],
      ["Note", "text"],
    ]);
    expect(t!.rows).toBe(3);
    expect([t!.firstRow, t!.lastRow]).toEqual([4, 6]);
    // [row number, cells…]: numbers cleaned, dates read day-first (13/03 can only be that), "n/a" and "-" empty.
    expect(t!.blocks[0]).toEqual([
      [4, "2026-03-05", "North", 1234.5, 12.5, "00123", true, "two\nlines"],
      [5, "2026-03-13", "South", 99, 7, "00124", false, null],
      [6, "2026-03-20", "North", -10, null, "00125", true, 'He said "hi"'],
    ]);
    const margin = t!.columns[3]!;
    expect(margin).toMatchObject({ unit: "%", blanks: 1, min: 7, max: 12.5 });
    expect(t!.columns[0]).toMatchObject({ dateOrder: "dmy", min: "2026-03-05", max: "2026-03-20" });
    expect(t!.columns[1]!.top).toEqual([
      { value: "North", count: 2 },
      { value: "South", count: 1 },
    ]);
    expect(t!.notes.join(" ")).toContain('Row 7 ("Total") looks like a totals row and was left out');
    expect(t!.notes.join(" ")).toContain("Row 1 above the header (titles) was skipped");
  });

  it("understands numbers and dates as people write them", () => {
    expect(parseNumberText("$1,200.50")).toEqual({ v: 1200.5, unit: "$" });
    expect(parseNumberText("1 200 PKR")).toEqual({ v: 1200, unit: "PKR" });
    expect(parseNumberText("-$45")).toEqual({ v: -45, unit: "$" });
    expect(parseNumberText("(3.5)")).toEqual({ v: -3.5 });
    expect(parseNumberText("1.2E+3")).toEqual({ v: 1200 });
    expect(parseNumberText("12,5", true)).toEqual({ v: 12.5 });
    expect(parseNumberText("12 apples")).toBeNull();
    expect(parseNumberText("2026-03-05")).toBeNull();
    expect(parseCsv('a,"b,c",d\n1,2,3', ",")).toEqual([
      ["a", "b,c", "d"],
      ["1", "2", "3"],
    ]);
    // Month first only when the file shows it (a second part over 12) or the browser is US English.
    const us = buildFile({ name: "us.csv", kind: "csv", bytes: 1, sheets: [csvSheet("When,N\n03/04/2026,1\n03/25/2026 2:30 PM,2")] }, opts);
    expect(us.tables[0]!.blocks[0]!.map((r) => r[1])).toEqual(["2026-03-04T00:00:00", "2026-03-25T14:30:00"]);
    expect(us.tables[0]!.columns[0]).toMatchObject({ type: "date", hasTime: true, dateOrder: "mdy" });
    const ambiguous = (preferMdy: boolean) =>
      buildFile({ name: "a.csv", kind: "csv", bytes: 1, sheets: [csvSheet("When,N\n03/04/2026,1\n05/06/2026,2")] }, { preferMdy }).tables[0]!.blocks[0]![0]![1];
    expect(ambiguous(false)).toBe("2026-04-03");
    expect(ambiguous(true)).toBe("2026-03-04");
    const named = csvFile("n.csv", "Day,N\n5 Mar 2026,1\n\"March 6, 2026\",2\n31-Dec-25,3");
    expect(named.tables[0]!.blocks[0]!.map((r) => r[1])).toEqual(["2026-03-05", "2026-03-06", "2025-12-31"]);
    // A column that is mostly text stays text; no header row gets letter names.
    const noHeader = csvFile("x.csv", "1,2\n3,4");
    expect(noHeader.tables[0]!.columns.map((c) => c.name)).toEqual(["Column A", "Column B"]);
    expect(() => csvFile("e.csv", "\n\n")).toThrow(/no rows of data/);
  });

  it("reads Excel: real dates, percentages, currency, several sheets, hidden sheets skipped", async () => {
    const wb = XLSX.utils.book_new();
    // Excel stores dates as day numbers with a date format (no time zone): 46037 is 15 Jan 2026, .6041… is 14:30.
    const sales = XLSX.utils.aoa_to_sheet([
      ["Day", "Sales", "Share", "Booked at"],
      [46037, 1200.5, 0.25, 46037 + 14.5 / 24],
      [46054, 300, 0.1, 46054 + 9 / 24],
    ]);
    for (const ref of ["A2", "A3"]) sales[ref].z = "d-mmm-yy";
    for (const ref of ["B2", "B3"]) sales[ref].z = '"$"#,##0.00';
    for (const ref of ["C2", "C3"]) sales[ref].z = "0%";
    for (const ref of ["D2", "D3"]) sales[ref].z = "yyyy-mm-dd hh:mm";
    XLSX.utils.book_append_sheet(wb, sales, "Sales");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Secret"], [1]]), "Hidden");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Team", "Size"], ["Ops", 4], ["Sales", 7], ["TOTAL", 11]]), "Teams");
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] };
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const read = await readTableFile(new File([bytes], "book.xlsx"), opts);
    expect(read.tables.map((t) => [t.sheet, t.rows])).toEqual([
      ["Sales", 2],
      ["Teams", 2],
    ]);
    const [s, teams] = read.tables;
    expect(s!.columns.map((c) => [c.name, c.type, c.unit ?? null])).toEqual([
      ["Day", "date", null],
      ["Sales", "number", "$"],
      ["Share", "number", "%"],
      ["Booked at", "date", null],
    ]);
    expect(s!.blocks[0]).toEqual([
      [2, "2026-01-15", 1200.5, 25, "2026-01-15T14:30:00"],
      [3, "2026-02-01", 300, 10, "2026-02-01T09:00:00"],
    ]);
    expect(s!.notes.join(" ")).toContain('hidden sheet "Hidden" was skipped');
    expect(teams!.notes.join(" ")).toContain("totals row");
  });

  it("turns Excel day numbers into dates (1900 and 1904 systems)", () => {
    expect(excelDate(1, false)).toEqual({ date: "1900-01-01", time: null });
    expect(excelDate(61, false)).toEqual({ date: "1900-03-01", time: null });
    expect(excelDate(46036.5, false)).toEqual({ date: "2026-01-14", time: "12:00:00" });
    expect(excelDate(0, true)).toEqual({ date: "1904-01-01", time: null });
    expect(toDatePrefix("2026/3/5")).toBe("2026-03-05");
    expect(toDatePrefix(2026)).toBe("2026");
    expect(toDatePrefix("2026-13")).toBeNull();
  });

  it("keeps every upload block under 200,000 bytes, also for Urdu text", () => {
    expect(utf8Bytes("aé€😀")).toBe(10);
    const urdu = "یہ ایک لمبا تبصرہ ہے جو اردو میں لکھا گیا ہے۔ ".repeat(8);
    const read = csvFile("urdu.csv", ["Note,N", ...Array.from({ length: 2_000 }, (_, i) => `${urdu},${i}`)].join("\n"));
    const blocks = read.tables[0]!.blocks;
    expect(blocks.length).toBeGreaterThan(4);
    for (const block of blocks) expect(new TextEncoder().encode(JSON.stringify(block)).length).toBeLessThanOrEqual(TABLE_LIMITS.chunkBytes);
    expect(blocks.flat().length).toBe(2_000);
  });

  it("refuses files over the row limit", () => {
    const rows = ["N", ...Array.from({ length: TABLE_LIMITS.rows + 1 }, (_, i) => String(i))].join("\n");
    expect(() => csvFile("big.csv", rows)).toThrow(/50,001 rows of data; the limit is 50,000/);
  });
});

describe("Table analysis: exact figures from every row", () => {
  it("adds up, averages, counts and finds the median, with filters", async () => {
    const { run } = await salesChat();
    const all = await run({ metrics: [{ op: "sum", column: "Amount" }, { op: "avg", column: "Amount" }, { op: "median", column: "Amount" }, "count", { op: "count", column: "Amount" }, { op: "count_distinct", column: "Region" }] });
    expect(all.result.rows).toEqual([[1900.5, 271.5, 125.25, 8, 7, 5]]);
    expect(all.result.notes).toContain("Amount has empty cells; they are left out of the sum.");
    // Text matches ignore case ("north" counts as North); dates filter by year, month or day.
    expect((await run({ filters: [{ column: "Region", op: "=", value: "NORTH" }], metrics: [{ op: "sum", column: "Amount" }] })).result.rows).toEqual([[600]]);
    expect((await run({ filters: [{ column: "Date", op: "=", value: "2026" }], metrics: [{ op: "sum", column: "Amount" }] })).result.rows).toEqual([[900.5]]);
    expect(
      (await run({ filters: [{ column: "Date", op: "between", value: "2026-01", value2: "2026-02" }], metrics: ["count", { op: "sum", column: "Amount" }] })).result.rows,
    ).toEqual([[5, 700.5]]);
    expect((await run({ filters: [{ column: "Paid", op: "=", value: true }], metrics: ["count", { op: "sum", column: "Units" }] })).result.rows).toEqual([[5, 21]]);
    expect((await run({ filters: [{ column: "Region", op: "not_in", values: ["North", "south"] }], metrics: ["count"] })).result.rows).toEqual([[2]]);
    expect((await run({ filters: [{ column: "Region", op: "contains", value: "ORT" }], metrics: ["count"] })).result.rows).toEqual([[4]]);
    expect((await run({ filters: [{ column: "Amount", op: "is_blank" }], metrics: ["count"] })).result.rows).toEqual([[1]]);
    const none = await run({ filters: [{ column: "Amount", op: ">", value: "5,000" }], metrics: [{ op: "sum", column: "Amount" }] });
    expect(none.result).toMatchObject({ rows: [[null]], rows_matched: 0, notes: expect.arrayContaining(["No rows match these filters."]) });
  });

  it("groups by value and by date (month, quarter, week, weekday), sorted sensibly", async () => {
    const { run } = await salesChat();
    const byRegion = await run({ group_by: ["Region"], metrics: [{ op: "sum", column: "Amount" }, { op: "median", column: "Amount" }] });
    // Biggest first; an empty sum stays empty (not 0); medians per group.
    expect(byRegion.result.columns).toEqual(["Region", "sum of Amount", "median Amount"]);
    expect(byRegion.result.rows).toEqual([
      ["West", 1000, 1000],
      ["North", 525.25, 125.25],
      ["South", 300.5, 150.25],
      ["north", 74.75, 74.75],
      ["East", null, null],
    ]);
    expect(byRegion.result.groups).toBe(5);
    const byMonth = await run({ group_by: [{ column: "Date", by: "month" }], metrics: [{ op: "sum", column: "Amount" }] });
    expect(byMonth.result.rows).toEqual([
      ["2025-12", 1000],
      ["2026-01", 350.5],
      ["2026-02", 350],
      ["2026-03", 200],
    ]);
    expect((await run({ group_by: [{ column: "Date", by: "quarter" }], metrics: [{ op: "sum", column: "Amount" }] })).result.rows).toEqual([
      ["2025-Q4", 1000],
      ["2026-Q1", 900.5],
    ]);
    const weeks = await run({ filters: [{ column: "Date", op: "=", value: "2026-01" }], group_by: [{ column: "Date", by: "week" }], metrics: ["count"] });
    expect(weeks.result.rows).toEqual([
      ["2026-01-05", 1],
      ["2026-01-19", 1],
    ]);
    const weekdays = await run({ group_by: [{ column: "Date", by: "weekday" }], metrics: ["count"], sort_by: "Date (weekday)" });
    expect(weekdays.result.rows[0]).toEqual(["1 Monday", 1]);
    const sorted = await run({ group_by: ["Region"], metrics: [{ op: "sum", column: "Amount" }], sort_by: "sum of Amount", descending: false, limit: 2 });
    expect(sorted.result.rows).toEqual([
      ["north", 74.75],
      ["South", 300.5],
    ]);
    expect(sorted.result.notes).toContain("Showing 2 of 5 groups (in the sort order).");
  });

  it("lists matching rows with their spreadsheet row numbers, and says what it calculated under the answer", async () => {
    const { run } = await salesChat();
    const top = await run({ columns: ["Date", "Region", "Amount"], sort_by: "Amount", descending: true, limit: 2 });
    expect(top.result.columns).toEqual(["row", "Date", "Region", "Amount"]);
    expect(top.result.rows).toEqual([
      [9, "2025-12-31", "West", 1000],
      [4, "2026-02-03", "North", 300],
    ]);
    expect(top.result.rows_matched).toBe(8);
    expect(top.sources).toEqual([{ title: "sales.csv", location: "rows, sorted by Amount (highest first)", kind: "table" }]);
    const grouped = await run({ filters: [{ column: "Date", op: "=", value: "2026" }], group_by: ["Region"], metrics: [{ op: "sum", column: "Amount" }] });
    expect(grouped.sources![0]!.location).toBe("sum of Amount by Region · where Date in 2026");
    const byRow = await run({ filters: [{ column: "_row", op: "<=", value: 3 }], columns: ["Region"] });
    expect(byRow.result.rows).toEqual([
      [2, "North"],
      [3, "South"],
    ]);
  });

  it("explains mistakes instead of guessing, and never runs the model's text as SQL", async () => {
    const { user, conversation, run } = await salesChat();
    await expect(run({ metrics: [{ op: "sum", column: "Price" }] })).rejects.toThrow(/T1 has no column "Price"\. Its columns are: "Date", "Region", "Amount", "Units", "Paid"/);
    await expect(run({ metrics: [{ op: "sum", column: "Region" }] })).rejects.toThrow(/isn't a number column/);
    await expect(run({ filters: [{ column: "Amount", op: "contains", value: "1" }] })).rejects.toThrow(/holds numbers/);
    await expect(run({ filters: [{ column: "Date", op: ">", value: "last week" }] })).rejects.toThrow(/like 2026, 2026-03 or 2026-03-05/);
    await expect(run({ group_by: [{ column: "Region", by: "month" }] })).rejects.toThrow(/isn't a date column/);
    await expect(run({ table: "T7" })).rejects.toThrow(/No table "T7"/);
    // Text with SQL in it is only ever a value to compare with.
    const sneaky = await run({ filters: [{ column: "Region", op: "=", value: "x' OR 1=1; DROP TABLE data_chunks; --" }], metrics: ["count"] });
    expect(sneaky.result.rows).toEqual([[0]]);
    await expect(run({ metrics: [{ op: "count", column: 'Region"); DROP TABLE data_chunks; --' }] })).rejects.toThrow(/no column/);
    expect((await run({ metrics: ["count"] })).result.rows).toEqual([[8]]);
    const plan = planTableQuery((await conversationTables(env.DB, user.id, conversation.id))[0]!, {
      filters: [{ column: "Region", op: "=", value: "x'--" }],
      metrics: [{ op: "count" }],
    });
    expect(plan.sql).not.toContain("x'--");
    expect(plan.params).toContain("x'--");
  });

  it("keeps calculations within their daily share of the free database", async () => {
    const { user, conversation } = await salesChat();
    const ctx = (rowsPerDay: number) => ({
      db: env.DB,
      userId: user.id,
      settings: DEFAULT_SETTINGS,
      now: new Date(),
      conversationId: conversation.id,
      tables: { rowsPerDay },
    });
    const args = queryTable.schema.parse({ metrics: ["count"] });
    await queryTable.run(args, ctx(1_000));
    // The database's own count was added (8 rows, read about twice, plus the block).
    const used = await tableRowsReadToday(env.DB);
    expect(used).toBeGreaterThanOrEqual(8);
    expect(used).toBeLessThanOrEqual(estimatedRowsRead((await conversationTables(env.DB, user.id, conversation.id))[0]!) + 5);
    await expect(queryTable.run(args, ctx(used + 5))).rejects.toThrow(/used today's allowance for the whole app/);
    const admin = await login("octocat");
    expect((await call("/api/admin/settings", { cookie: admin.cookie })).json.tables.rowsReadToday).toBe(used);
  });

  it("works through 50,000 rows inside the database", async () => {
    const user = await login("bob");
    const conversation = await createConversation(env.DB, user.id, "Big", "auto");
    const lines = ["Day,Group,Value", ...Array.from({ length: TABLE_LIMITS.rows }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")},G${i % 4},${i % 100}`)];
    const read = csvFile("big.csv", lines.join("\n"));
    expect(read.tables[0]!.blocks).toHaveLength(100);
    await seed(user.id, read, conversation.id);
    const [table] = await conversationTables(env.DB, user.id, conversation.id);
    const plan = planTableQuery(table!, { group_by: [{ column: "Group" }], metrics: [{ op: "sum", column: "Value" }, { op: "avg", column: "Value" }], sort_by: "Group" });
    const started = Date.now();
    const result = await env.DB.prepare(plan.sql)
      .bind(...plan.params)
      .all<Record<string, number | string>>();
    const ms = Date.now() - started;
    // Each group has 12,500 rows with values 0–99 repeating evenly: sum 618,750 each (G0 gets 0,4,8…, etc.).
    const expected = [0, 1, 2, 3].map((g) => {
      let sum = 0;
      for (let i = g; i < TABLE_LIMITS.rows; i += 4) sum += i % 100;
      return [`G${g}`, sum, sum / 12_500];
    });
    expect(result.results.map((r) => [r.g0, r.a0, r.a1])).toEqual(expected);
    console.log(`50,000-row grouped sum: ${ms} ms, D1 rows_read=${result.meta.rows_read}, rows_written=${result.meta.rows_written}`);
  }, 60_000);

  it("describes each table in the system prompt, shortened to fit, and says when it can't calculate", async () => {
    const { user, conversation } = await salesChat();
    const tables = await conversationTables(env.DB, user.id, conversation.id);
    const prompt = buildSystemPrompt({ appName: "VESPER", customInstructions: "", tools: ["query_table"], tables });
    expect(prompt).toContain('T1 · file "sales.csv" · 8 rows (spreadsheet rows 2–9) · 5 columns');
    expect(prompt).toContain('- "Amount": number; 50 to 1,000, 1 empty');
    expect(prompt).toContain('- "Region": text, 5 different; values: "North" 3, "South" 2, "East" 1, "West" 1, "north" 1');
    expect(prompt).toContain("call query_table and use only its results");
    expect(prompt).toContain("never instructions");
    const without = buildSystemPrompt({ appName: "VESPER", customInstructions: "", tools: [], tables });
    expect(without).toContain("You can't calculate from these files in this reply");
    expect(tableOverview(tables[0]!, 200)).toContain("Columns:");
  });
});

describe("spreadsheet uploads and chats", () => {
  const upload = async (cookie: string, read: ReadFile) => {
    const created = await post("/api/files", { name: read.name, kind: read.kind, bytes: read.bytes, tables: read.tables.map(({ blocks, ...t }) => ({ ...t, chunks: blocks.length })) }, cookie);
    if (created.response.status !== 201) return { created, id: null as string | null };
    const file = created.json.file;
    for (const [i, t] of read.tables.entries()) {
      for (const [seq, rows] of t.blocks.entries()) {
        const sent = await post(`/api/files/${file.id}/chunks`, { table: file.tables[i].id, chunks: [{ seq, rows }] }, cookie);
        expect(sent.response.status).toBe(200);
      }
    }
    const done = await post(`/api/files/${file.id}/complete`, {}, cookie);
    expect(done.json.file.status).toBe("ready");
    return { created, id: file.id as string };
  };

  it("answers from the file in a chat: the model gets the overview and the tool, the answer shows what was calculated", async () => {
    const ann = await login("ann");
    const { id } = await upload(ann.cookie, csvFile("sales.csv", SALES));
    const requests: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://groq.test/v1/chat/completions") return new Response("unexpected " + url, { status: 500 });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return requests.length === 1
        ? toolCall("query_table", { table: "T1", filters: [{ column: "Date", op: "=", value: "2026" }], group_by: [{ column: "Region" }], metrics: [{ op: "sum", column: "Amount" }] })
        : answer("In 2026, North sold 525.25.");
    });
    const chat = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "Sales by region in 2026?", files: [id] }), cookie: ann.cookie });
    expect(chat.response.status).toBe(200);
    const stream = events(chat.text);
    // The question was about the file: no web search first, even though it names a year.
    const system = requests[0].messages[0].content as string;
    expect(system).toContain("Files in this chat");
    expect(system).toContain('T1 · file "sales.csv"');
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain("query_table");
    expect(requests[0].messages.at(-1).content).toContain('[The user attached "sales.csv" with this message');
    const toolResult = requests[1].messages.find((m: any) => m.role === "tool");
    expect(JSON.parse(toolResult.content).rows).toEqual([
      ["North", 525.25],
      ["South", 300.5],
      ["north", 74.75],
      ["East", null],
    ]);
    const user = stream.find((e) => e.type === "user_message") as Extract<ChatStreamEvent, { type: "user_message" }>;
    expect(user.message.files).toEqual([{ id, name: "sales.csv", sheets: 1, rows: 8 }]);
    const done = stream.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.message.tools![0]!.sources).toEqual([{ title: "sales.csv", location: "sum of Amount by Region · where Date in 2026", kind: "table" }]);
    expect(done.message.checkable).toBe(true);
    const conversationId = (stream.find((e) => e.type === "conversation") as any).conversation.id;
    const saved = await call(`/api/conversations/${conversationId}`, { cookie: ann.cookie });
    expect(saved.json.conversation.title).toBe("Sales by region in 2026?");
    expect(saved.json.messages[0].files).toEqual([{ id, name: "sales.csv", sheets: 1, rows: 8 }]);
    // The same file can't be sent again; deleting the chat deletes the file and its rows.
    const again = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "Again", files: [id] }), cookie: ann.cookie });
    expect(again.json.error.code).toBe("file_not_ready");
    await call(`/api/conversations/${conversationId}`, { method: "DELETE", cookie: ann.cookie });
    const left = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM data_files) AS files, (SELECT COUNT(*) FROM data_tables) AS tables, (SELECT COUNT(*) FROM data_chunks) AS chunks",
    ).first();
    expect(left).toEqual({ files: 0, tables: 0, chunks: 0 });
  });

  it("keeps files private, checks uploads and enforces the limits", async () => {
    const ann = await login("ann");
    const eve = await login("eve");
    const admin = await login("octocat");
    const read = csvFile("sales.csv", SALES);
    const { id } = await upload(ann.cookie, read);
    const file = (await call(`/api/files/${id}/complete`, { method: "POST", body: "{}", cookie: ann.cookie })).json.file;
    // Someone else can't add to it, finish it, delete it or send it.
    expect((await post(`/api/files/${id}/chunks`, { table: file.tables[0].id, chunks: [{ seq: 0, rows: [[2, "x", "y", 1, 1, true]] }] }, eve.cookie)).response.status).toBe(404);
    expect((await post(`/api/files/${id}/complete`, {}, eve.cookie)).response.status).toBe(404);
    expect((await call(`/api/files/${id}`, { method: "DELETE", cookie: eve.cookie })).response.status).toBe(404);
    expect((await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "x", files: [id] }), cookie: eve.cookie })).json.error.code).toBe("file_not_ready");
    // Rows must match the overview; an unfinished upload can't be completed.
    const meta = { name: "half.csv", kind: "csv", bytes: 10, tables: read.tables.map(({ blocks, ...t }) => ({ ...t, chunks: blocks.length })) };
    const half = await post("/api/files", meta, ann.cookie);
    expect((await post(`/api/files/${half.json.file.id}/chunks`, { table: half.json.file.tables[0].id, chunks: [{ seq: 0, rows: [[2, "x"]] }] }, ann.cookie)).json.error.message).toMatch(
      /wrong number of cells/,
    );
    expect((await post(`/api/files/${half.json.file.id}/complete`, {}, ann.cookie)).json.error.code).toBe("table_conflict");
    expect((await post("/api/files", { ...meta, tables: [{ ...meta.tables[0], rows: TABLE_LIMITS.rows + 1 }] }, ann.cookie)).response.status).toBe(400);
    // Daily limit (admins unlimited); removing an unsent file gives it back.
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ tablesPerDay: 2 }), cookie: admin.cookie });
    const third = await post("/api/files", meta, ann.cookie);
    expect(third.json.error.code).toBe("table_limit");
    expect((await call(`/api/files/${half.json.file.id}`, { method: "DELETE", cookie: ann.cookie })).response.status).toBe(200);
    expect((await post("/api/files", meta, ann.cookie)).response.status).toBe(201);
    // Not with deep research, not with local models; switched off by the admin: refused and not offered.
    expect((await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "x", files: [id], research: true }), cookie: ann.cookie })).response.status).toBe(400);
    const local = await call("/api/chat/local/prepare", { method: "POST", body: JSON.stringify({ message: "x", model: "ollama:llama3", files: [id] }), cookie: ann.cookie });
    expect(local.json.error.message).toMatch(/cloud models only/);
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ tablesEnabled: false }), cookie: admin.cookie });
    expect((await post("/api/files", meta, admin.cookie)).json.error.code).toBe("tables_off");
    expect((await call("/api/media/features", { cookie: ann.cookie })).json.tables.enabled).toBe(false);
    expect((await call("/api/tools", { cookie: ann.cookie })).json.tools.map((t: any) => t.name)).not.toContain("query_table");
    expect((await call("/api/admin/users", { cookie: admin.cookie })).json.users.find((u: any) => u.login === "ann").todayTables).toBe(2);
  });

  it("removes files that were never sent after a day", async () => {
    const ann = await login("ann");
    const { id } = await upload(ann.cookie, csvFile("sales.csv", SALES));
    await env.DB.prepare("UPDATE data_files SET created_at = ?1 WHERE id = ?2").bind(Date.now() - 25 * 3_600_000, id).run();
    await cleanup(env.DB);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM data_chunks").first("n")).toBe(0);
  });
});
