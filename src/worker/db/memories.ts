import type { MemoryDto } from "../../shared/types";
import { newId } from "../lib/crypto";

export const MAX_MEMORIES = 100;
export const MAX_MEMORY_CHARS = 500;

interface MemoryRow {
  id: string;
  content: string;
  source: "assistant" | "user";
  created_at: number;
  pinned: number | null;
  updated_at: number | null;
}

const COLUMNS = "id, content, source, created_at, pinned, updated_at";

const toDto = (r: MemoryRow): MemoryDto => ({
  id: r.id,
  content: r.content,
  source: r.source,
  createdAt: r.created_at,
  pinned: r.pinned === 1,
  updatedAt: r.updated_at ?? null,
});

const clean = (content: string) => content.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);

export async function listMemories(db: D1Database, userId: string): Promise<MemoryDto[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM memories WHERE user_id = ?1 ORDER BY created_at ASC LIMIT ?2`)
    .bind(userId, MAX_MEMORIES)
    .all<MemoryRow>();
  return results.map(toDto);
}

export class MemoryLimitError extends Error {}

/** Add a memory; skips exact duplicates and enforces the per-user cap. */
export async function addMemory(
  db: D1Database,
  userId: string,
  content: string,
  source: MemoryDto["source"],
): Promise<MemoryDto> {
  const text = clean(content);
  const existing = await db
    .prepare(`SELECT ${COLUMNS} FROM memories WHERE user_id = ?1 AND content = ?2`)
    .bind(userId, text)
    .first<MemoryRow>();
  if (existing) return toDto(existing);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMORIES) {
    throw new MemoryLimitError(`Memory is full (${MAX_MEMORIES} items). Delete some in Settings → Memory.`);
  }
  const memory: MemoryDto = { id: newId(), content: text, source, createdAt: Date.now(), pinned: false, updatedAt: null };
  await db
    .prepare("INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(memory.id, userId, memory.content, memory.source, memory.createdAt)
    .run();
  return memory;
}

/** Edit the text and/or pin a memory (the user's own only). Null when it doesn't exist. */
export async function updateMemory(
  db: D1Database,
  userId: string,
  id: string,
  patch: { content?: string; pinned?: boolean },
): Promise<MemoryDto | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.content !== undefined) {
    values.push(clean(patch.content), Date.now());
    sets.push(`content = ?${values.length - 1}`, `updated_at = ?${values.length}`);
  }
  if (patch.pinned !== undefined) {
    values.push(patch.pinned ? 1 : 0);
    sets.push(`pinned = ?${values.length}`);
  }
  if (sets.length === 0) return null;
  values.push(id, userId);
  const row = await db
    .prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?${values.length - 1} AND user_id = ?${values.length} RETURNING ${COLUMNS}`)
    .bind(...values)
    .first<MemoryRow>();
  return row ? toDto(row) : null;
}

export async function deleteMemory(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM memories WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes > 0;
}

export async function deleteAllMemories(db: D1Database, userId: string): Promise<number> {
  const result = await db.prepare("DELETE FROM memories WHERE user_id = ?1").bind(userId).run();
  return result.meta.changes;
}

// ------------------------------------------------------------------ which memories go with a message (v0.10.0)

/** When everything saved is this short, it all goes along (costs little, misses nothing). */
const SEND_ALL_CHARS = 800;
/** Budget for pinned plus related memories otherwise. */
const SELECTED_CHARS = 2_000;
const MAX_RELATED = 8;
/** Questions about memory itself: the assistant needs the whole list (to list it, or to forget the right one). */
const ABOUT_MEMORY = /\b(?:remember|memor(?:y|ies)|forget|forgot|what do you know about me|about me)\b/i;
const STOP_WORDS = new Set(
  ("the and for are but not you your yours with that this these those have has had was were will would can could should " +
    "what when where which who whom how why about from they them their there then than also just like into out our ours " +
    "all any some more most very much many does did doing done been being its his her hers she him himself herself " +
    "please tell give make want need know use using get got me my mine myself i'm i've i'll i'd it's user users").split(" "),
);

/** Lower-case words of 3+ letters without common filler words; a trailing plural "s" is dropped ("trips" ~ "trip"). */
function keywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}']+/u);
  return new Set(words.filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

/**
 * The memories to give the assistant with this message: pinned ones always, plus those sharing words with the
 * message (and the last few user messages). Everything when the list is short or the message is about memory itself.
 */
export function selectMemories(memories: MemoryDto[], about: string): { selected: MemoryDto[]; total: number } {
  const total = memories.length;
  const chars = memories.reduce((n, m) => n + m.content.length, 0);
  if (chars <= SEND_ALL_CHARS || ABOUT_MEMORY.test(about)) return { selected: memories, total };

  const words = keywords(about);
  const chosen = new Set<string>();
  let used = 0;
  const take = (m: MemoryDto) => {
    if (chosen.has(m.id) || used + m.content.length > SELECTED_CHARS) return false;
    chosen.add(m.id);
    used += m.content.length;
    return true;
  };
  for (const m of [...memories].reverse()) if (m.pinned) take(m); // newest pinned first if they don't all fit
  const related = memories
    .filter((m) => !m.pinned)
    .map((m) => {
      const own = keywords(m.content);
      let score = 0;
      for (const w of words) if (own.has(w)) score++;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt);
  let added = 0;
  for (const { m } of related) {
    if (added >= MAX_RELATED) break;
    if (take(m)) added++;
  }
  // Keep the saved order (oldest first) so the prompt reads naturally.
  return { selected: memories.filter((m) => chosen.has(m.id)), total };
}
