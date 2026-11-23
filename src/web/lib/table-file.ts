/**
 * Opening a spreadsheet file (v0.14.0): CSV/TSV as text, Excel (.xlsx, .xlsm, .xls) and OpenDocument (.ods) with
 * SheetJS (Community Edition, Apache-2.0, loaded only for these files). Cells become table-read.ts's raw cells:
 * Excel dates (stored as day numbers) become real dates, percentages are shown as percent (0.45 → 45, unit "%"), and
 * a currency in the number format becomes the column's unit. Runs in a background worker (table-reader.worker.ts) so
 * a big workbook doesn't freeze the page.
 */
import * as XLSX from "xlsx";
import { TABLE_LIMITS, tableKind } from "../../shared/tables";
import { buildFile, csvSheet, decodeText, TableReadError, type RawCell, type RawSheet, type ReadFile, type ReadOptions } from "./table-read";

const tidy = (v: number) => Number(v.toPrecision(15));

/**
 * An Excel day number as a date (and time when it has one). 1900 system: day 1 is 1900-01-01, and Excel counts a
 * 29 February 1900 that never existed, so days before 1 March 1900 are shifted by one. 1904 system: day 0 is 1904-01-01.
 */
export function excelDate(serial: number, date1904: boolean): { date: string; time: string | null } {
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    days += 1;
    seconds = 0;
  }
  if (!date1904 && days < 60) days += 1;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + days * 86_400_000 + seconds * 1_000).toISOString();
  return { date: iso.slice(0, 10), time: seconds ? iso.slice(11, 19) : null };
}

/** The number format without its quoted text, [brackets] and escaped characters. */
const formatCode = (fmt: string) => fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");

/** A currency in a number format: [$€-407], "$"#,##0, #,##0 "PKR"… */
export function currencyOf(fmt: string): string | undefined {
  const bracket = /\[\$([^\]-]+)(?:-[0-9A-Fa-f]+)?\]/.exec(fmt)?.[1]?.trim();
  if (bracket) return bracket.slice(0, 8);
  const plain = fmt.replace(/"([^"]*)"/g, " $1 ").replace(/\\(.)/g, "$1");
  const symbol = /[$€£¥₹]/.exec(plain)?.[0];
  if (symbol) return symbol;
  const code = /(?:^|[^A-Za-z])(PKR|USD|EUR|GBP|INR|AED|SAR|CAD|AUD|Rs\.?)(?![A-Za-z])/.exec(plain)?.[1];
  return code ? (/^rs/i.test(code) ? "Rs" : code.toUpperCase()) : undefined;
}

/** One SheetJS cell as a raw cell. */
export function rawCell(cell: XLSX.CellObject | undefined, date1904: boolean): RawCell {
  if (!cell) return null;
  switch (cell.t) {
    case "s": {
      const v = String(cell.v ?? "").trim();
      return v ? { t: "s", v } : null;
    }
    case "b":
      return { t: "b", v: Boolean(cell.v) };
    case "e":
      return { t: "e", ...(cell.w ? { w: cell.w } : {}) };
    case "d": {
      if (!(cell.v instanceof Date) || Number.isNaN(cell.v.getTime())) return null;
      // SheetJS builds these dates in local time: keep the wall-clock date and time as written.
      const local = new Date(cell.v.getTime() - cell.v.getTimezoneOffset() * 60_000).toISOString();
      const time = local.slice(11, 19);
      return { t: "d", v: time === "00:00:00" ? local.slice(0, 10) : `${local.slice(0, 10)}T${time}`, time: time !== "00:00:00" };
    }
    case "n": {
      const v = typeof cell.v === "number" ? cell.v : Number(cell.v);
      if (!Number.isFinite(v)) return null;
      const fmt = typeof cell.z === "string" ? cell.z : "";
      const w = typeof cell.w === "string" ? cell.w : undefined;
      if (fmt && fmt !== "General" && (XLSX.SSF.is_date(fmt) as boolean)) {
        // A time of day on its own (e.g. 14:30) isn't a date: keep it as the text shown.
        if (v < 1 && !/[dy]/i.test(formatCode(fmt))) return { t: "s", v: w?.trim() || String(v) };
        const { date, time } = excelDate(v, date1904);
        return { t: "d", v: time ? `${date}T${time}` : date, time: time !== null, ...(w ? { w } : {}) };
      }
      if (formatCode(fmt).includes("%")) return { t: "n", v: tidy(v * 100), percent: true, ...(w ? { w } : {}) };
      const unit = currencyOf(fmt);
      return { t: "n", v: tidy(v), ...(unit ? { unit } : {}), ...(w ? { w } : {}) };
    }
    default:
      return null;
  }
}

