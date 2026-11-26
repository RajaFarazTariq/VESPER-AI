/**
 * Google Calendar and Gmail (v0.15.0): each user's Google connection (encrypted tokens) and the emails and calendar
 * events VESPER prepared, waiting for or given the user's approval. Same rules as GitHub changes (db/github.ts): what
 * will be sent is kept only until the user decides (at most 24 hours); afterwards a log line stays for 90 days.
 */
import type {
  GoogleActionDto,
  GoogleActionKind,
  GoogleActionStatus,
  GoogleEmailPreviewDto,
  GoogleEventOp,
  GoogleEventPreviewDto,
} from "../../shared/types";

export interface GoogleConnectionRow {
  user_id: string;
  google_sub: string;
  email: string;
  /** Space-separated, as Google granted them. */
  scopes: string;
  /** Encrypted (lib/secret-box). */
  access_token: string;
  access_expires_at: number;
  /** Encrypted. */
  refresh_token: string;
  status: "connected" | "reconnect";
  created_at: number;
  updated_at: number;
}

export interface NewGoogleConnection {
  sub: string;
  email: string;
  scopes: string[];
  accessToken: string; // already encrypted
  accessExpiresAt: number;
  refreshToken: string; // already encrypted
}

export async function getGoogleConnection(db: D1Database, userId: string): Promise<GoogleConnectionRow | null> {
  return db.prepare("SELECT * FROM google_connections WHERE user_id = ?1").bind(userId).first<GoogleConnectionRow>();
}

