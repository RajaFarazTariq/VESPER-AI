/**
 * GitHub connections (encrypted tokens), the short per-user GitHub response cache (v0.12.0) and the GitHub changes
 * waiting for or given the user's approval (v0.13.0).
 *
 * There are two connections per user: "reader" (the VESPER AI Reader app, read-only) and "actions" (the separate
 * Actions app that makes approved changes). Same columns, different tables, so each can be connected, renewed and
 * removed on its own.
 */
import type { GithubActionDto, GithubActionKind, GithubActionPreviewDto, GithubActionStatus } from "../../shared/types";

export type GithubAppKind = "reader" | "actions";
const TABLE: Record<GithubAppKind, string> = { reader: "github_connections", actions: "github_action_connections" };

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

export async function getGithubConnection(db: D1Database, userId: string, kind: GithubAppKind = "reader"): Promise<GithubConnectionRow | null> {
  return db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE user_id = ?1`).bind(userId).first<GithubConnectionRow>();
}

/** Save (or replace) the user's connection; a new reading connection also clears the old cache. */
export async function saveGithubConnection(db: D1Database, userId: string, c: NewGithubConnection, kind: GithubAppKind = "reader"): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO ${TABLE[kind]} (user_id, github_id, login, access_token, access_expires_at, refresh_token,
                                         refresh_expires_at, status, refreshing_until, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'connected', NULL, ?8, ?8)
         ON CONFLICT(user_id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
           status = 'connected', refreshing_until = NULL, updated_at = excluded.updated_at`,
      )
      .bind(userId, c.githubId, c.login, c.accessToken, c.accessExpiresAt, c.refreshToken, c.refreshExpiresAt, now),
    ...(kind === "reader" ? [db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId)] : []),
  ]);
}

/**
 * Take the renewal lock: succeeds for one caller only, and only while the token is still the one it saw (so a
 * renewal that already happened isn't repeated). The lock lapses after 30 seconds in case a worker dies mid-way.
 */
export async function lockGithubRefresh(
  db: D1Database,
  userId: string,
  seenExpiresAt: number,
  now = Date.now(),
  kind: GithubAppKind = "reader",
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${TABLE[kind]} SET refreshing_until = ?3
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
  kind: GithubAppKind = "reader",
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${TABLE[kind]} SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4, refresh_expires_at = ?5,
         refreshing_until = NULL, updated_at = ?6 WHERE user_id = ?1`,
    )
    .bind(userId, tokens.accessToken, tokens.accessExpiresAt, tokens.refreshToken, tokens.refreshExpiresAt, Date.now())
    .run();
}

export async function unlockGithubRefresh(db: D1Database, userId: string, kind: GithubAppKind = "reader"): Promise<void> {
  await db.prepare(`UPDATE ${TABLE[kind]} SET refreshing_until = NULL WHERE user_id = ?1`).bind(userId).run();
}

/** GitHub said the access is gone: keep the row (for "Reconnect"), drop its cached data. */
export async function markGithubReconnect(db: D1Database, userId: string, kind: GithubAppKind = "reader"): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE ${TABLE[kind]} SET status = 'reconnect', refreshing_until = NULL, updated_at = ?2 WHERE user_id = ?1`).bind(userId, Date.now()),
    ...(kind === "reader" ? [db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId)] : []),
  ]);
}

