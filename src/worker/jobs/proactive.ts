/**
 * Proactive VESPER (v0.18.0): the every-minute cron run. It sends
 * 1. reminders that are due ("Reminder" · the text · the local time),
 * 2. meeting alerts N minutes before each Google Calendar event ("In 10 minutes: Team standup" · "10:00–10:30"),
 * 3. the daily briefing at the time each user picked ("Your briefing for tomorrow" · "3 events, first at 09:30 (Team
 *    standup) · 2 reminders. Tap to hear it."); tapping it opens VESPER Agent, which reads the spoken briefing.
 *
 * Nothing here asks a model: the texts are built from the data. A run must stay far under the free plan's 10 ms of CPU,
 * so it does a capped amount of work (at most 25 notifications and 10 calendar reads; the rest goes the next minute;
 * database and network waits don't count as CPU). Everything is claimed with one atomic statement before it is sent,
 * so two runs at the same time never send anything twice.
 */
import type { AppSettingsDto, PushPayload } from "../../shared/types";
import { getAppSettings } from "../db/app-settings";
import {
  BRIEFING_TOMORROW_FROM,
  briefingCandidates,
  claimBriefing,
  claimMeetingAlert,
  claimMeetingCheck,
  claimReminder,
  countPendingReminders,
  dueReminders,
  meetingCandidates,
  minuteToTime,
  pushTargets,
  releaseBriefing,
  retryReminder,
  setMeetingCheck,
  type NotifyUser,
  type PushTarget,
} from "../db/notifications";
import { roleOf } from "../db/users";
import { getConfig, type AppConfig, type Env } from "../env";
import { vapidKeys, type VapidKeys } from "../push/keys";
import { deliver, type PushOptions } from "../push/send";
import { googleAllowed } from "../routes/connections";
import { addDays, calendarItems, validTimeZone, wallClock, zonedInstant, type CalendarItem } from "../tools/google";
import { CALENDAR_SCOPE, googleAccess } from "../tools/google-client";

export const RUN_LIMITS = {
  /** Notifications posted per run (each browser counts). */
  pushes: 25,
  /** Calendars read per run (meeting alerts and briefings together). */
  calendars: 10,
  briefings: 10,
  reminders: 25,
  /** Users with the briefing on whose local time is checked per run. */
  briefingScan: 200,
};
/** Each user's calendar is read at most this often for meeting alerts (more often only right at an alert time). */
export const MEETING_CHECK_MS = 5 * 60_000;
/** A briefing that couldn't go at its minute (busy runs, a pause) still goes within this many minutes, not later. */
const BRIEFING_WINDOW_MS = 30 * 60_000;
/** A briefing no device took is tried again in the next runs, while it is at most this late (so about 3 tries). */
const BRIEFING_RETRY_MS = 3 * 60_000;
/** Daylight saving moves the local clock by at most this much: rows further from their time are skipped cheaply. */
const CLOCK_SHIFT_MIN = 120;

const REMINDER_PUSH: PushOptions = { ttl: 3600, urgency: "high" };
const MEETING_PUSH: PushOptions = { ttl: 3600, urgency: "high" };
const BRIEFING_PUSH: PushOptions = { ttl: 7200, urgency: "normal" };

