/**
 * Notifications (v0.18.0): the browsers where the user switched VESPER notifications on, and their settings.
 *   GET    /api/notifications              → { publicKey, devices, prefs, reminders }
 *   POST   /api/notifications/devices      → save this browser's push subscription (and the user's time zone)
 *   DELETE /api/notifications/devices/:id  → stop notifications on one browser (own only)
 *   POST   /api/notifications/test         → "VESPER notifications are on" to all the user's browsers
 *   PUT    /api/notifications/prefs        → daily briefing and meeting alert settings
 *   DELETE /api/reminders/:id              → cancel a reminder that hasn't gone off (own only)
 * Reminders themselves are set by VESPER (tools/reminders.ts) and sent by the cron (jobs/proactive.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { NotificationsDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import {
  cancelReminder,
  deleteDevice,
  getPrefsRow,
  listDevices,
  listPendingReminders,
  MAX_DEVICES,
  MEETING_MINUTES,
  prefsDto,
  pushTargets,
  saveDevice,
  savePrefs,
} from "../db/notifications";
import { AppError, badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import { validSubscriptionKeys } from "../push/encrypt";
import { vapidKeys } from "../push/keys";
import { allowedPushEndpoint, deliver } from "../push/send";
import { validTimeZone } from "../tools/google";

const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .transform((tz, ctx) => {
    const valid = validTimeZone(tz);
    if (!valid) ctx.addIssue({ code: "custom", message: "Unknown time zone." });
    return valid ?? "UTC";
  });

const deviceSchema = z.object({
  endpoint: z.string().trim().min(1).max(2_000),
  keys: z.object({ p256dh: z.string().trim().max(200), auth: z.string().trim().max(100) }),
  label: z.string().max(200).optional(),
  timeZone: timeZoneSchema.optional(),
});

const prefsSchema = z.object({
  timeZone: timeZoneSchema.optional(),
  briefingEnabled: z.boolean().optional(),
  briefingTime: z
    .string()
    .trim()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 22:00")
    .optional(),
  meetingAlerts: z.boolean().optional(),
  meetingMinutes: z
    .number()
    .int()
    .refine((n) => (MEETING_MINUTES as readonly number[]).includes(n), `Choose ${MEETING_MINUTES.join(", ")} minutes.`)
    .optional(),
});

/** "Chrome on Windows" as the browser said, on one line; "This device" when it said nothing. */
const cleanLabel = (label: string | undefined) => label?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "This device";

const deviceLimiter = rateLimit("push-devices", 20, 60_000, (c) => c.get("user").id);
const testLimiter = rateLimit("push-test", 5, 60_000, (c) => c.get("user").id);

export const notificationRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => {
    const user = c.get("user");
    const [keys, devices, prefs, reminders] = await Promise.all([
      vapidKeys(c.env.DB, new URL(c.req.url).origin),
      listDevices(c.env.DB, user.id),
      getPrefsRow(c.env.DB, user.id),
      listPendingReminders(c.env.DB, user.id),
    ]);
    const body: NotificationsDto = { publicKey: keys.publicKey, devices, prefs: prefsDto(prefs), reminders };
    return c.json(body);
  })

  .post("/devices", deviceLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, deviceSchema, 8 * 1024);
    // Only the push services of supported browsers (an endpoint is an address the browser chose: no other hosts).
    if (!allowedPushEndpoint(body.endpoint)) throw badRequest("This browser's push service isn't supported. Try Chrome, Edge, Firefox or Safari.");
    if (!validSubscriptionKeys(body.keys.p256dh, body.keys.auth)) throw badRequest("The browser sent unusable notification keys. Switch notifications off and on again.");
    await vapidKeys(c.env.DB, new URL(c.req.url).origin);
    const device = await saveDevice(c.env.DB, user.id, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, label: cleanLabel(body.label) });
    if (!device) {
      throw new AppError(409, "device_limit", `Notifications can be on for up to ${MAX_DEVICES} devices. Remove one in Settings → Notifications first.`);
    }
    if (body.timeZone) await savePrefs(c.env.DB, user.id, { timeZone: body.timeZone });
    return c.json({ device });
  })

  .delete("/devices/:id", async (c) => {
    if (!(await deleteDevice(c.env.DB, c.get("user").id, c.req.param("id")))) throw notFound("Device");
    return c.json({ ok: true });
  })

  .post("/test", testLimiter, async (c) => {
    const user = c.get("user");
    const targets = await pushTargets(c.env.DB, user.id);
    if (targets.length === 0) return c.json({ sent: 0, failed: 0 });
    const keys = await vapidKeys(c.env.DB, new URL(c.req.url).origin);
    const result = await deliver(
      c.env.DB,
      keys,
      targets,
      { title: "VESPER notifications are on", body: "Reminders, your daily briefing and meeting alerts will appear here.", url: "/", tag: "test", kind: "test" },
      { ttl: 600, urgency: "normal" },
    );
    return c.json({ sent: result.sent, failed: result.failed });
  })

  .put("/prefs", async (c) => {
    const body = await parseJson(c, prefsSchema, 4 * 1024);
    const [h, m] = body.briefingTime?.split(":").map(Number) ?? [];
    const prefs = await savePrefs(c.env.DB, c.get("user").id, {
      ...(body.timeZone ? { timeZone: body.timeZone } : {}),
      ...(body.briefingEnabled !== undefined ? { briefingEnabled: body.briefingEnabled } : {}),
      ...(h !== undefined && m !== undefined ? { briefingMinute: h * 60 + m } : {}),
      ...(body.meetingAlerts !== undefined ? { meetingAlerts: body.meetingAlerts } : {}),
      ...(body.meetingMinutes !== undefined ? { meetingMinutes: body.meetingMinutes } : {}),
    });
    return c.json({ prefs });
  });

export const reminderRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .delete("/:id", async (c) => {
    if (!(await cancelReminder(c.env.DB, c.get("user").id, c.req.param("id")))) throw notFound("Reminder");
    return c.json({ ok: true });
  });