/** Save (or replace) the user's connection. */
export async function saveGoogleConnection(db: D1Database, userId: string, c: NewGoogleConnection, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO google_connections (user_id, google_sub, email, scopes, access_token, access_expires_at, refresh_token,
                                       status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'connected', ?8, ?8)
       ON CONFLICT(user_id) DO UPDATE SET google_sub = excluded.google_sub, email = excluded.email, scopes = excluded.scopes,
         access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
         refresh_token = excluded.refresh_token, status = 'connected', updated_at = excluded.updated_at`,
    )
    .bind(userId, c.sub, c.email, c.scopes.join(" "), c.accessToken, c.accessExpiresAt, c.refreshToken, now)
    .run();
}

/** A renewed access token (Google keeps the same refresh token). */
export async function saveGoogleAccess(db: D1Database, userId: string, accessToken: string, accessExpiresAt: number, now = Date.now()): Promise<void> {
  await db
    .prepare("UPDATE google_connections SET access_token = ?2, access_expires_at = ?3, updated_at = ?4 WHERE user_id = ?1 AND status = 'connected'")
    .bind(userId, accessToken, accessExpiresAt, now)
    .run();
}

/** Google ended the access: keep the row (for "Reconnect"). */
export async function markGoogleReconnect(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE google_connections SET status = 'reconnect', updated_at = ?2 WHERE user_id = ?1").bind(userId, now).run();
}

export async function deleteGoogleConnection(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM google_connections WHERE user_id = ?1").bind(userId).run();
}

// --- Emails and events waiting for approval ---------------------------------------------

/** A prepared email or event waits this long for Approve / Reject. */
export const GOOGLE_ACTION_TTL_MS = 24 * 60 * 60_000;
/** The log (kind, subject or title, recipients or time, outcome, link) is kept this long. */
export const GOOGLE_ACTION_LOG_MS = 90 * 24 * 60 * 60_000;
/** Still "running" after this long: the worker stopped half-way; it's marked failed. */
const RUNNING_STALE_MS = 10 * 60_000;

/** An event's guest as Google lists it, kept so a change doesn't reset the guests' replies (v0.19.0). */
export interface GoogleGuest {
  email: string;
  self?: boolean;
  optional?: boolean;
  responseStatus?: string;
  displayName?: string;
}

/** A change to an existing event (v0.19.0): what it is now (`before`, at Google's `version`) and what it becomes. */
export interface EventUpdatePayload {
  kind: "event";
  op: "update";
  eventId: string;
  /**
   * Google's etag (else `updated`) when the card was made: approving changes the event only while it is still exactly
   * that (sent as If-Match when it is an etag, so nothing can slip in between).
   */
  version: string;
  /** The version is Google's etag (not `updated`). */
  etag?: boolean;
  before: GoogleEventPreviewDto;
  /** Not named `event`, so v0.18 code (after a revert) fails on it instead of adding it as a new event. */
  after: GoogleEventPreviewDto;
  guests: GoogleGuest[];
}

export interface EventDeletePayload {
  kind: "event";
  op: "delete";
  eventId: string;
  version: string;
  etag?: boolean;
  before: GoogleEventPreviewDto;
}

/**
 * What is stored for sending: the email, or the event, exactly as it will go to Google; or (v0.19.0) the change to,
 * or the cancellation of, an existing event. kind stays "event" for those (its CHECK can't change), with `op`.
 */
export type GooglePayload =
  | { kind: "email"; email: GoogleEmailPreviewDto }
  | { kind: "event"; op?: undefined; event: GoogleEventPreviewDto }
  | EventUpdatePayload
  | EventDeletePayload;

interface GoogleActionRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  kind: GoogleActionKind;
  title: string;
  target: string;
  warnings: string;
  payload: string | null;
  status: GoogleActionStatus;
  result_url: string | null;
  error: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  /** v0.19.0: 'update' / 'delete' for a change to an existing event; NULL otherwise (and on older rows). */
  op?: string | null;
}

export interface NewGoogleAction {
  userId: string;
  conversationId: string | null;
  title: string;
  target: string;
  warnings: string[];
  payload: GooglePayload;
}

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function toActionDto(row: GoogleActionRow, now: number): GoogleActionDto {
  // A pending one past its time shows as expired even before the daily clean-up marks it.
  const expired = row.status === "pending" && row.expires_at <= now;
  const payload = expired ? null : parseJson<GooglePayload | null>(row.payload, null);
  const event = payload?.kind === "event" ? payload : null;
  // Changing or cancelling an event (v0.19.0): the column keeps it once the payload is gone.
  const op: GoogleEventOp | null = row.op === "update" || row.op === "delete" ? row.op : event?.op ?? null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    target: row.target,
    status: expired ? "expired" : row.status,
    warnings: parseJson<string[]>(row.warnings, []),
    email: payload?.kind === "email" ? payload.email : null,
    event: event ? (event.op === "update" ? event.after : event.op === "delete" ? null : event.event) : null,
    ...(op ? { op, before: event?.op ? event.before : null } : {}),
    resultUrl: row.result_url,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

/** A log line: what it was and how it went, without the email or event itself. */
const withoutText = (a: GoogleActionDto): GoogleActionDto => ({ ...a, email: null, event: null, ...(a.op ? { before: null } : {}) });

export async function createGoogleAction(db: D1Database, action: NewGoogleAction, now = Date.now()): Promise<GoogleActionDto> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO google_actions (id, user_id, conversation_id, kind, title, target, warnings, payload, status, created_at, expires_at, op)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11)`,
    )
    .bind(
      id,
      action.userId,
      action.conversationId,
      action.payload.kind,
      action.title,
      action.target,
      JSON.stringify(action.warnings),
      JSON.stringify(action.payload),
      now,
      now + GOOGLE_ACTION_TTL_MS,
      action.payload.kind === "event" ? action.payload.op ?? null : null,
    )
    .run();
  return (await getGoogleAction(db, action.userId, id, now))!;
}

