/**
 * Lists and notes (v0.19.0): the user's own VESPER data, like memories and reminders. Lists ("To-do", "Shopping"…)
 * hold items with a done flag; notes are short free texts. Everything is the user's own: every statement checks
 * user_id, so another account's ids find nothing. Limits are checked inside the INSERT itself, so two requests at once
 * can't go over them.
 */
import type { ListDto, ListItemDto, NoteDto } from "../../shared/types";
import { newId } from "../lib/crypto";

export const MAX_LISTS = 20;
export const MAX_ITEMS = 200;
export const MAX_ITEM_CHARS = 200;
export const MAX_LIST_NAME = 40;
export const MAX_NOTES = 500;
export const MAX_NOTE_CHARS = 2_000;
/** Notes returned to Settings at once (newest first). */
export const NOTES_SHOWN = 200;
export const DEFAULT_LIST = "To-do";

/** One line: control characters and runs of spaces become single spaces. */
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const TODO_NAME = /^(?:to[\s-]?do|todo)(?:'?s)?$/i;

/**
 * A list name as people say it, tidied: "my shopping list" → "Shopping", "todo" / "to do list" → "To-do". The key is
 * the name in lower case (one list per key). Null when nothing is left.
 */
export function listName(raw: string): { name: string; key: string } | null {
  let name = oneLine(raw).replace(/^(?:my|the|our)\s+/i, "");
  name = name.replace(/\s+list$/i, "").trim() || name;
  if (TODO_NAME.test(name)) name = DEFAULT_LIST;
  if (!name) return null;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { name, key: name.toLowerCase() };
}

// ---------------------------------------------------------------- lists

export interface ListRow {
  id: string;
  user_id: string;
  name: string;
  name_key: string;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  list_id: string;
  text: string;
  done: number;
  created_at: number;
}

const toItem = (r: ItemRow): ListItemDto => ({ id: r.id, text: r.text, done: r.done === 1, createdAt: r.created_at });
const toList = (r: ListRow, items: ListItemDto[]): ListDto => ({ id: r.id, name: r.name, items, createdAt: r.created_at, updatedAt: r.updated_at });

/** The user's lists, most recently changed first. */
export async function listRows(db: D1Database, userId: string): Promise<ListRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM lists WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT ?2")
    .bind(userId, MAX_LISTS)
    .all<ListRow>();
  return results;
}

export async function findList(db: D1Database, userId: string, key: string): Promise<ListRow | null> {
  return db.prepare("SELECT * FROM lists WHERE user_id = ?1 AND name_key = ?2").bind(userId, key).first<ListRow>();
}

async function listRow(db: D1Database, userId: string, listId: string): Promise<ListRow | null> {
  return db.prepare("SELECT * FROM lists WHERE id = ?1 AND user_id = ?2").bind(listId, userId).first<ListRow>();
}

/** A list's items in the order they were added. */
export async function listItems(db: D1Database, listId: string): Promise<ListItemDto[]> {
  const { results } = await db
    .prepare("SELECT id, list_id, text, done, created_at FROM list_items WHERE list_id = ?1 ORDER BY created_at, rowid LIMIT ?2")
    .bind(listId, MAX_ITEMS)
    .all<ItemRow>();
  return results.map(toItem);
}

/** One of the user's lists with its items, or null. */
export async function getList(db: D1Database, userId: string, listId: string): Promise<ListDto | null> {
  const row = await listRow(db, userId, listId);
  return row ? toList(row, await listItems(db, row.id)) : null;
}

/** Every list with its items (Settings → Lists & notes). */
export async function allLists(db: D1Database, userId: string): Promise<ListDto[]> {
  const [rows, items] = await Promise.all([
    listRows(db, userId),
    db
      .prepare(
        `SELECT i.id, i.list_id, i.text, i.done, i.created_at FROM list_items i JOIN lists l ON l.id = i.list_id
         WHERE l.user_id = ?1 ORDER BY i.list_id, i.created_at, i.rowid`,
      )
      .bind(userId)
      .all<ItemRow>(),
  ]);
  const byList = new Map<string, ListItemDto[]>();
  for (const item of items.results) {
    const list = byList.get(item.list_id) ?? [];
    list.push(toItem(item));
    byList.set(item.list_id, list);
  }
  return rows.map((r) => toList(r, byList.get(r.id) ?? []));
}

