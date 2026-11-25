/**
 * Reminders (v0.18.0): "remind me at 5 PM to call Ali". set_reminder saves it; at that time the cron
 * (jobs/proactive.ts) sends a VESPER notification to every browser where the user switched notifications on. Like
 * memory, these tools only change the user's own VESPER data, so no approval card is needed.
 *
 * Times are the user's local times (their browser's time zone, else the one saved with their notification settings),
 * converted with the same daylight-saving-safe helpers as the calendar tools.
 */
import { z } from "zod";
import {
  cancelReminder,
  createReminder,
  getPrefsRow,
  listDevices,
  listPendingReminders,
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_TEXT,
  MAX_REMINDERS_PER_DAY,
} from "../db/notifications";
import { addDays, dayLabel, isValidDate, parseWhen, validTimeZone, wallClock, zonedInstant } from "./google";
import { clip } from "./net";
import { define, ToolInputError, type AgentTool, type ToolContext, type ToolOutput } from "./types";

export const REMINDER_TOOL_NAMES = new Set(["set_reminder", "list_reminders", "cancel_reminder"]);
const MINUTE = 60_000;
const DAY_MS = 86_400_000;
/** A reminder is at least a minute and at most a year ahead. */
const MAX_AHEAD_MS = 366 * DAY_MS;

const pad = (n: number) => String(n).padStart(2, "0");

/** "17:00", "5 pm", "5:30 PM", "9.15" → "HH:MM", or null. */
function parseClock(text: string): string | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const half = m[3]?.toLowerCase().replace(/\./g, "");
  if (!m[2] && !half) return null; // a bare number isn't a time
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "pm" ? 12 : 0);
  }
  return h > 23 || mi > 59 ? null : `${pad(h)}:${pad(mi)}`;
}

const UNITS: Record<string, number> = { m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE, h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE, d: DAY_MS, day: DAY_MS, days: DAY_MS, week: 7 * DAY_MS, weeks: 7 * DAY_MS };

/** "20 minutes", "2 hours", "1 hour and 30 minutes", "an hour", "half an hour" → milliseconds, or null. */
function parseDuration(text: string): number | null {
  const words = text.toLowerCase().replace(/\bhalf an? hour\b/g, "30 minutes").replace(/\ban?\b/g, "1").replace(/,|\band\b/g, " ").trim();
  if (!words) return null;
  let total = 0;
  let rest = words;
  const part = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*/;
  while (rest) {
    const m = part.exec(rest);
    const unit = m ? UNITS[m[2]!] : undefined;
    if (!m || !unit) return null;
    total += Number(m[1]) * unit;
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? total : null;
}

/**
 * When a reminder is due: "YYYY-MM-DD HH:MM" (local; seconds or an offset accepted), "in 20 minutes", "in 2 hours",
 * "tomorrow 09:00", "today 5 pm", or just "17:00" (today). Throws in words for the model when it can't be used.
 */
export function reminderTime(when: string, timeZone: string, now: number): number {
  const text = when.trim().replace(/\s+/g, " ");
  const local = wallClock(now, timeZone);
  let at: number | null = null;
  const relative = /^in (.+)$/i.exec(text);
  if (relative) {
    const ms = parseDuration(relative[1]!);
    if (ms !== null) {
      // On the whole minute (the cron runs once a minute), at least a minute ahead.
      at = Math.round((now + ms) / MINUTE) * MINUTE;
      if (at - now < MINUTE) at += MINUTE;
    }
  } else {
    const exact = parseWhen(text, timeZone);
    if (exact?.time) at = zonedInstant(exact.date, exact.time, timeZone);
    else {
      const m = /^(?:(today|tomorrow)|(\d{4}-\d{2}-\d{2}))?(?:[ T]?(?:at )?(.+))?$/i.exec(text);
      const day = m?.[1] ? (m[1].toLowerCase() === "tomorrow" ? addDays(local.date, 1) : local.date) : m?.[2] ?? local.date;
      const clock = m?.[3] ? parseClock(m[3]) : null;
      if (m && clock && isValidDate(day)) at = zonedInstant(day, clock, timeZone);
    }
  }
  if (at === null) {
    throw new ToolInputError(
      `Write "when" as a local time like "${addDays(local.date, 1)} 09:00", or as "in 20 minutes", "in 2 hours" or "tomorrow 09:00"; got "${clip(text, 40)}".`,
    );
  }
  if (at <= now) {
    throw new ToolInputError(
      `That time has already passed: it's ${local.time} on ${dayLabel(local.date)} now (${timeZone}). Ask the user when they mean (for example tomorrow at that time).`,
    );
  }
  if (at - now < MINUTE) throw new ToolInputError("A reminder must be at least 1 minute ahead.");
  if (at - now > MAX_AHEAD_MS) throw new ToolInputError("A reminder can be at most a year ahead.");
  return at;
}

/** "today at 17:20", "tomorrow at 09:00", or "Mon 7 Dec 2026 at 09:00" (with the day name for anything later). */
export function spokenTime(at: number, timeZone: string, now: number): string {
  const w = wallClock(at, timeZone);
  const today = wallClock(now, timeZone).date;
  const day = w.date === today ? "today" : w.date === addDays(today, 1) ? "tomorrow" : dayLabel(w.date);
  return `${day} at ${w.time}`;
}

/** The user's time zone: their browser's for this chat, else the one saved with their notification settings, else UTC. */
async function zoneOf(ctx: ToolContext): Promise<string> {
  return validTimeZone(ctx.timeZone) ?? validTimeZone((await getPrefsRow(ctx.db, ctx.userId))?.time_zone) ?? "UTC";
}

const setReminder = define({
  name: "set_reminder",
  label: "Reminders",
  description:
    "Set a reminder: at that time VESPER sends a notification to the user's own devices where VESPER notifications are switched on. " +
    "Use it for every \"remind me…\" request. The result gives the exact local time to confirm; it is not a phone alarm.",
  risk: "write",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: 'What to remind the user of, short, e.g. "Call Ali".' },
      when: {
        type: "string",
        description: 'The user\'s local time "YYYY-MM-DD HH:MM" (e.g. "2026-12-02 17:00"), or "in 20 minutes", "in 2 hours", "tomorrow 09:00".',
      },
    },
    required: ["text", "when"],
  },
  schema: z.object({
    text: z
      .string()
      .transform((t) => t.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim())
      .pipe(z.string().min(1, "Say what the reminder is about.").max(MAX_REMINDER_TEXT, `Keep the reminder under ${MAX_REMINDER_TEXT} characters.`)),
    when: z.string().trim().min(1).max(60),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const timeZone = await zoneOf(ctx);
    const now = ctx.now.getTime();
    const dueAt = reminderTime(args.when, timeZone, now);
    const saved = await createReminder(ctx.db, { userId: ctx.userId, conversationId: ctx.conversationId ?? null, text: args.text, dueAt, timeZone }, now);
    if (saved === "pending_full") {
      throw new ToolInputError(`The user already has ${MAX_PENDING_REMINDERS} reminders waiting. Ask them to cancel some first (list_reminders, cancel_reminder).`);
    }
    if (saved === "daily_full") throw new ToolInputError(`At most ${MAX_REMINDERS_PER_DAY} reminders can be set per day. Tell the user to try again tomorrow.`);
    const devices = (await listDevices(ctx.db, ctx.userId)).length;
    const when = spokenTime(dueAt, timeZone, now);
    const local = wallClock(dueAt, timeZone);
    return {
      content: JSON.stringify({
        saved: true,
        id: saved.id,
        text: saved.text,
        when,
        local_time: `${dayLabel(local.date)}, ${local.time}`,
        time_zone: timeZone,
        notifications_on: devices > 0,
        note:
          devices > 0
            ? `Confirm in one sentence that you'll remind them ${when}. It arrives as a VESPER notification on their devices; never call it a phone alarm.`
            : `The reminder is saved for ${when}, but no device has VESPER notifications switched on yet, so nothing would pop up. Tell the user to switch them on in Settings → Notifications. Never call it a phone alarm.`,
      }),
      summary: `Reminder set for ${dayLabel(local.date)}, ${local.time}: ${clip(saved.text, 80)}`,
    };
  },
});