export interface ProactiveReport {
  reminders: number;
  meetings: number;
  briefings: number;
  sent: number;
  failed: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const zoneOrUtc = (tz: string) => validTimeZone(tz) ?? "UTC";
const clockOf = (ms: number, timeZone: string) => wallClock(ms, timeZone).time;

// ---------------------------------------------------------------- the notification texts (pure)

export function reminderPayload(r: { id: string; text: string; due_at: number; time_zone: string }): PushPayload {
  return { title: "Reminder", body: `${r.text} · ${clockOf(r.due_at, zoneOrUtc(r.time_zone))}`, url: "/", tag: `reminder-${r.id}`, kind: "reminder" };
}

export function meetingPayload(e: CalendarItem, timeZone: string, now: number): PushPayload {
  const minutes = Math.max(1, Math.round((e.start - now) / 60_000));
  return {
    title: `In ${plural(minutes, "minute")}: ${e.title}`,
    body: `${clockOf(e.start, timeZone)}–${clockOf(e.end, timeZone)}${e.meet ? " · Google Meet" : ""}`,
    url: "/",
    tag: `meeting-${e.key}`.slice(0, 120),
    kind: "meeting",
  };
}

/** "3 events, first at 09:30 (Team standup) · 2 reminders. Tap to hear it." (events only when the calendar was read). */
export function briefingPayload(
  due: { day: "today" | "tomorrow"; about: string },
  input: { events: CalendarItem[] | null; reminders: number; dayStart: number; timeZone: string },
): PushPayload {
  const parts: string[] = [];
  if (input.events) {
    const first = input.events.filter((e) => !e.allDay && e.start >= input.dayStart).sort((a, b) => a.start - b.start)[0];
    parts.push(
      input.events.length === 0
        ? "No events"
        : `${plural(input.events.length, "event")}${first ? `, first at ${clockOf(first.start, input.timeZone)} (${first.title.slice(0, 50)})` : ""}`,
    );
  }
  if (input.reminders > 0) parts.push(plural(input.reminders, "reminder"));
  return {
    title: `Your briefing for ${due.day}`,
    body: parts.length ? `${parts.join(" · ")}. Tap to hear it.` : "Tap to hear it.",
    // The day it is about goes with the link, so tapping it later (after midnight) still briefs on the same day.
    url: `/?agent=briefing&day=${due.about}`,
    tag: "briefing",
    kind: "briefing",
  };
}

export interface BriefingDue {
  /** The local day it is about (YYYY-MM-DD): TODAY for a time before 15:00, TOMORROW from 15:00. */
  about: string;
  day: "today" | "tomorrow";
  /** How late it is (ms). */
  late: number;
}

/**
 * Whether a briefing is due now for a user: within the first 30 minutes after their time (on the day it fell, also
 * just after midnight). Measured in real time from the instant of that local time, so a daylight-saving jump doesn't
 * skip it (a time the clocks jump over counts from just after the jump) or send it twice.
 */
export function briefingDue(now: number, timeZone: string, minute: number): BriefingDue | null {
  const local = wallClock(now, timeZone);
  const time = minuteToTime(minute);
  let scheduledDay = local.date;
  let at = zonedInstant(scheduledDay, time, timeZone);
  if (at > now) {
    scheduledDay = addDays(local.date, -1);
    at = zonedInstant(scheduledDay, time, timeZone);
  }
  const late = now - at;
  if (late < 0 || late >= BRIEFING_WINDOW_MS) return null;
  const about = minute >= BRIEFING_TOMORROW_FROM ? addDays(scheduledDay, 1) : scheduledDay;
  return { about, day: about === local.date ? "today" : "tomorrow", late };
}

// ---------------------------------------------------------------- one run

class Run {
  readonly report: ProactiveReport = { reminders: 0, meetings: 0, briefings: 0, sent: 0, failed: 0 };
  private pushesLeft = RUN_LIMITS.pushes;
  private calendarsLeft = RUN_LIMITS.calendars;
  private keys: Promise<VapidKeys> | null = null;
  private settings: Promise<AppSettingsDto> | null = null;
  private targetsOf = new Map<string, Promise<PushTarget[]>>();
  /** Per time zone: the local minute of the day; per zone and briefing time: whether it is due (once per run). */
  private minuteIn = new Map<string, number>();
  private dueAt = new Map<string, BriefingDue | null>();
  private readonly config: AppConfig;

  constructor(
    private readonly env: Env,
    private readonly now: number,
  ) {
    this.config = getConfig(env);
  }

  private get db() {
    return this.env.DB;
  }

  private targets(userId: string): Promise<PushTarget[]> {
    let t = this.targetsOf.get(userId);
    if (!t) this.targetsOf.set(userId, (t = pushTargets(this.db, userId)));
    return t;
  }

