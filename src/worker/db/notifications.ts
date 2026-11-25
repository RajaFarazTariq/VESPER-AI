/**
 * Proactive VESPER (v0.18.0): the browsers that get notifications, each user's notification settings, reminders, and
 * which meeting alerts were already sent. Everything the cron does is claimed with one atomic statement first
 * (a reminder pending → sent, the briefing's day, an event's alert), so two runs at the same time never send twice.
 */
import type { NotificationPrefsDto, PushDeviceDto, ReminderDto } from "../../shared/types";
import { newId } from "../lib/crypto";

export const MAX_DEVICES = 10;
export const MAX_PENDING_REMINDERS = 50;
export const MAX_REMINDERS_PER_DAY = 30;
export const MAX_REMINDER_TEXT = 200;
export const MEETING_MINUTES = [5, 10, 15, 30] as const;
/** From 15:00 local time the briefing is about tomorrow, before that about today (minute of the day). */
export const BRIEFING_TOMORROW_FROM = 15 * 60;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- browsers (push subscriptions)

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
}

/** What sending needs. */
export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const toDevice = (r: Pick<SubscriptionRow, "id" | "label" | "created_at" | "last_ok_at">): PushDeviceDto => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
});

export async function listDevices(db: D1Database, userId: string): Promise<PushDeviceDto[]> {
  const { results } = await db
    .prepare("SELECT id, label, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at")
    .bind(userId)
    .all<SubscriptionRow>();
  return results.map(toDevice);
}

export async function pushTargets(db: D1Database, userId: string): Promise<PushTarget[]> {
  const { results } = await db
    .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at LIMIT ?2")
    .bind(userId, MAX_DEVICES)
    .all<PushTarget>();
  return results;
}

/**
 * Saves a browser (again: the same endpoint is updated, also when it belonged to another account that signed in on that
 * browser before). Null when the user already has the most browsers allowed. One statement, so the limit holds.
 */