/** Each list's name and how many items are open / in it, most recently changed first (for "what lists do I have"). */
export async function listSummaries(db: D1Database, userId: string): Promise<{ name: string; open: number; total: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT l.name, COALESCE(SUM(CASE WHEN i.done = 0 THEN 1 ELSE 0 END), 0) AS open, COUNT(i.id) AS total
       FROM lists l LEFT JOIN list_items i ON i.list_id = l.id
       WHERE l.user_id = ?1 GROUP BY l.id ORDER BY l.updated_at DESC LIMIT ?2`,
    )
    .bind(userId, MAX_LISTS)
    .all<{ name: string; open: number; total: number }>();
  return results;
}

/** The list with this name, made now if it doesn't exist; "full" when the user already has the most lists. */
export async function ensureList(db: D1Database, userId: string, name: { name: string; key: string }, now = Date.now()): Promise<ListRow | "full"> {
  const existing = await findList(db, userId, name.key);
  if (existing) return existing;
  await db
    .prepare(
      `INSERT INTO lists (id, user_id, name, name_key, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?5 WHERE (SELECT COUNT(*) FROM lists WHERE user_id = ?2) < ?6
       ON CONFLICT(user_id, name_key) DO NOTHING`,
    )
    .bind(newId(), userId, name.name, name.key, now, MAX_LISTS)
    .run();
  return (await findList(db, userId, name.key)) ?? "full";
}

const touch = (db: D1Database, userId: string, listId: string, now: number) =>
  db.prepare("UPDATE lists SET updated_at = ?3 WHERE id = ?1 AND user_id = ?2").bind(listId, userId, now);

/**
 * Adds items to a list in this order. Items already open on the list (same text, any case) are skipped; when the
 * list is full, the rest are left out.
 */
export async function addItems(
  db: D1Database,
  userId: string,
  listId: string,
  texts: string[],
  now = Date.now(),
): Promise<{ added: string[]; already: string[]; full: string[] }> {
  const open = new Set((await listItems(db, listId)).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
  const fresh: string[] = [];
  const already: string[] = [];
  for (const text of texts) {
    if (open.has(text.toLowerCase())) already.push(text);
    else {
      open.add(text.toLowerCase());
      fresh.push(text);
    }
  }
  if (fresh.length === 0) return { added: [], already, full: [] };
  const results = await db.batch([
    ...fresh.map((text) =>
      db
        .prepare(
          // Always after the list's newest item (at least a millisecond), so items keep the order they were added in,
          // also when one answer adds twice at the same moment.
          `INSERT INTO list_items (id, list_id, user_id, text, done, created_at)
           SELECT ?1, ?2, ?3, ?4, 0, MAX(?5, COALESCE((SELECT MAX(created_at) + 1 FROM list_items WHERE list_id = ?2), 0))
           WHERE (SELECT COUNT(*) FROM list_items WHERE list_id = ?2) < ?6`,
        )
        .bind(newId(), listId, userId, text, now, MAX_ITEMS),
    ),
    touch(db, userId, listId, now),
  ]);
  const added = fresh.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0);
  return { added, already, full: fresh.filter((t) => !added.includes(t)) };
}

/** Marks items done (or not done again); how many changed. */
export async function setItemsDone(db: D1Database, userId: string, listId: string, ids: string[], done: boolean, now = Date.now()): Promise<number> {
  if (ids.length === 0) return 0;
  const results = await db.batch([
    ...ids.map((id) =>
      db
        .prepare("UPDATE list_items SET done = ?4, done_at = ?5 WHERE id = ?1 AND list_id = ?2 AND user_id = ?3 AND done != ?4")
        .bind(id, listId, userId, done ? 1 : 0, done ? now : null),
    ),
    touch(db, userId, listId, now),
  ]);
  return results.slice(0, ids.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export async function removeItems(db: D1Database, userId: string, listId: string, ids: string[], now = Date.now()): Promise<number> {
  if (ids.length === 0) return 0;
  const results = await db.batch([
    ...ids.map((id) => db.prepare("DELETE FROM list_items WHERE id = ?1 AND list_id = ?2 AND user_id = ?3").bind(id, listId, userId)),
    touch(db, userId, listId, now),
  ]);
  return results.slice(0, ids.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Removes the items marked done; how many. */
export async function clearDone(db: D1Database, userId: string, listId: string, now = Date.now()): Promise<number> {
  const [result] = await db.batch([
    db.prepare("DELETE FROM list_items WHERE list_id = ?1 AND user_id = ?2 AND done = 1").bind(listId, userId),
    touch(db, userId, listId, now),
  ]);
  return result?.meta.changes ?? 0;
}

/** Edits one item's text and/or done flag (the user's own only); false when there is no such item. */
export async function updateItem(
  db: D1Database,
  userId: string,
  listId: string,
  itemId: string,
  patch: { text?: string; done?: boolean },
  now = Date.now(),
): Promise<boolean> {
  const done = patch.done === undefined ? null : patch.done ? 1 : 0;
  const [result] = await db.batch([
    db
      .prepare(
        `UPDATE list_items SET text = COALESCE(?4, text), done = COALESCE(?5, done),
           done_at = CASE WHEN ?5 IS NULL OR ?5 = done THEN done_at WHEN ?5 = 1 THEN ?6 ELSE NULL END
         WHERE id = ?1 AND list_id = ?2 AND user_id = ?3`,
      )
      .bind(itemId, listId, userId, patch.text ?? null, done, now),
    db.prepare("UPDATE lists SET updated_at = ?3 WHERE id = ?1 AND user_id = ?2").bind(listId, userId, now),
  ]);
  return (result?.meta.changes ?? 0) > 0;
}

/** Renames one of the user's lists: the list, "taken" (another list has that name) or null (no such list). */
export async function renameList(
  db: D1Database,
  userId: string,
  listId: string,
  name: { name: string; key: string },
  now = Date.now(),
): Promise<ListRow | "taken" | null> {
  const other = await findList(db, userId, name.key);
  if (other && other.id !== listId) return "taken";
  try {
    return await db
      .prepare("UPDATE lists SET name = ?3, name_key = ?4, updated_at = ?5 WHERE id = ?1 AND user_id = ?2 RETURNING *")
      .bind(listId, userId, name.name, name.key, now)
      .first<ListRow>();
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return "taken"; // made at the same moment
    throw error;
  }
}

/** Deletes one of the user's lists with its items. */
export async function deleteList(db: D1Database, userId: string, listId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM lists WHERE id = ?1 AND user_id = ?2").bind(listId, userId).run();
  return result.meta.changes > 0;
}

/** Open items on the user's To-do list (for the daily briefing). */
export async function countOpenTodos(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM list_items i JOIN lists l ON l.id = i.list_id
       WHERE l.user_id = ?1 AND l.name_key = ?2 AND i.done = 0`,
    )
    .bind(userId, DEFAULT_LIST.toLowerCase())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------- notes

interface NoteRow {
  id: string;
  text: string;
  created_at: number;
  updated_at: number;
}

const toNote = (r: NoteRow): NoteDto => ({ id: r.id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });
const NOTE_COLUMNS = "id, text, created_at, updated_at";

/** A note's text: trimmed, at most a few blank lines in a row. */
export const cleanNote = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Saves a note (an exact copy of one already saved is not saved twice); "full" at the limit. */
export async function addNote(db: D1Database, userId: string, text: string, now = Date.now()): Promise<NoteDto | "full"> {
  const existing = await db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE user_id = ?1 AND text = ?2`).bind(userId, text).first<NoteRow>();
  if (existing) return toNote(existing);
  const id = newId();
  const result = await db
    .prepare(
      `INSERT INTO notes (id, user_id, text, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4 WHERE (SELECT COUNT(*) FROM notes WHERE user_id = ?2) < ?5`,
    )
    .bind(id, userId, text, now, MAX_NOTES)
    .run();
  return result.meta.changes ? { id, text, createdAt: now, updatedAt: now } : "full";
}

/** The user's notes, newest first. */
export async function listNotes(db: D1Database, userId: string, limit = NOTES_SHOWN): Promise<NoteDto[]> {
  const { results } = await db
    .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2`)
    .bind(userId, limit)
    .all<NoteRow>();
  return results.map(toNote);
}

const STOP_WORDS = new Set(
  ("the and for are but not you your with that this what when where which who how why about from did does do was were " +
    "have has had note notes noted wrote write said say tell me my mine i i'm any all some there their them it its is of " +
    "to in on at a an or").split(" "),
);

/** The words a search looks for: 2+ characters, no filler words, a plural "s" dropped ("gates" finds "gate"). */
export function noteWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}'-]+/u);
  const kept = words.filter((w) => w.length >= 2 && !STOP_WORDS.has(w)).map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return [...new Set(kept)].slice(0, 6);
}