  /** Blocked accounts get nothing (administrators are never blocked). */
  private mayNotify(u: NotifyUser): boolean {
    return u.user_status === "active" || roleOf(this.config, u) === "admin";
  }

  /** Google is set up and this account may use it (the admin's "Google for users" switch). */
  private async mayUseGoogle(u: NotifyUser): Promise<boolean> {
    if (!this.config.googleConnectEnabled) return false;
    this.settings ??= getAppSettings(this.db, this.config);
    return googleAllowed(this.env, { role: roleOf(this.config, u) }, await this.settings);
  }

  private google(userId: string) {
    return googleAccess({ env: this.env, db: this.db, userId, maxCalls: 2 });
  }

  /** Sends to the targets; `reached` = at least one device took it, or every one is gone (nothing to try again). */
  private async push(targets: PushTarget[], payload: PushPayload, options: PushOptions): Promise<{ reached: boolean }> {
    this.pushesLeft -= targets.length;
    let result = { sent: 0, failed: targets.length, gone: 0 };
    try {
      this.keys ??= vapidKeys(this.db);
      result = await deliver(this.db, await this.keys, targets, payload, options, this.now);
    } catch (error) {
      console.error(JSON.stringify({ msg: "push failed", error: String(error) }));
    }
    this.report.sent += result.sent;
    this.report.failed += result.failed;
    return { reached: result.sent > 0 || result.failed === result.gone };
  }

  private localMinute(timeZone: string): number {
    let minute = this.minuteIn.get(timeZone);
    if (minute === undefined) {
      const [h, m] = wallClock(this.now, timeZone).time.split(":").map(Number) as [number, number];
      this.minuteIn.set(timeZone, (minute = h * 60 + m));
    }
    return minute;
  }

  /** Cheap first: rows far from their time (in local minutes) are skipped without the exact daylight-saving-safe check. */
  private briefingDueFor(timeZone: string, minute: number): BriefingDue | null {
    if ((this.localMinute(timeZone) - minute + 1440) % 1440 >= BRIEFING_WINDOW_MS / 60_000 + CLOCK_SHIFT_MIN) return null;
    const key = `${timeZone}|${minute}`;
    if (!this.dueAt.has(key)) this.dueAt.set(key, briefingDue(this.now, timeZone, minute));
    return this.dueAt.get(key)!;
  }

  async reminders(): Promise<void> {
    for (const r of await dueReminders(this.db, this.now, RUN_LIMITS.reminders)) {
      const targets = this.mayNotify(r) ? await this.targets(r.user_id) : [];
      if (targets.length > this.pushesLeft) break; // the next run sends it
      if (!(await claimReminder(this.db, r.id, this.now))) continue; // another run has it
      this.report.reminders++;
      if (!targets.length) continue;
      // No device took it (push services failing): back to pending for another try, at most 2 more within 15 minutes.
      if (!(await this.push(targets, reminderPayload(r), REMINDER_PUSH)).reached) await retryReminder(this.db, r.id, this.now);
    }
  }

