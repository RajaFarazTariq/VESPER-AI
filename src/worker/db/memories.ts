import type { MemoryDto } from "../../shared/types";
import { newId } from "../lib/crypto";

export const MAX_MEMORIES = 100;
export const MAX_MEMORY_CHARS = 500;

interface MemoryRow {
  id: string;
  content: string;
  source: "assistant" | "user";
  created_at: number;
}

const toDto = (r: MemoryRow): MemoryDto => ({ id: r.id, content: r.content, source: r.source, createdAt: r.created_at });

export async function listMemories(db: D1Database, userId: string): Promise<MemoryDto[]> {
  const { results } = await db
    .prepare("SELECT id, content, source, created_at FROM memories WHERE user_id = ?1 ORDER BY created_at ASC LIMIT ?2")
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
  const text = content.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);
  const existing = await db
    .prepare("SELECT id, content, source, created_at FROM memories WHERE user_id = ?1 AND content = ?2")
    .bind(userId, text)
    .first<MemoryRow>();
  if (existing) return toDto(existing);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMORIES) {
    throw new MemoryLimitError(`Memory is full (${MAX_MEMORIES} items). Delete some in Settings → Memory.`);
  }
  const memory: MemoryDto = { id: newId(), content: text, source, createdAt: Date.now() };
  await db
    .prepare("INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(memory.id, userId, memory.content, memory.source, memory.createdAt)
    .run();
  return memory;
}

export async function deleteMemory(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM memories WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes > 0;
}

export async function deleteAllMemories(db: D1Database, userId: string): Promise<number> {
  const result = await db.prepare("DELETE FROM memories WHERE user_id = ?1").bind(userId).run();
  return result.meta.changes;
}