export async function saveDevice(
  db: D1Database,
  userId: string,
  device: { endpoint: string; p256dh: string; auth: string; label: string },
  now = Date.now(),
): Promise<PushDeviceDto | null> {
  const result = await db
    .prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at, failures)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0
       WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?2 AND endpoint != ?3) < ?8
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         label = excluded.label, failures = 0`,
    )
    .bind(newId(), userId, device.endpoint, device.p256dh, device.auth, device.label, now, MAX_DEVICES)
    .run();
  if (!result.meta.changes) return null;
  const row = await db
    .prepare("SELECT id, label, created_at, last_ok_at FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2")
    .bind(device.endpoint, userId)
    .first<SubscriptionRow>();
  return row ? toDevice(row) : null;
}

export async function deleteDevice(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM push_subscriptions WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes > 0;
}

/** After sending: delivered (failures reset), gone (deleted), or one more failure (deleted after 5 in a row). */
export async function recordPushResults(db: D1Database, results: { id: string; outcome: "ok" | "gone" | "failed" }[], now = Date.now()): Promise<void> {
  if (results.length === 0) return;
  await db.batch(
    results.flatMap(({ id, outcome }) =>
      outcome === "ok"
        ? [db.prepare("UPDATE push_subscriptions SET last_ok_at = ?2, failures = 0 WHERE id = ?1").bind(id, now)]
        : outcome === "gone"
          ? [db.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(id)]
          : [
              db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?1").bind(id),
              db.prepare("DELETE FROM push_subscriptions WHERE id = ?1 AND failures >= 5").bind(id),
            ],
    ),
  );
}

// ---------------------------------------------------------------- notification settings

export interface PrefsRow {
  user_id: string;
  time_zone: string;
  briefing_enabled: number;
  briefing_minute: number;
  last_briefing_day: string | null;
  meeting_alerts: number;
  meeting_minutes: number;
  meeting_checked_at: number;
  updated_at: number;
}

/** Until the user changes them: the briefing at 22:00 and meeting alerts 10 minutes before, both on. */
export const DEFAULT_PREFS = { timeZone: "UTC", briefingEnabled: true, briefingMinute: 22 * 60, meetingAlerts: true, meetingMinutes: 10 } as const;

const pad = (n: number) => String(n).padStart(2, "0");
export const minuteToTime = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;

export function prefsDto(row: PrefsRow | null): NotificationPrefsDto {
  if (!row) {
    return {
      timeZone: DEFAULT_PREFS.timeZone,
      briefingEnabled: DEFAULT_PREFS.briefingEnabled,
      briefingTime: minuteToTime(DEFAULT_PREFS.briefingMinute),
      meetingAlerts: DEFAULT_PREFS.meetingAlerts,
      meetingMinutes: DEFAULT_PREFS.meetingMinutes,
    };
  }
  return {
    timeZone: row.time_zone,
    briefingEnabled: row.briefing_enabled === 1,
    briefingTime: minuteToTime(row.briefing_minute),
    meetingAlerts: row.meeting_alerts === 1,
    meetingMinutes: row.meeting_minutes,
  };
}

export async function getPrefsRow(db: D1Database, userId: string): Promise<PrefsRow | null> {
  return db.prepare("SELECT * FROM notification_prefs WHERE user_id = ?1").bind(userId).first<PrefsRow>();
}

export interface PrefsPatch {
  timeZone?: string;
  briefingEnabled?: boolean;
  /** Minute of the day, 0..1439. */
  briefingMinute?: number;
  meetingAlerts?: boolean;
  meetingMinutes?: number;
}

/** Saves the given settings (the rest stay as they are, or the defaults for a new row). */
export async function savePrefs(db: D1Database, userId: string, patch: PrefsPatch, now = Date.now()): Promise<NotificationPrefsDto> {
  const flag = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
  const row = await db
    .prepare(
      `INSERT INTO notification_prefs (user_id, time_zone, briefing_enabled, briefing_minute, meeting_alerts, meeting_minutes, updated_at)
       VALUES (?1, COALESCE(?2, ?8), COALESCE(?3, ?9), COALESCE(?4, ?10), COALESCE(?5, ?11), COALESCE(?6, ?12), ?7)
       ON CONFLICT(user_id) DO UPDATE SET
         time_zone = COALESCE(?2, time_zone), briefing_enabled = COALESCE(?3, briefing_enabled),
         briefing_minute = COALESCE(?4, briefing_minute), meeting_alerts = COALESCE(?5, meeting_alerts),
         meeting_minutes = COALESCE(?6, meeting_minutes), updated_at = ?7
       RETURNING *`,
    )
    .bind(
      userId,
      patch.timeZone ?? null,
      flag(patch.briefingEnabled),
      patch.briefingMinute ?? null,
      flag(patch.meetingAlerts),
      patch.meetingMinutes ?? null,
      now,
      DEFAULT_PREFS.timeZone,
      DEFAULT_PREFS.briefingEnabled ? 1 : 0,
      DEFAULT_PREFS.briefingMinute,
      DEFAULT_PREFS.meetingAlerts ? 1 : 0,
      DEFAULT_PREFS.meetingMinutes,
    )
    .first<PrefsRow>();
  return prefsDto(row);
}

// ---------------------------------------------------------------- reminders

interface ReminderRow {
  id: string;
  user_id: string;
  text: string;
  due_at: number;
  time_zone: string;
  status: ReminderDto["status"];
}

const toReminder = (r: ReminderRow): ReminderDto => ({ id: r.id, text: r.text, dueAt: r.due_at, timeZone: r.time_zone, status: r.status });

/** A new pending reminder, or why not: too many pending, or too many made today (UTC). One statement. */
export async function createReminder(
  db: D1Database,
  input: { userId: string; conversationId: string | null; text: string; dueAt: number; timeZone: string },
  now = Date.now(),
): Promise<ReminderDto | "pending_full" | "daily_full"> {
  const id = newId();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const result = await db
    .prepare(
      `INSERT INTO reminders (id, user_id, conversation_id, text, due_at, time_zone, status, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7
       WHERE (SELECT COUNT(*) FROM reminders WHERE user_id = ?2 AND status = 'pending') < ?8
         AND (SELECT COUNT(*) FROM reminders WHERE user_id = ?2 AND created_at >= ?9) < ?10`,
    )
    .bind(id, input.userId, input.conversationId, input.text, input.dueAt, input.timeZone, now, MAX_PENDING_REMINDERS, dayStart, MAX_REMINDERS_PER_DAY)
    .run();
  if (result.meta.changes) return { id, text: input.text, dueAt: input.dueAt, timeZone: input.timeZone, status: "pending" };
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = 'pending'")
    .bind(input.userId)
    .first<{ n: number }>();
  return (pending?.n ?? 0) >= MAX_PENDING_REMINDERS ? "pending_full" : "daily_full";
}

/** Pending reminders, soonest first (optionally only those due in [from, to)). */
export async function listPendingReminders(db: D1Database, userId: string, range?: { from: number; to: number }): Promise<ReminderDto[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, text, due_at, time_zone, status FROM reminders
       WHERE user_id = ?1 AND status = 'pending' AND due_at >= ?2 AND due_at < ?3 ORDER BY due_at LIMIT ?4`,
    )
    .bind(userId, range?.from ?? 0, range?.to ?? Number.MAX_SAFE_INTEGER, MAX_PENDING_REMINDERS)
    .all<ReminderRow>();
  return results.map(toReminder);
}

