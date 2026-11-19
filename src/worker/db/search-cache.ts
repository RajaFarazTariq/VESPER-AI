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

/**
 * A saved search: its results and when the search was actually made (`checkedAt`, v0.9.8; null for rows saved by
 * older code), so reused results show that date rather than today.
 */
export async function getCachedSearch(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<{ body: string; checkedAt: number | null } | null> {
  try {
    const row = await db
      .prepare("SELECT body, checked_at FROM search_cache WHERE key = ?1 AND expires_at > ?2")
      .bind(key, now)
      .first<{ body: string; checked_at: number | null }>();
    return row ? { body: row.body, checkedAt: row.checked_at ?? null } : null;
  } catch {
    return null;
  }
}

export async function putCachedSearch(db: D1Database, key: string, body: string, ttlMs: number, now = Date.now()): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO search_cache (key, body, expires_at, checked_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at, checked_at = excluded.checked_at`,
      )
      .bind(key, body, now + ttlMs, now)
      .run();
  } catch {
    // not cached: the next identical search just asks the service again
  }
}
