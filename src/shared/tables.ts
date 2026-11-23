/**
 * Spreadsheets in chat (data analysis, v0.14.0): limits and file types shared by the browser and the server.
 *
 * The browser reads the file (the free server has too little computing time per request), works out each column's
 * type and an overview, and uploads the rows in blocks. The rows are stored in the database, which also does the
 * calculations (see worker/tools/tables.ts), so answers come from every row and never from the model's arithmetic.
 */
import type { TableFileKind } from "./types";

export const TABLE_LIMITS = {
  /** Size of the original file. */
  fileBytes: 10 * 1024 * 1024,
  /** Data rows in one file (all its sheets together). */
  rows: 50_000,
  columns: 100,
  /** Sheets with data read from one workbook. */
  sheets: 10,
  /** Spreadsheets in one chat. */
  perChat: 5,
  /** Spreadsheets attached to one message. */
  perMessage: 1,
  /** Spreadsheets one user keeps (in all chats, plus ones added but not sent yet). Deleting a chat frees its files. */
  stored: 20,
  /** Longer text in a cell is shortened (with "…"). */
  cellChars: 1_000,
  /** Rows per stored block, and the most bytes one block may have when sent (UTF-8: Urdu or Chinese text is 2–3 bytes a character). */
  chunkRows: 500,
  chunkBytes: 200_000,
} as const;

/** Stored rows of all users' spreadsheets together (characters of JSON), so the free 5 GB database never fills up. */
export const TABLE_STORAGE_CHARS = 1_000_000_000;

const EXTENSIONS: Record<string, TableFileKind> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  xlsx: "xlsx",
  xlsm: "xlsm",
  xls: "xls",
  ods: "ods",
};
export const TABLE_FILE_KINDS: readonly TableFileKind[] = ["csv", "tsv", "xlsx", "xlsm", "xls", "ods"];

/** The spreadsheet kind from a file name, or null when it isn't one VESPER reads. */
export function tableKind(fileName: string): TableFileKind | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

/** For the file picker: spreadsheet extensions and their usual types. */
export const TABLE_ACCEPT =
  ".csv,.tsv,.tab,.xlsx,.xlsm,.xls,.ods,text/csv,text/tab-separated-values," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel," +
  "application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.oasis.opendocument.spreadsheet";

/** Dates as stored: "2026-03-05" or "2026-03-05T14:30:00". */
export const STORED_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/;
