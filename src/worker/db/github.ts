/** GitHub connections (encrypted tokens) and the short per-user GitHub response cache (v0.12.0). */

export interface GithubConnectionRow {
  user_id: string;
  github_id: number;
  login: string;
  /** Encrypted (lib/secret-box). */
  access_token: string;
  access_expires_at: number;
  refresh_token: string | null;
  refresh_expires_at: number | null;
  status: "connected" | "reconnect";
  refreshing_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewGithubConnection {
  githubId: number;
  login: string;
  accessToken: string; // already encrypted
  accessExpiresAt: number;
  refreshToken: string | null; // already encrypted
  refreshExpiresAt: number | null;
}

export async function getGithubConnection(db: D1Database, userId: string): Promise<GithubConnectionRow | null> {
  return db.prepare("SELECT * FROM github_connections WHERE user_id = ?1").bind(userId).first<GithubConnectionRow>();
}

/** Save (or replace) the user's connection; a new connection also clears the old cache. */
export async function saveGithubConnection(db: D1Database, userId: string, c: NewGithubConnection): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO github_connections (user_id, github_id, login, access_token, access_expires_at, refresh_token,
                                         refresh_expires_at, status, refreshing_until, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'connected', NULL, ?8, ?8)
         ON CONFLICT(user_id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
           status = 'connected', refreshing_until = NULL, updated_at = excluded.updated_at`,
      )
      .bind(userId, c.githubId, c.login, c.accessToken, c.accessExpiresAt, c.refreshToken, c.refreshExpiresAt, now),
    db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId),
  ]);
}

/**
 * Take the renewal lock: succeeds for one caller only, and only while the token is still the one it saw (so a
 * renewal that already happened isn't repeated). The lock lapses after 30 seconds in case a worker dies mid-way.
 */
export async function lockGithubRefresh(db: D1Database, userId: string, seenExpiresAt: number, now = Date.now()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE github_connections SET refreshing_until = ?3
       WHERE user_id = ?1 AND status = 'connected' AND access_expires_at = ?2
         AND (refreshing_until IS NULL OR refreshing_until < ?4)`,
    )
    .bind(userId, seenExpiresAt, now + 30_000, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function saveRefreshedTokens(
  db: D1Database,
  userId: string,
  tokens: { accessToken: string; accessExpiresAt: number; refreshToken: string | null; refreshExpiresAt: number | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_connections SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4, refresh_expires_at = ?5,
         refreshing_until = NULL, updated_at = ?6 WHERE user_id = ?1`,
    )
    .bind(userId, tokens.accessToken, tokens.accessExpiresAt, tokens.refreshToken, tokens.refreshExpiresAt, Date.now())
    .run();
}

export async function unlockGithubRefresh(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE github_connections SET refreshing_until = NULL WHERE user_id = ?1").bind(userId).run();
}

/** GitHub said the access is gone: keep the row (for "Reconnect"), drop its cached data. */
export async function markGithubReconnect(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE github_connections SET status = 'reconnect', refreshing_until = NULL, updated_at = ?2 WHERE user_id = ?1").bind(userId, Date.now()),
    db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId),
  ]);
}

export async function deleteGithubConnection(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM github_connections WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId),
  ]);
}

// --- Short cache (≤ 15 minutes) -------------------------------------------------------

export interface GithubCacheEntry {
  etag: string | null;
  body: string;
  fresh_until: number;
  expires_at: number;
}

export async function getGithubCache(db: D1Database, userId: string, key: string, now = Date.now()): Promise<GithubCacheEntry | null> {
  const row = await db
    .prepare("SELECT etag, body, fresh_until, expires_at FROM github_cache WHERE user_id = ?1 AND key = ?2")
    .bind(userId, key)
    .first<GithubCacheEntry>();
  return row && row.expires_at > now ? row : null;
}

/** Store a response, and remove this user's expired entries in the same go. */
export async function putGithubCache(
  db: D1Database,
  userId: string,
  key: string,
  entry: GithubCacheEntry,
  now = Date.now(),
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM github_cache WHERE user_id = ?1 AND expires_at < ?2").bind(userId, now),
    db
      .prepare(
        `INSERT INTO github_cache (user_id, key, etag, body, fresh_until, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id, key) DO UPDATE SET etag = excluded.etag, body = excluded.body,
           fresh_until = excluded.fresh_until, expires_at = excluded.expires_at`,
      )
      .bind(userId, key, entry.etag, entry.body, entry.fresh_until, entry.expires_at),
  ]);
}