const listReminders = define({
  name: "list_reminders",
  label: "Reminders",
  description: "List the user's reminders that haven't gone off yet, soonest first, with their local times and ids (for cancel_reminder).",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { day: { type: "string", description: 'Only one day: "today", "tomorrow" or a date (2026-12-02). Default: all.' } },
  },
  schema: z.object({ day: z.string().trim().max(20).optional() }),
  async run(args, ctx): Promise<ToolOutput> {
    const timeZone = await zoneOf(ctx);
    const now = ctx.now.getTime();
    const today = wallClock(now, timeZone).date;
    let range: { from: number; to: number } | undefined;
    let day: string | undefined;
    if (args.day) {
      const word = args.day.toLowerCase();
      day = word === "today" ? today : word === "tomorrow" ? addDays(today, 1) : args.day;
      if (!isValidDate(day)) throw new ToolInputError(`Write "day" as "today", "tomorrow" or a date (2026-12-02); got "${clip(args.day, 20)}".`);
      range = { from: zonedInstant(day, "00:00", timeZone), to: zonedInstant(addDays(day, 1), "00:00", timeZone) };
    }
    const reminders = await listPendingReminders(ctx.db, ctx.userId, range);
    return {
      content: JSON.stringify({
        time_zone: timeZone,
        ...(day ? { day: dayLabel(day) } : {}),
        reminders: reminders.map((r) => ({ id: r.id, text: r.text, when: spokenTime(r.dueAt, timeZone, now) })),
        ...(reminders.length === 0 ? { note: day ? "No reminders that day." : "No reminders are waiting." } : {}),
      }),
      summary: `${reminders.length} reminder${reminders.length === 1 ? "" : "s"}${day ? ` on ${dayLabel(day)}` : ""}`,
    };
  },
});

const cancelReminderTool = define({
  name: "cancel_reminder",
  label: "Reminders",
  description: "Cancel one of the user's reminders by its id (from list_reminders). Only when the user asks.",
  risk: "write",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { reminder_id: { type: "string", description: "The reminder's id." } },
    required: ["reminder_id"],
  },
  schema: z.object({ reminder_id: z.string().trim().min(1).max(64) }),
  async run({ reminder_id }, ctx): Promise<ToolOutput> {
    const cancelled = await cancelReminder(ctx.db, ctx.userId, reminder_id);
    if (!cancelled) throw new ToolInputError(`No waiting reminder with id "${clip(reminder_id, 64)}". Use list_reminders to see the ids.`);
    const when = spokenTime(cancelled.dueAt, await zoneOf(ctx), ctx.now.getTime());
    return {
      content: JSON.stringify({ cancelled: true, text: cancelled.text, was_due: when }),
      summary: `Cancelled the reminder "${clip(cancelled.text, 80)}" (${when})`,
    };
  },
});

export const REMINDER_TOOLS: AgentTool[] = [setReminder, listReminders, cancelReminderTool];
