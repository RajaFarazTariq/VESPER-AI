/**
 * VESPER Agent's HUD (v0.19.1): `GET /api/agent/overview` gives the agent screen's side panels real data of the
 * signed-in user: the next calendar events (when Google is connected), the next reminders, open to-dos, whether
 * notifications are on and the messages left today. One Google request at most (2 calls with a token renewal).
 */
import { Hono } from "hono";
import type { AgentOverviewDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { getGoogleConnection } from "../db/google";
import { countOpenTodos, findList, listItems, listName } from "../db/lists";
import { getPrefsRow, listDevices, listPendingReminders } from "../db/notifications";
import { utcDay } from "../db/provider-state";
import { getConfig } from "../env";
import { normalizeTimeZone } from "../llm/context";
import { requireUser } from "../middleware/auth";
import { calendarItems, wallClock } from "../tools/google";
import { accountOf, googleAccess } from "../tools/google-client";
import { googleAllowed } from "./connections";

const HOUR = 3_600_000;
const EVENTS_AHEAD = 36 * HOUR;

/** "15:00" today, "Tomorrow 09:30", "Mon 09:30" later; all-day events: "All day" / "Tomorrow · all day". */
function whenText(start: number, allDay: boolean, now: number, timeZone: string): string {
  const today = wallClock(now, timeZone).date;
  const at = wallClock(start, timeZone);
  const tomorrow = wallClock(now + 24 * HOUR, timeZone).date;
  const day =
    at.date === today
      ? ""
      : at.date === tomorrow
        ? "Tomorrow"
        : new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(start);
  if (allDay) return day ? `${day} · all day` : "All day";
  return day ? `${day} ${at.time}` : at.time;
}

export const agentRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/overview", async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const now = Date.now();
    const [settings, prefs, connection, reminders, open, devices, usage] = await Promise.all([
      getAppSettings(db, getConfig(c.env)),
      getPrefsRow(db, user.id),
      getGoogleConnection(db, user.id),
      listPendingReminders(db, user.id),
      countOpenTodos(db, user.id),
      listDevices(db, user.id),
      db
        .prepare("SELECT messages FROM user_usage_daily WHERE user_id = ?1 AND day = ?2")
        .bind(user.id, utcDay(now))
        .first<{ messages: number }>(),
    ]);
    // The browser's zone (sent along) wins; else the one saved with the notification settings.
    const timeZone = normalizeTimeZone(c.req.query("tz")) ?? normalizeTimeZone(prefs?.time_zone) ?? "UTC";

    const calendarOn = connection !== null && googleAllowed(c.env, user, settings) && accountOf(connection).calendar;
    let google: AgentOverviewDto["google"] = "off";
    let events: AgentOverviewDto["events"] = [];
    if (calendarOn && connection.status === "reconnect") google = "reconnect";
    else if (calendarOn) {
      google = "connected";
      try {
        const items = await calendarItems(
          googleAccess({ env: c.env, db, userId: user.id, maxCalls: 2 }),
          { from: now, to: now + EVENTS_AHEAD },
          timeZone,
          20,
        );
        // Upcoming ones first (an all-day event of today still counts); at most 3.
        events = items
          .filter((e) => e.end > now)
          .slice(0, 3)
          .map((e) => ({
            title: e.title.slice(0, 80),
            when: !e.allDay && e.start <= now ? "Now" : whenText(e.start, e.allDay, now, timeZone),
            allDay: e.allDay,
          }));
      } catch (error) {
        console.warn(JSON.stringify({ msg: "agent overview: calendar not read", error: String(error) }));
      }
    }

    let first: string[] = [];
    if (open > 0) {
      const todo = listName("To-do");
      const list = todo ? await findList(db, user.id, todo.key) : null;
      if (list) first = (await listItems(db, list.id)).filter((i) => !i.done).slice(0, 2).map((i) => i.text.slice(0, 80));
    }

    const limit = user.role === "admin" ? null : (user.dailyLimit ?? settings.defaultDailyLimit);
    const overview: AgentOverviewDto = {
      timeZone,
      google,
      events,
      reminders: reminders.slice(0, 3).map((r) => ({ text: r.text.slice(0, 80), dueAt: r.dueAt })),
      todos: { open, first },
      notifications: devices.length > 0,
      messagesLeft: limit === null ? null : Math.max(0, limit - (usage?.messages ?? 0)),
    };
    return c.json(overview);
  });