/** The sheets of a workbook as raw rows (hidden sheets are skipped and mentioned). */
export function workbookSheets(wb: XLSX.WorkBook): { sheets: RawSheet[]; notes: string[] } {
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  const sheets: RawSheet[] = [];
  const notes: string[] = [];
  wb.SheetNames.forEach((name, index) => {
    if (wb.Workbook?.Sheets?.[index]?.Hidden) {
      notes.push(`The hidden sheet "${name}" was skipped.`);
      return;
    }
    const ws = wb.Sheets[name];
    const ref = ws?.["!ref"];
    if (!ws || typeof ref !== "string") return;
    const range = XLSX.utils.decode_range(ref);
    const data = (ws["!data"] ?? []) as (XLSX.CellObject[] | undefined)[];
    const rows: RawCell[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const source = data[r];
      const out: RawCell[] = [];
      // Only up to the row's last cell: a sheet formatted out to column XFD has no data there.
      const last = Math.min(range.e.c, (source?.length ?? 0) - 1);
      for (let c = range.s.c; c <= last; c++) out.push(rawCell(source?.[c], date1904));
      rows.push(out);
    }
    // Read up to the limit: if the sheet really goes on (rows with data at the cut), it's too big.
    const fullRef = ws["!fullref"];
    if (typeof fullRef === "string" && XLSX.utils.decode_range(fullRef).e.r > range.e.r && rows.slice(-3).some((row) => row.some((c) => c !== null))) {
      throw new TableReadError(
        `The sheet "${name}" has more than ${TABLE_LIMITS.rows.toLocaleString("en-US")} rows, the limit. Remove rows you don't need, or split it into smaller files.`,
      );
    }
    sheets.push({ name, rows, firstRow: range.s.r + 1 });
  });
  return { sheets, notes };
}

/** Read a picked or dropped file into tables. Throws TableReadError with a message for the user. */
export async function readTableFile(file: File, options: ReadOptions, progress: (message: string) => void = () => {}): Promise<ReadFile> {
  const name = file.name || "spreadsheet";
  const kind = tableKind(name);
  if (!kind) throw new TableReadError(`"${name}" isn't a spreadsheet VESPER can read. Use CSV, Excel (.xlsx, .xls) or OpenDocument (.ods).`);
  if (file.size === 0) throw new TableReadError(`"${name}" is empty.`);
  if (file.size > TABLE_LIMITS.fileBytes) throw new TableReadError(`"${name}" is larger than 10 MB. Remove rows or columns you don't need, or split it.`);
  progress("Reading the file…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "csv" || kind === "tsv") {
    const sheet = csvSheet(decodeText(bytes), kind === "tsv" ? "\t" : undefined);
    progress("Checking the columns…");
    return buildFile({ name, kind, bytes: file.size, sheets: [sheet] }, options);
  }
  let wb: XLSX.WorkBook;
  try {
    // Dense rows, number formats kept (dates, %, currency), dates as day numbers (converted above without time-zone
    // surprises), and at most the row limit read (plus room for titles), so a huge sheet can't exhaust memory.
    wb = XLSX.read(bytes, { type: "array", dense: true, cellNF: true, cellDates: false, sheetRows: TABLE_LIMITS.rows + 50 });
  } catch (error) {
    const locked = /password|encrypt/i.test(String(error));
    throw new TableReadError(
      locked
        ? `"${name}" is password-protected. Save a copy without the password (or as CSV) and attach that.`
        : `"${name}" couldn't be opened. It may be damaged or in an unusual format; save a copy as .xlsx or .csv and attach that.`,
    );
  }
  progress("Checking the columns…");
  const { sheets, notes } = workbookSheets(wb);
  return buildFile({ name, kind, bytes: file.size, sheets, notes }, options);
}