/** Notes containing any of the words, those with the most of them first (then the newest). */
export async function searchNotes(db: D1Database, userId: string, words: string[], limit: number): Promise<NoteDto[]> {
  if (words.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE user_id = ?1 AND (${words.map((_, i) => `instr(lower(text), ?${i + 2}) > 0`).join(" OR ")})
       ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(userId, ...words)
    .all<NoteRow>();
  return results
    .map((r) => ({ r, score: words.filter((w) => r.text.toLowerCase().includes(w)).length }))
    .sort((a, b) => b.score - a.score || b.r.created_at - a.r.created_at)
    .slice(0, limit)
    .map((x) => toNote(x.r));
}

export async function deleteNote(db: D1Database, userId: string, id: string): Promise<NoteDto | null> {
  const row = await db.prepare(`DELETE FROM notes WHERE id = ?1 AND user_id = ?2 RETURNING ${NOTE_COLUMNS}`).bind(id, userId).first<NoteRow>();
  return row ? toNote(row) : null;
}

export async function updateNote(db: D1Database, userId: string, id: string, text: string, now = Date.now()): Promise<NoteDto | null> {
  const row = await db
    .prepare(`UPDATE notes SET text = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2 RETURNING ${NOTE_COLUMNS}`)
    .bind(id, userId, text, now)
    .first<NoteRow>();
  return row ? toNote(row) : null;
}