export async function countPendingReminders(db: D1Database, userId: string, range: { from: number; to: number }): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = 'pending' AND due_at >= ?2 AND due_at < ?3")
    .bind(userId, range.from, range.to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The user's own pending reminder → cancelled; null when there is no such pending reminder. */
export async function cancelReminder(db: D1Database, userId: string, id: string): Promise<ReminderDto | null> {
  const row = await db
    .prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?1 AND user_id = ?2 AND status = 'pending' RETURNING id, user_id, text, due_at, time_zone, status")
    .bind(id, userId)
    .first<ReminderRow>();
  return row ? toReminder(row) : null;
}

// ---------------------------------------------------------------- for the cron (jobs/proactive.ts)

/** Who a notification is for (blocked accounts get none; admins are decided from the configuration). */
export interface NotifyUser {
  user_id: string;
  user_status: "active" | "blocked";
  github_login: string | null;
  email: string | null;
}

export interface DueReminder extends NotifyUser {
  id: string;
  text: string;
  due_at: number;
  time_zone: string;
}

export async function dueReminders(db: D1Database, now: number, limit: number): Promise<DueReminder[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.user_id, r.text, r.due_at, r.time_zone, u.status AS user_status, u.github_login, u.email
       FROM reminders r JOIN users u ON u.id = r.user_id
       WHERE r.status = 'pending' AND r.due_at <= ?1 ORDER BY r.due_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<DueReminder>();
  return results;
}

/** A send that reached no device may be tried this many more times, while at most 15 minutes late. */
export const REMINDER_RETRIES = 2;
const REMINDER_RETRY_MS = 15 * 60_000;

/** No device took it: back to pending (counted), unless tried enough or too late; true when it will be tried again. */
export async function retryReminder(db: D1Database, id: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE reminders SET status = 'pending', sent_at = NULL, attempts = attempts + 1
       WHERE id = ?1 AND status = 'sent' AND attempts < ?2 AND due_at > ?3 RETURNING id`,
    )
    .bind(id, REMINDER_RETRIES, now - REMINDER_RETRY_MS)
    .first();
  return row !== null;
}

/** pending → sent, exactly once: true for the run that changed it. */
export async function claimReminder(db: D1Database, id: string, now: number): Promise<boolean> {
  const row = await db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?2 WHERE id = ?1 AND status = 'pending' RETURNING id").bind(id, now).first();
  return row !== null;
}

export interface BriefingCandidate extends NotifyUser {
  time_zone: string;
  briefing_minute: number;
  last_briefing_day: string | null;
  /** Granted Google scopes when the user has a working connection. */
  google_scopes: string | null;
}

/** Users with the briefing on and at least one browser (whether one is due is worked out per time zone). */
export async function briefingCandidates(db: D1Database, limit: number): Promise<BriefingCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT p.user_id, p.time_zone, p.briefing_minute, p.last_briefing_day, u.status AS user_status, u.github_login, u.email,
         (SELECT g.scopes FROM google_connections g WHERE g.user_id = p.user_id AND g.status = 'connected') AS google_scopes
       FROM notification_prefs p JOIN users u ON u.id = p.user_id
       WHERE p.briefing_enabled = 1 AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)
       ORDER BY p.last_briefing_day IS NOT NULL, p.last_briefing_day LIMIT ?1`,
    )
    .bind(limit)
    .all<BriefingCandidate>();
  return results;
}

