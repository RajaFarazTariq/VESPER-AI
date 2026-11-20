import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { claimGithubAction, finishGithubAction, getGithubAction, rejectGithubAction, unclaimGithubAction } from "../db/github";
import { utcDay } from "../db/provider-state";
import { consumeDailyGithubAction, refundDailyGithubAction } from "../db/users";
import { getConfig } from "../env";
import { AppError, notFound } from "../lib/errors";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import { ActionFailed, executeGithubAction } from "../tools/github-actions";
import { githubConnected, githubWriter } from "../tools/github-client";
import { VERSION } from "../version";
import { githubActionsAllowed } from "./connections";

const decideLimiter = rateLimit("gh_action", 20, 60_000, (c) => c.get("user").id);

/**
 * GitHub changes waiting for the user's approval (v0.13.0). A change is prepared in the chat (tools/github-actions.ts)
 * and shown on a card; only Approve here sends it, exactly as stored, once. Reject sends nothing. Each change belongs
 * to the user who prepared it: anyone else gets "not found".
 */
export const githubActionRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/:id", async (c) => {
    const action = await getGithubAction(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!action) throw notFound("Change");
    return c.json({ action });
  })

  .post("/:id/approve", decideLimiter, async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const id = c.req.param("id");
    const config = getConfig(c.env);
    const settings = await getAppSettings(db, config);
    if (!githubActionsAllowed(c.env, user, settings)) throw new AppError(403, "github_actions_off", "GitHub changes are switched off.");
    if (!(await githubConnected(db, user.id, "actions"))) {
      throw new AppError(409, "github_actions_reconnect", 'Reconnect "GitHub changes" in Settings → Connections, then approve again.');
    }
    const claimed = await claimGithubAction(db, user.id, id);
    if (!claimed) {
      // Already decided, sending right now (another click or tab), expired, or not this user's: show how it stands.
      const current = await getGithubAction(db, user.id, id);
      if (!current) throw notFound("Change");
      return c.json({ action: current });
    }
    // Counted before it is sent (two approvals at once can't both slip through), given back if sending fails.
    const perDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : settings.githubActionsPerDay;
    const day = utcDay();
    if (!(await consumeDailyGithubAction(db, user.id, perDay))) {
      await unclaimGithubAction(db, id);
      throw new AppError(
        429,
        "github_action_limit",
        perDay <= 0 ? "GitHub changes are paused for your account." : `You've used all ${perDay} GitHub changes for today. They reset at 00:00 UTC; this one stays ready until then.`,
      );
    }
    const writer = githubWriter({
      env: c.env,
      db,
      userId: user.id,
      userAgent: `${config.appName.replace(/[^\w.-]/g, "") || "Assistant"}/${VERSION} (+${new URL(c.req.url).origin})`,
    });
    try {
      const url = await executeGithubAction(writer, claimed.kind, claimed.repo, claimed.payload);
      await finishGithubAction(db, id, { status: "done", resultUrl: url });
    } catch (error) {
      await refundDailyGithubAction(db, user.id, day).catch(() => {});
      const message = error instanceof ActionFailed ? error.message : "Something went wrong while sending it to GitHub.";
      if (!(error instanceof ActionFailed)) console.error(JSON.stringify({ msg: "github action failed", requestId: c.get("requestId"), error: String(error) }));
      await finishGithubAction(db, id, { status: "failed", error: message });
    }
    return c.json({ action: await getGithubAction(db, user.id, id) });
  })

  .post("/:id/reject", decideLimiter, async (c) => {
    const user = c.get("user");
    await rejectGithubAction(c.env.DB, user.id, c.req.param("id"));
    const action = await getGithubAction(c.env.DB, user.id, c.req.param("id"));
    if (!action) throw notFound("Change");
    return c.json({ action });
  });