export async function deleteGithubConnection(db: D1Database, userId: string, kind: GithubAppKind = "reader"): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM ${TABLE[kind]} WHERE user_id = ?1`).bind(userId),
    ...(kind === "reader" ? [db.prepare("DELETE FROM github_cache WHERE user_id = ?1").bind(userId)] : []),
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

// --- GitHub changes waiting for, or given, the user's approval (v0.13.0) ---------------

/** A prepared change waits this long for Approve / Reject. */
export const ACTION_TTL_MS = 24 * 60 * 60_000;
/** The log (kind, repo, title, outcome, link) is kept this long. */
export const ACTION_LOG_MS = 90 * 24 * 60 * 60_000;
/** A change still "running" after this long was cut off half-way (the worker stopped): it's marked failed. */
const RUNNING_STALE_MS = 10 * 60_000;

interface GithubActionRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  kind: GithubActionKind;
  repo: string;
  title: string;
  public_repo: number;
  warnings: string;
  payload: string | null;
  preview: string | null;
  status: GithubActionStatus;
  result_url: string | null;
  error: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

export interface NewGithubAction {
  userId: string;
  conversationId: string | null;
  kind: GithubActionKind;
  repo: string;
  title: string;
  publicRepo: boolean;
  warnings: string[];
  /** Exactly what will be sent (JSON-able); read back by the approve step. */
  payload: unknown;
  preview: GithubActionPreviewDto;
}

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function toActionDto(row: GithubActionRow, now: number): GithubActionDto {
  // A pending change past its time shows as expired even before the daily clean-up marks it.
  const expired = row.status === "pending" && row.expires_at <= now;
  return {
    id: row.id,
    kind: row.kind,
    repo: row.repo,
    title: row.title,
    status: expired ? "expired" : row.status,
    publicRepo: row.public_repo === 1,
    warnings: parseJson<string[]>(row.warnings, []),
    preview: expired ? null : parseJson<GithubActionPreviewDto | null>(row.preview, null),
    resultUrl: row.result_url,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

export async function createGithubAction(db: D1Database, action: NewGithubAction, now = Date.now()): Promise<GithubActionDto> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO github_actions (id, user_id, conversation_id, kind, repo, title, public_repo, warnings, payload, preview,
                                   status, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)`,
    )
    .bind(
      id,
      action.userId,
      action.conversationId,
      action.kind,
      action.repo,
      action.title,
      action.publicRepo ? 1 : 0,
      JSON.stringify(action.warnings),
      JSON.stringify(action.payload),
      JSON.stringify(action.preview),
      now,
      now + ACTION_TTL_MS,
    )
    .run();
  return (await getGithubAction(db, action.userId, id, now))!;
}

