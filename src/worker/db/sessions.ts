import type { AppConfig } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { toSessionUser, USER_COLUMNS, type SessionUser, type UserRow } from "./users";

/** Refresh last_seen/expiry at most this often, to keep D1 writes low. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export async function createSession(
  db: D1Database,
  userId: string,
  ttlMs: number,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?3, ?5)`,
    )
    .bind(await sha256Hex(token), userId, now, expiresAt, userAgent?.slice(0, 300) ?? null)
    .run();
  return { token, expiresAt };
}

type SessionJoinRow = UserRow & { session_id: string; expires_at: number; last_seen_at: number };

const USER_COLUMNS_U = USER_COLUMNS.split(", ")
  .map((c) => `u.${c}`)
  .join(", ");

/**
 * Resolve a session token to its user. Sliding expiry: active sessions are extended,
 * but the row is only rewritten once per TOUCH_INTERVAL_MS.
 */
export async function getSessionUser(
  db: D1Database,
  token: string,
  config: AppConfig,
): Promise<{ user: SessionUser; refreshedExpiry: number | null } | null> {
  if (!token || token.length > 200) return null;
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, ${USER_COLUMNS_U}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1 AND s.expires_at > ?2`,
    )
    .bind(await sha256Hex(token), now)
    .first<SessionJoinRow>();
  if (!row) return null;

  let refreshedExpiry: number | null = null;
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    refreshedExpiry = now + config.sessionTtlMs;
    await db
      .prepare("UPDATE sessions SET last_seen_at = ?1, expires_at = ?2 WHERE id = ?3")
      .bind(now, refreshedExpiry, row.session_id)
      .run();
  }
  return { user: toSessionUser(row, config), refreshedExpiry };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256Hex(token)).run();
}

/** Sign a user out everywhere (used when an admin blocks them). */
export async function deleteUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
}
