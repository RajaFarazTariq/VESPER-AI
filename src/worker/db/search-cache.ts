/**
 * Web search cache (migration 0005): saved search results for a short time, so repeating a search costs nothing.
 * Every function swallows database errors: the cache is an optimisation and must never break a search.
 */
import { sha256Hex } from "../lib/crypto";

export const HOUR_MS = 60 * 60 * 1000;

/** Cache key for a search request: the same words, topic and site filters give the same key. */
export async function searchCacheKey(request: { query: string; topic: string; include?: string[]; exclude?: string[] }): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      q: request.query.trim().toLowerCase().replace(/\s+/g, " "),
      t: request.topic,
      i: [...(request.include ?? [])].sort(),
      e: [...(request.exclude ?? [])].sort(),
    }),
  );
}

export async function getCachedSearch(db: D1Database, key: string, now = Date.now()): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT body FROM search_cache WHERE key = ?1 AND expires_at > ?2").bind(key, now).first<{ body: string }>();
    return row?.body ?? null;
  } catch {
    return null;
  }
}

export async function putCachedSearch(db: D1Database, key: string, body: string, ttlMs: number, now = Date.now()): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO search_cache (key, body, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at")
      .bind(key, body, now + ttlMs)
      .run();
  } catch {
    // not cached: the next identical search just asks the service again
  }
}