/** One of the user's own changes (null when it isn't theirs or doesn't exist). */
export async function getGithubAction(db: D1Database, userId: string, id: string, now = Date.now()): Promise<GithubActionDto | null> {
  const row = await db.prepare("SELECT * FROM github_actions WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<GithubActionRow>();
  return row ? toActionDto(row, now) : null;
}

/**
 * Take a pending change for sending: succeeds once, only for its owner and only before it expires, so two clicks (or
 * two tabs) can't send it twice. Returns what to send, or null.
 */
export async function claimGithubAction(
  db: D1Database,
  userId: string,
  id: string,
  now = Date.now(),
): Promise<{ kind: GithubActionKind; repo: string; payload: unknown } | null> {
  const row = await db
    .prepare(
      `UPDATE github_actions SET status = 'running', decided_at = ?3
       WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?3
       RETURNING kind, repo, payload`,
    )
    .bind(id, userId, now)
    .first<{ kind: GithubActionKind; repo: string; payload: string | null }>();
  if (!row?.payload) return null;
  return { kind: row.kind, repo: row.repo, payload: parseJson<unknown>(row.payload, null) };
}

/** Put a claimed change back to waiting (nothing was sent: e.g. the daily limit was reached). */
export async function unclaimGithubAction(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE github_actions SET status = 'pending', decided_at = NULL WHERE id = ?1 AND status = 'running'").bind(id).run();
}

/** The outcome of sending; what was sent and the preview are no longer kept (the log line and link stay). */
export async function finishGithubAction(
  db: D1Database,
  id: string,
  outcome: { status: "done"; resultUrl: string } | { status: "failed"; error: string },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_actions SET status = ?2, result_url = ?3, error = ?4, decided_at = ?5, payload = NULL, preview = NULL
       WHERE id = ?1 AND status = 'running'`,
    )
    .bind(
      id,
      outcome.status,
      outcome.status === "done" ? outcome.resultUrl : null,
      outcome.status === "failed" ? outcome.error.slice(0, 500) : null,
      now,
    )
    .run();
}

/** The user said no: nothing is sent, and the prepared text isn't kept. */
export async function rejectGithubAction(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE github_actions SET status = 'rejected', decided_at = ?3, payload = NULL, preview = NULL
       WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
    )
    .bind(id, userId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Changes still waiting for this user's decision (to cap how many can pile up). */
export async function countPendingGithubActions(db: D1Database, userId: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM github_actions WHERE user_id = ?1 AND status = 'pending' AND expires_at > ?2")
    .bind(userId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The user's latest changes, newest first, without their text (Settings → Connections). */
export async function listGithubActions(db: D1Database, userId: string, limit = 20, now = Date.now()): Promise<GithubActionDto[]> {
  const { results } = await db
    .prepare("SELECT * FROM github_actions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2")
    .bind(userId, limit)
    .all<GithubActionRow>();
  return results.map((r) => ({ ...toActionDto(r, now), preview: null }));
}

/** Changes prepared in one chat (newest first), so the next answer knows what was approved, rejected or still waits. */
export async function conversationGithubActions(db: D1Database, userId: string, conversationId: string, now = Date.now()): Promise<GithubActionDto[]> {
  const { results } = await db
    .prepare("SELECT * FROM github_actions WHERE user_id = ?1 AND conversation_id = ?2 ORDER BY created_at DESC LIMIT 10")
    .bind(userId, conversationId)
    .all<GithubActionRow>();
  return results.map((r) => ({ ...toActionDto(r, now), preview: null }));
}

/**
 * Pending changes whose card went away (the answer was regenerated or edited, or the reply was stopped before it was
 * saved), or all of the user's pending changes (they disconnected GitHub changes): they can't be approved any more.
 */
export async function expireGithubActions(
  db: D1Database,
  userId: string,
  where: { ids: string[] } | { conversationId: string; since: number } | { all: true },
  now = Date.now(),
): Promise<void> {
  const set = "status = 'expired', decided_at = ?2, payload = NULL, preview = NULL";
  if ("all" in where) {
    await db.prepare(`UPDATE github_actions SET ${set} WHERE user_id = ?1 AND status = 'pending'`).bind(userId, now).run();
    return;
  }
  if ("ids" in where) {
    if (where.ids.length === 0) return;
    await db.batch(
      where.ids
        .slice(0, 20)
        .map((id) => db.prepare(`UPDATE github_actions SET ${set} WHERE user_id = ?1 AND id = ?3 AND status = 'pending'`).bind(userId, now, id)),
    );
    return;
  }
  await db
    .prepare(`UPDATE github_actions SET ${set} WHERE user_id = ?1 AND conversation_id = ?3 AND created_at >= ?4 AND status = 'pending'`)
    .bind(userId, now, where.conversationId, where.since)
    .run();
}

/** Daily clean-up: expire undecided changes, close ones cut off half-way, forget log lines after 90 days. */
export function githubActionCleanup(db: D1Database, now = Date.now()): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE github_actions SET status = 'expired', decided_at = ?1, payload = NULL, preview = NULL WHERE status = 'pending' AND expires_at <= ?1",
      )
      .bind(now),
    db
      .prepare(
        `UPDATE github_actions SET status = 'failed', payload = NULL, preview = NULL,
           error = 'Stopped half-way. Check GitHub to see what was created before trying again.'
         WHERE status = 'running' AND decided_at < ?1`,
      )
      .bind(now - RUNNING_STALE_MS),
    db.prepare("DELETE FROM github_actions WHERE created_at < ?1").bind(now - ACTION_LOG_MS),
  ];
}