/** No device took the briefing about `day`: the day is given back (as before the claim) for another try. */
export async function releaseBriefing(db: D1Database, userId: string, day: string, previous: string | null): Promise<void> {
  await db
    .prepare("UPDATE notification_prefs SET last_briefing_day = ?3 WHERE user_id = ?1 AND last_briefing_day = ?2")
    .bind(userId, day, previous)
    .run();
}

/** The briefing about `day` (local date), exactly once: true for the run that claimed it. */
export async function claimBriefing(db: D1Database, userId: string, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      "UPDATE notification_prefs SET last_briefing_day = ?2 WHERE user_id = ?1 AND briefing_enabled = 1 AND (last_briefing_day IS NULL OR last_briefing_day < ?2) RETURNING user_id",
    )
    .bind(userId, day)
    .first();
  return row !== null;
}

export interface MeetingCandidate extends NotifyUser {
  time_zone: string;
  meeting_minutes: number;
  meeting_checked_at: number;
}

/** Users with meeting alerts on, a browser and a Google connection allowing Calendar, whose calendar is due a look. */
export async function meetingCandidates(db: D1Database, checkedBefore: number, calendarScope: string, limit: number): Promise<MeetingCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT p.user_id, p.time_zone, p.meeting_minutes, p.meeting_checked_at, u.status AS user_status, u.github_login, u.email
       FROM notification_prefs p
       JOIN users u ON u.id = p.user_id
       JOIN google_connections g ON g.user_id = p.user_id AND g.status = 'connected' AND instr(g.scopes, ?2) > 0
       WHERE p.meeting_alerts = 1 AND p.meeting_checked_at <= ?1 AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)
       ORDER BY p.meeting_checked_at LIMIT ?3`,
    )
    .bind(checkedBefore, calendarScope, limit)
    .all<MeetingCandidate>();
  return results;
}

/** Moves the user's calendar check time from `seen` to `next`; true for the run that did it (the other one skips). */
export async function claimMeetingCheck(db: D1Database, userId: string, seen: number, next: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE notification_prefs SET meeting_checked_at = ?3 WHERE user_id = ?1 AND meeting_checked_at = ?2")
    .bind(userId, seen, next)
    .run();
  return result.meta.changes > 0;
}

export async function setMeetingCheck(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE notification_prefs SET meeting_checked_at = ?2 WHERE user_id = ?1").bind(userId, at).run();
}

/** An event's alert, exactly once: true for the run that recorded it. */
export async function claimMeetingAlert(db: D1Database, userId: string, eventKey: string, now: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO meeting_alerts_sent (user_id, event_key, sent_at) VALUES (?1, ?2, ?3)")
    .bind(userId, eventKey, now)
    .run();
  return result.meta.changes > 0;
}

/** Daily clean-up: alert records after 2 days, sent and cancelled reminders after 30 days. */
export function notificationCleanup(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM meeting_alerts_sent WHERE sent_at < ?1").bind(now - 2 * DAY_MS),
    db.prepare("DELETE FROM reminders WHERE status IN ('sent', 'cancelled') AND COALESCE(sent_at, created_at) < ?1").bind(now - 30 * DAY_MS),
  ];
}