/** One of the user's own (null when it isn't theirs or doesn't exist). */
export async function getGoogleAction(db: D1Database, userId: string, id: string, now = Date.now()): Promise<GoogleActionDto | null> {
  const row = await db.prepare("SELECT * FROM google_actions WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<GoogleActionRow>();
  return row ? toActionDto(row, now) : null;
}

/**
 * Take a pending one for sending: succeeds once, only for its owner and only before it expires, so two clicks (or two
 * tabs) can't send it twice. Returns what to send, or null.
 */
export async function claimGoogleAction(db: D1Database, userId: string, id: string, now = Date.now()): Promise<GooglePayload | null> {
  const row = await db
    .prepare(
      `UPDATE google_actions SET status = 'running', decided_at = ?3
       WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?3
       RETURNING payload`,
    )
    .bind(id, userId, now)
    .first<{ payload: string | null }>();
  return row?.payload ? parseJson<GooglePayload | null>(row.payload, null) : null;
}

/** Put a claimed one back to waiting (nothing was sent: e.g. the daily limit was reached). */
export async function unclaimGoogleAction(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE google_actions SET status = 'pending', decided_at = NULL WHERE id = ?1 AND status = 'running'").bind(id).run();
}

/** The email as the user approved it (they may have edited it on the card): the log line follows the edit. */
export async function updateClaimedEmail(db: D1Database, id: string, payload: GooglePayload, title: string, target: string): Promise<void> {
  await db
    .prepare("UPDATE google_actions SET payload = ?2, title = ?3, target = ?4 WHERE id = ?1 AND status = 'running'")
    .bind(id, JSON.stringify(payload), title, target)
    .run();
}

/** The outcome of sending; what was sent is no longer kept (the log line and link stay). */
export async function finishGoogleAction(
  db: D1Database,
  id: string,
  outcome: { status: "done"; resultUrl: string | null } | { status: "failed"; error: string },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE google_actions SET status = ?2, result_url = ?3, error = ?4, decided_at = ?5, payload = NULL
       WHERE id = ?1 AND status = 'running'`,
    )
    .bind(id, outcome.status, outcome.status === "done" ? outcome.resultUrl : null, outcome.status === "failed" ? outcome.error.slice(0, 500) : null, now)
    .run();
}

/** The user said no: nothing is sent, and the prepared text isn't kept. */
export async function rejectGoogleAction(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE google_actions SET status = 'rejected', decided_at = ?3, payload = NULL
       WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
    )
    .bind(id, userId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Emails and events still waiting for this user's decision (to cap how many can pile up). */
export async function countPendingGoogleActions(db: D1Database, userId: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM google_actions WHERE user_id = ?1 AND status = 'pending' AND expires_at > ?2")
    .bind(userId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The user's latest, newest first, without their text (Settings → Connections). */
export async function listGoogleActions(db: D1Database, userId: string, limit = 20, now = Date.now()): Promise<GoogleActionDto[]> {
  const { results } = await db
    .prepare("SELECT * FROM google_actions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2")
    .bind(userId, limit)
    .all<GoogleActionRow>();
  return results.map((r) => withoutText(toActionDto(r, now)));
}

/** Those prepared in one chat (newest first), so the next answer knows what was approved, rejected or still waits. */
export async function conversationGoogleActions(db: D1Database, userId: string, conversationId: string, now = Date.now()): Promise<GoogleActionDto[]> {
  const { results } = await db
    .prepare("SELECT * FROM google_actions WHERE user_id = ?1 AND conversation_id = ?2 ORDER BY created_at DESC LIMIT 10")
    .bind(userId, conversationId)
    .all<GoogleActionRow>();
  return results.map((r) => withoutText(toActionDto(r, now)));
}

/**
 * Pending ones whose card went away (the answer was regenerated or edited, or the reply was stopped before it was
 * saved), or all of the user's pending ones (they disconnected Google): they can't be approved any more.
 */
export async function expireGoogleActions(
  db: D1Database,
  userId: string,
  where: { ids: string[] } | { conversationId: string; since: number } | { all: true },
  now = Date.now(),
): Promise<void> {
  const set = "status = 'expired', decided_at = ?2, payload = NULL";
  if ("all" in where) {
    await db.prepare(`UPDATE google_actions SET ${set} WHERE user_id = ?1 AND status = 'pending'`).bind(userId, now).run();
    return;
  }
  if ("ids" in where) {
    if (where.ids.length === 0) return;
    await db.batch(
      where.ids
        .slice(0, 20)
        .map((id) => db.prepare(`UPDATE google_actions SET ${set} WHERE user_id = ?1 AND id = ?3 AND status = 'pending'`).bind(userId, now, id)),
    );
    return;
  }
  await db
    .prepare(`UPDATE google_actions SET ${set} WHERE user_id = ?1 AND conversation_id = ?3 AND created_at >= ?4 AND status = 'pending'`)
    .bind(userId, now, where.conversationId, where.since)
    .run();
}

/** Daily clean-up: expire undecided ones, close ones cut off half-way, forget log lines after 90 days. */
export function googleActionCleanup(db: D1Database, now = Date.now()): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE google_actions SET status = 'expired', decided_at = ?1, payload = NULL WHERE status = 'pending' AND expires_at <= ?1").bind(now),
    db
      .prepare(
        `UPDATE google_actions SET status = 'failed', payload = NULL,
           error = 'Stopped half-way. Check Gmail (Sent) or your calendar before trying again.'
         WHERE status = 'running' AND decided_at < ?1`,
      )
      .bind(now - RUNNING_STALE_MS),
    db.prepare("DELETE FROM google_actions WHERE created_at < ?1").bind(now - GOOGLE_ACTION_LOG_MS),
  ];
}
