/**
 * Spreadsheets in chat (v0.14.0): storing the files users add, and finding them again for a chat.
 *
 * Adding a file (the browser has already read it):
 *   createTableFile   → the file and one table per sheet ("uploading"), after checking the limits
 *   addTableChunks    → blocks of rows (safe to send again after a network error)
 *   completeTableFile → "ready" once every block of every table is there
 * Sending the message links the file to the chat (linkTableFiles). Deleting the chat deletes its files; files that
 * were never sent are removed by the daily clean-up after 24 hours (or at once when the user removes them).
 */
import { TABLE_LIMITS, TABLE_STORAGE_CHARS } from "../../shared/tables";
import type {
  MessageFileDto,
  TableCell,
  TableChunkInput,
  TableColumnDto,
  TableFileDto,
  TableFileKind,
  TableSheetInput,
} from "../../shared/types";
import { newId } from "../lib/crypto";

export class TableError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "limit" | "full",
    message: string,
  ) {
    super(message);
  }
}

/** A table as the assistant and the Table analysis tool see it. */
export interface TableMeta {
  id: string;
  /** "T1", "T2"… in the order the files were added to the chat (stable: files are only ever added). */
  ref: string;
  fileId: string;
  fileName: string;
  sheet: string | null;
  /** How many tables the file has (to name the sheet only when there's a choice). */
  sheetsInFile: number;
  rows: number;
  firstRow: number;
  lastRow: number;
  columns: TableColumnDto[];
  notes: string[];
  samples: TableCell[][];
}

const DAY_MS = 86_400_000;
/** Files added but never sent are removed after this long. */
export const UNSENT_FILE_MS = DAY_MS;

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface FileRow {
  id: string;
  name: string;
  kind: TableFileKind;
  status: "uploading" | "ready";
  created_at: number;
}
interface TableRow {
  id: string;
  file_id: string;
  sheet: string | null;
  row_count: number;
  columns: string;
}

async function fileDto(db: D1Database, file: FileRow): Promise<TableFileDto> {
  const { results } = await db
    .prepare("SELECT id, file_id, sheet, row_count, columns FROM data_tables WHERE file_id = ?1 ORDER BY position")
    .bind(file.id)
    .all<TableRow>();
  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    status: file.status,
    tables: results.map((t) => ({ id: t.id, sheet: t.sheet, rows: t.row_count, columns: parseJsonArray(t.columns).length })),
    createdAt: file.created_at,
  };
}

/** Rows of every user's stored spreadsheets (characters), against the app-wide budget. */
export async function tableStorageUsed(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(stored_chars), 0) AS n FROM data_files").first<{ n: number }>();
  return row?.n ?? 0;
}

const STORAGE_FULL =
  "Storage for spreadsheets is full right now. Delete older chats that have spreadsheets, or ask the administrator.";

/**
 * Start adding a file: checks the size limits and how many files the user keeps, then stores the overview of each
 * sheet. The daily limit is counted by the caller (before this) and given back if this refuses.
 */
