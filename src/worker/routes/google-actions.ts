import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import {
  claimGoogleAction,
  finishGoogleAction,
  getGoogleAction,
  rejectGoogleAction,
  unclaimGoogleAction,
  updateClaimedEmail,
  type GooglePayload,
} from "../db/google";
import { utcDay } from "../db/provider-state";
import { consumeDailyGoogle, refundDailyGoogle } from "../db/users";
import { getConfig } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import { cleanEmail, emailTarget, executeGoogleAction, GoogleActionFailed } from "../tools/google";
import { googleAccess, googleConnection } from "../tools/google-client";
import { ToolInputError } from "../tools/types";
import { googleAllowed } from "./connections";

const decideLimiter = rateLimit("google_action", 20, 60_000, (c) => c.get("user").id);

/** The email as the user approved it on the card (they may have edited it). */
const approveBody = z
  .object({
    email: z
      .object({
        to: z.array(z.string().max(300)).max(40),
        cc: z.array(z.string().max(300)).max(40).default([]),
        subject: z.string().max(1_000),
        body: z.string().max(25_000),
      })
      .optional(),
  })
  .default({});

/**
 * Emails and calendar events waiting for the user's approval (v0.15.0). One is prepared in the chat (tools/google.ts)
 * and shown on a card; only Approve here sends it, once. For an email, the card may send the user's edits along: they
 * are checked like the original. Reject sends nothing. Each belongs to the user who prepared it: anyone else gets
 * "not found".
 */
export const googleActionRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/:id", async (c) => {
    const action = await getGoogleAction(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!action) throw notFound("Item");
    return c.json({ action });
  })

  .post("/:id/approve", decideLimiter, async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const id = c.req.param("id");
    const settings = await getAppSettings(db, getConfig(c.env));
    if (!googleAllowed(c.env, user, settings)) throw new AppError(403, "google_off", "Google Calendar and Gmail are switched off.");
    const parsed = approveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw badRequest("The edited email couldn't be read.");
    // Edits are checked before anything is claimed, so a mistake leaves the card waiting.
    let edited: ReturnType<typeof cleanEmail> | null = null;
    if (parsed.data.email) {
      try {
        edited = cleanEmail(parsed.data.email);
      } catch (error) {
        if (error instanceof ToolInputError) throw badRequest(error.message);
        throw error;
      }
    }
    if (!(await googleConnection(db, user.id))) {
      throw new AppError(409, "google_reconnect", "Reconnect Google in Settings → Connections, then approve again.");
    }
    const claimed = await claimGoogleAction(db, user.id, id);
    if (!claimed) {
      // Already decided, sending right now (another click or tab), expired, or not this user's: show how it stands.
      const current = await getGoogleAction(db, user.id, id);
      if (!current) throw notFound("Item");
      return c.json({ action: current });
    }
    let payload: GooglePayload = claimed;
    if (edited && payload.kind === "email") {
      payload = { kind: "email", email: { ...edited, from: payload.email.from } };
      await updateClaimedEmail(db, id, payload, edited.subject.slice(0, 200), emailTarget(edited));
    }
    const column = payload.kind === "email" ? "emails" : "events";
    // Counted before it is sent (two approvals at once can't both slip through), given back if sending fails.
    const perDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : payload.kind === "email" ? settings.emailsPerDay : settings.eventsPerDay;
    const day = utcDay();
    if (!(await consumeDailyGoogle(db, user.id, column, perDay))) {
      await unclaimGoogleAction(db, id);
      const what = payload.kind === "email" ? "emails" : "calendar events";
      throw new AppError(
        429,
        "google_action_limit",
        perDay <= 0 ? `Sending ${what} is paused for your account.` : `You've used all ${perDay} ${what} for today. They reset at 00:00 UTC; this one stays ready until then.`,
      );
    }
    try {
      const url = await executeGoogleAction(googleAccess({ env: c.env, db, userId: user.id }), payload, id);
      await finishGoogleAction(db, id, { status: "done", resultUrl: url });
    } catch (error) {
      await refundDailyGoogle(db, user.id, column, day).catch(() => {});
      const message = error instanceof GoogleActionFailed ? error.message : "Something went wrong while sending it to Google.";
      if (!(error instanceof GoogleActionFailed)) console.error(JSON.stringify({ msg: "google action failed", requestId: c.get("requestId"), error: String(error) }));
      await finishGoogleAction(db, id, { status: "failed", error: message });
    }
    return c.json({ action: await getGoogleAction(db, user.id, id) });
  })

  .post("/:id/reject", decideLimiter, async (c) => {
    const user = c.get("user");
    await rejectGoogleAction(c.env.DB, user.id, c.req.param("id"));
    const action = await getGoogleAction(c.env.DB, user.id, c.req.param("id"));
    if (!action) throw notFound("Item");
    return c.json({ action });
  });