  async meetings(): Promise<void> {
    if (!this.config.googleConnectEnabled) return;
    const candidates = await meetingCandidates(this.db, this.now - MEETING_CHECK_MS, CALENDAR_SCOPE, RUN_LIMITS.calendars);
    for (const u of candidates) {
      if (this.calendarsLeft <= 0 || this.pushesLeft <= 0) break;
      // Look again in 5 minutes (claimed, so a second run at the same time skips this user).
      if (!(await claimMeetingCheck(this.db, u.user_id, u.meeting_checked_at, this.now))) continue;
      if (!(await this.mayUseGoogle(u))) continue;
      this.calendarsLeft--;
      const timeZone = zoneOrUtc(u.time_zone);
      const before = u.meeting_minutes * 60_000;
      let events: CalendarItem[];
      try {
        // Events whose alert falls before the next look (plus a minute).
        // Up to 50: all-day and ongoing events come first and are skipped below, so they can't crowd out the next ones.
        events = await calendarItems(this.google(u.user_id), { from: this.now, to: this.now + before + MEETING_CHECK_MS + 60_000 }, timeZone, 50);
      } catch (error) {
        console.error(JSON.stringify({ msg: "meeting alerts: calendar not read", error: String(error) }));
        continue;
      }
      const targets = await this.targets(u.user_id);
      let lookAgainAt: number | null = null;
      for (const e of events) {
        if (e.allDay || e.start <= this.now) continue;
        const alertAt = e.start - before;
        if (alertAt <= this.now + 30_000) {
          if (targets.length > this.pushesLeft) {
            lookAgainAt = this.now; // no room in this run: the next one
            break;
          }
          if (await claimMeetingAlert(this.db, u.user_id, e.key, this.now)) {
            this.report.meetings++;
            await this.push(targets, meetingPayload(e, timeZone, this.now), MEETING_PUSH);
          }
        } else if (alertAt < this.now + MEETING_CHECK_MS) {
          // Due before the next regular look: look again right then.
          lookAgainAt = Math.min(lookAgainAt ?? Infinity, alertAt);
        }
      }
      if (lookAgainAt !== null) await setMeetingCheck(this.db, u.user_id, lookAgainAt - MEETING_CHECK_MS);
    }
  }

  async briefings(): Promise<void> {
    let done = 0;
    for (const u of await briefingCandidates(this.db, RUN_LIMITS.briefingScan)) {
      if (done >= RUN_LIMITS.briefings || this.pushesLeft <= 0) break;
      const timeZone = zoneOrUtc(u.time_zone);
      const due = this.briefingDueFor(timeZone, u.briefing_minute);
      if (!due || (u.last_briefing_day !== null && u.last_briefing_day >= due.about)) continue;
      const calendar = Boolean(u.google_scopes?.split(/\s+/).includes(CALENDAR_SCOPE)) && (await this.mayUseGoogle(u));
      if (calendar && this.calendarsLeft <= 0) continue; // the next run reads it
      const targets = await this.targets(u.user_id);
      if (targets.length === 0 || targets.length > this.pushesLeft) continue;
      if (!(await claimBriefing(this.db, u.user_id, due.about))) continue;
      done++;
      const range = { from: zonedInstant(due.about, "00:00", timeZone), to: zonedInstant(addDays(due.about, 1), "00:00", timeZone) };
      const reminders = await countPendingReminders(this.db, u.user_id, range);
      let events: CalendarItem[] | null = null;
      if (calendar) {
        this.calendarsLeft--;
        events = await calendarItems(this.google(u.user_id), range, timeZone, 50).catch((error) => {
          console.error(JSON.stringify({ msg: "briefing: calendar not read", error: String(error) }));
          return null;
        });
      }
      this.report.briefings++;
      const { reached } = await this.push(targets, briefingPayload(due, { events, reminders, dayStart: range.from, timeZone }), BRIEFING_PUSH);
      // No device took it: the day isn't used up, so the next runs try again while it is only a few minutes late.
      if (!reached && due.late < BRIEFING_RETRY_MS) await releaseBriefing(this.db, u.user_id, due.about, u.last_briefing_day);
    }
  }
}

/** One every-minute run (`now` = the cron's scheduled time). Each part runs even if another fails. */
export async function runProactive(env: Env, now = Date.now()): Promise<ProactiveReport> {
  const run = new Run(env, now);
  for (const part of [() => run.reminders(), () => run.meetings(), () => run.briefings()]) {
    try {
      await part();
    } catch (error) {
      console.error(JSON.stringify({ msg: "proactive run part failed", error: String(error), stack: (error as Error).stack }));
    }
  }
  const r = run.report;
  if (r.reminders || r.meetings || r.briefings || r.failed) console.log(JSON.stringify({ msg: "proactive run", ...r }));
  return r;
}