export async function createTableFile(
  db: D1Database,
  userId: string,
  input: { name: string; kind: TableFileKind; bytes: number; tables: TableSheetInput[] },
): Promise<TableFileDto> {
  if (input.bytes > TABLE_LIMITS.fileBytes) throw new TableError("invalid", "The file is larger than 10 MB.");
  if (input.tables.length === 0) throw new TableError("invalid", "The file has no rows of data.");
  if (input.tables.length > TABLE_LIMITS.sheets) throw new TableError("invalid", `Up to ${TABLE_LIMITS.sheets} sheets per file.`);
  const rows = input.tables.reduce((n, t) => n + t.rows, 0);
  if (rows > TABLE_LIMITS.rows) {
    throw new TableError("invalid", `The file has ${rows.toLocaleString("en-US")} rows; the limit is ${TABLE_LIMITS.rows.toLocaleString("en-US")}.`);
  }
  for (const t of input.tables) {
    if (t.rows < 1) throw new TableError("invalid", "A sheet has no rows of data.");
    if (t.columns.length < 1 || t.columns.length > TABLE_LIMITS.columns) {
      throw new TableError("invalid", `Up to ${TABLE_LIMITS.columns} columns per sheet.`);
    }
    const names = new Set(t.columns.map((c) => c.name.toLowerCase()));
    if (names.size !== t.columns.length) throw new TableError("invalid", "Column names must be different from each other.");
    if (t.chunks < Math.ceil(t.rows / TABLE_LIMITS.chunkRows) || t.chunks > t.rows) throw new TableError("invalid", "Wrong number of row blocks.");
    if (t.lastRow < t.firstRow) throw new TableError("invalid", "Wrong row numbers.");
  }
  const kept = await db.prepare("SELECT COUNT(*) AS n FROM data_files WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  if ((kept?.n ?? 0) >= TABLE_LIMITS.stored) {
    throw new TableError(
      "limit",
      `You can keep up to ${TABLE_LIMITS.stored} spreadsheets. Delete an older chat that has one to add more.`,
    );
  }
  if ((await tableStorageUsed(db)) >= TABLE_STORAGE_CHARS) throw new TableError("full", STORAGE_FULL);

  const now = Date.now();
  const file: FileRow = { id: newId(), name: input.name, kind: input.kind, status: "uploading", created_at: now };
  await db.batch([
    db
      .prepare(
        `INSERT INTO data_files (id, user_id, conversation_id, name, kind, bytes, stored_chars, status, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 0, 'uploading', ?6, ?6)`,
      )
      .bind(file.id, userId, file.name, file.kind, input.bytes, now),
    ...input.tables.map((t, position) =>
      db
        .prepare(
          `INSERT INTO data_tables (id, file_id, position, sheet, row_count, first_row, last_row, columns, notes, samples, expected_chunks)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          newId(),
          file.id,
          position,
          t.sheet,
          t.rows,
          t.firstRow,
          t.lastRow,
          JSON.stringify(t.columns),
          JSON.stringify(t.notes),
          JSON.stringify(t.samples),
          t.chunks,
        ),
    ),
  ]);
  return fileDto(db, file);
}

const isCell = (v: unknown): v is TableCell =>
  v === null ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (typeof v === "string" && v.length > 0 && v.length <= TABLE_LIMITS.cellChars);

/**
 * Checks one block of rows: each row is [spreadsheet row number, one cell per column], every cell a number, text,
 * true/false or null. Returns the JSON to store. Throws TableError with what's wrong.
 */
export function validateChunkRows(rows: unknown, width: number): string {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > TABLE_LIMITS.chunkRows) {
    throw new TableError("invalid", `A block must have 1 to ${TABLE_LIMITS.chunkRows} rows.`);
  }
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width + 1) throw new TableError("invalid", "A row has the wrong number of cells.");
    const n = row[0];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new TableError("invalid", "A row has no row number.");
    for (let i = 1; i < row.length; i++) if (!isCell(row[i])) throw new TableError("invalid", "A cell has a value that can't be stored.");
  }
  return JSON.stringify(rows);
}

/** Store blocks of rows for one table of a file that is still uploading (blocks already there are ignored). */
export async function addTableChunks(
  db: D1Database,
  userId: string,
  fileId: string,
  tableId: string,
  chunks: TableChunkInput[],
): Promise<{ stored: number; expected: number }> {
  const table = await db
    .prepare(
      `SELECT t.id, t.columns, t.expected_chunks, f.status FROM data_tables t JOIN data_files f ON f.id = t.file_id
        WHERE t.id = ?1 AND t.file_id = ?2 AND f.user_id = ?3`,
    )
    .bind(tableId, fileId, userId)
    .first<{ id: string; columns: string; expected_chunks: number; status: string }>();
  if (!table) throw new TableError("not_found", "Spreadsheet not found.");
  if (table.status !== "uploading") throw new TableError("conflict", "This spreadsheet is already complete.");
  const width = parseJsonArray(table.columns).length;
  const prepared = chunks.map((chunk) => {
    if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq >= table.expected_chunks) {
      throw new TableError("invalid", "Block number out of range.");
    }
    return { seq: chunk.seq, count: chunk.rows.length, json: validateChunkRows(chunk.rows, width) };
  });
  const chars = prepared.reduce((n, c) => n + c.json.length, 0);
  if ((await tableStorageUsed(db)) + chars > TABLE_STORAGE_CHARS) throw new TableError("full", STORAGE_FULL);
  await db.batch([
    ...prepared.map((c) =>
      db.prepare("INSERT OR IGNORE INTO data_chunks (table_id, seq, row_count, rows) VALUES (?1, ?2, ?3, ?4)").bind(tableId, c.seq, c.count, c.json),
    ),
    db
      .prepare(
        `UPDATE data_files SET updated_at = ?2,
           stored_chars = (SELECT COALESCE(SUM(LENGTH(c.rows)), 0) FROM data_chunks c JOIN data_tables t ON t.id = c.table_id WHERE t.file_id = ?1)
         WHERE id = ?1`,
      )
      .bind(fileId, Date.now()),
  ]);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM data_chunks WHERE table_id = ?1").bind(tableId).first<{ n: number }>();
  return { stored: count?.n ?? 0, expected: table.expected_chunks };
}

/** Mark a file ready once every table has all its blocks and exactly the rows its overview promised. */
export async function completeTableFile(db: D1Database, userId: string, fileId: string): Promise<TableFileDto> {
  const file = await db
    .prepare("SELECT id, name, kind, status, created_at FROM data_files WHERE id = ?1 AND user_id = ?2")
    .bind(fileId, userId)
    .first<FileRow>();
  if (!file) throw new TableError("not_found", "Spreadsheet not found.");
  if (file.status === "ready") return fileDto(db, file);
  const { results } = await db
    .prepare(
      `SELECT t.id, t.row_count, t.expected_chunks, COUNT(c.seq) AS chunks, COALESCE(SUM(c.row_count), 0) AS stored_rows
         FROM data_tables t LEFT JOIN data_chunks c ON c.table_id = t.id
        WHERE t.file_id = ?1 GROUP BY t.id`,
    )
    .bind(fileId)
    .all<{ id: string; row_count: number; expected_chunks: number; chunks: number; stored_rows: number }>();
  for (const t of results) {
    if (t.chunks !== t.expected_chunks || t.stored_rows !== t.row_count) {
      throw new TableError("conflict", "The upload is incomplete. Remove the file and attach it again.");
    }
  }
  await db.prepare("UPDATE data_files SET status = 'ready', updated_at = ?2 WHERE id = ?1").bind(fileId, Date.now()).run();
  return fileDto(db, { ...file, status: "ready" });
}

/**
 * Remove a file the user added but hasn't sent (the ✕ on its chip). Sent files stay with their chat. Returns when it
 * was added (for giving back today's count), or null when there was nothing to remove.
 */
export async function deleteUnsentTableFile(db: D1Database, userId: string, fileId: string): Promise<{ createdAt: number } | null> {
  const row = await db
    .prepare("DELETE FROM data_files WHERE id = ?1 AND user_id = ?2 AND conversation_id IS NULL RETURNING created_at")
    .bind(fileId, userId)
    .first<{ created_at: number }>();
  return row ? { createdAt: row.created_at } : null;
}

/** The user's ready files that aren't in a chat yet, as chips for the message (in the order asked). */
export async function unsentReadyFiles(db: D1Database, userId: string, ids: string[]): Promise<MessageFileDto[]> {
  if (ids.length === 0) return [];
  const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, COUNT(t.id) AS sheets, COALESCE(SUM(t.row_count), 0) AS rows
         FROM data_files f JOIN data_tables t ON t.file_id = f.id
        WHERE f.user_id = ?1 AND f.id IN (${marks}) AND f.status = 'ready' AND f.conversation_id IS NULL
        GROUP BY f.id`,
    )
    .bind(userId, ...ids)
    .all<MessageFileDto>();
  return ids.flatMap((id) => results.filter((r) => r.id === id));
}

/** How many spreadsheets a chat already has. */
export async function conversationFileCount(db: D1Database, userId: string, conversationId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM data_files WHERE conversation_id = ?1 AND user_id = ?2")
    .bind(conversationId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Attach the files to the chat their message was sent in. Only the user's own, ready, unsent files move. */
export async function linkTableFiles(db: D1Database, userId: string, ids: string[], conversationId: string): Promise<void> {
  if (ids.length === 0) return;
  const marks = ids.map((_, i) => `?${i + 4}`).join(", ");
  await db
    .prepare(
      `UPDATE data_files SET conversation_id = ?1, updated_at = ?3
        WHERE user_id = ?2 AND id IN (${marks}) AND status = 'ready' AND conversation_id IS NULL`,
    )
    .bind(conversationId, userId, Date.now(), ...ids)
    .run();
}

/** Does this chat have spreadsheets? */
export async function conversationHasTables(db: D1Database, userId: string, conversationId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM data_files WHERE conversation_id = ?1 AND user_id = ?2 AND status = 'ready' LIMIT 1")
    .bind(conversationId, userId)
    .first();
  return row !== null;
}

/** Every table in a chat, numbered T1, T2… in the order the files were added (sheets in their order). */
export async function conversationTables(db: D1Database, userId: string, conversationId: string): Promise<TableMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.file_id, f.name AS file_name, t.sheet, t.row_count, t.first_row, t.last_row, t.columns, t.notes, t.samples,
              (SELECT COUNT(*) FROM data_tables s WHERE s.file_id = f.id) AS sheets
         FROM data_files f JOIN data_tables t ON t.file_id = f.id
        WHERE f.conversation_id = ?1 AND f.user_id = ?2 AND f.status = 'ready'
        ORDER BY f.created_at, f.id, t.position`,
    )
    .bind(conversationId, userId)
    .all<{
      id: string;
      file_id: string;
      file_name: string;
      sheet: string | null;
      row_count: number;
      first_row: number;
      last_row: number;
      columns: string;
      notes: string;
      samples: string;
      sheets: number;
    }>();
  return results.map((r, i) => ({
    id: r.id,
    ref: `T${i + 1}`,
    fileId: r.file_id,
    fileName: r.file_name,
    sheet: r.sheet,
    sheetsInFile: r.sheets,
    rows: r.row_count,
    firstRow: r.first_row,
    lastRow: r.last_row,
    columns: parseJsonArray<TableColumnDto>(r.columns),
    notes: parseJsonArray<string>(r.notes),
    samples: parseJsonArray<TableCell[]>(r.samples),
  }));
}

// ------------------------------------------------------------------ the daily budget of rows read (whole app)

/** Shared counter of rows the database read for spreadsheet calculations today (UTC), in rate_limits. */
const ROWS_COUNTER = "tables:rows_read";
const today = (now = Date.now()) => Math.floor(now / DAY_MS) * DAY_MS;

export async function tableRowsReadToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?1")
    .bind(ROWS_COUNTER)
    .first<{ count: number; window_start: number }>();
  return row && row.window_start === today() ? row.count : 0;
}

/** Count rows a calculation read (the database reports them). The counter starts again each UTC day. */
export async function addTableRowsRead(db: D1Database, rows: number): Promise<void> {
  if (!(rows > 0)) return;
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + ?3 ELSE ?3 END, window_start = ?2`,
    )
    .bind(ROWS_COUNTER, today(), Math.ceil(rows))
    .run();
}

/** For the daily clean-up: files added but never sent (or never finished) within 24 hours are removed. */
export function tableFileCleanup(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM data_files WHERE conversation_id IS NULL AND created_at < ?1").bind(now - UNSENT_FILE_MS),
    db.prepare("DELETE FROM data_files WHERE status = 'uploading' AND created_at < ?1").bind(now - UNSENT_FILE_MS),
  ];
}
