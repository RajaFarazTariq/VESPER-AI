import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { appSettingsSchema, getAppSettings, updateAppSettings, webSearchesToday } from "../db/app-settings";
import { feedbackSummary, listFeedback } from "../db/feedback";
import { hasSearchableKnowledge } from "../db/knowledge";
import { tableRowsReadToday } from "../db/tables";
import { storageOverview } from "../db/storage";
import { studioCharsToday } from "../lib/studio-voice";
import { deleteUserSessions } from "../db/sessions";
import { deleteUser, getUserById, getUserForAdmin, listUsersForAdmin, roleOf, updateUser } from "../db/users";
import { getConfig } from "../env";
import { AppError, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireAdmin, requireUser } from "../middleware/auth";
import { toolInfo, webToolContext } from "../tools/registry";

const userPatchSchema = z
  .object({
    status: z.enum(["active", "blocked"]).optional(),
    /** null = use the app-wide default. */
    dailyLimit: z.number().int().min(0).max(100_000).nullable().optional(),
  })
  .refine((p) => p.status !== undefined || p.dailyLimit !== undefined, { message: "Nothing to update." });

/** Every route here is for the administrator only. */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)

  .get("/users", async (c) => c.json({ users: await listUsersForAdmin(c.env.DB, getConfig(c.env)) }))

  .patch("/users/:id", async (c) => {
    const config = getConfig(c.env);
    const id = c.req.param("id");
    const patch = await parseJson(c, userPatchSchema);
    const target = await getUserById(c.env.DB, id);
    if (!target) throw notFound("User");
    if (patch.status === "blocked" && (target.id === c.get("user").id || roleOf(config, target) === "admin")) {
      throw new AppError(400, "cannot_block_admin", "Administrators can't be blocked.");
    }
    await updateUser(c.env.DB, id, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.dailyLimit !== undefined ? { daily_limit: patch.dailyLimit } : {}),
    });
    // Blocking signs the user out everywhere right away.
    if (patch.status === "blocked") await deleteUserSessions(c.env.DB, id);
    return c.json({ user: await getUserForAdmin(c.env.DB, config, id) });
  })

  .delete("/users/:id", async (c) => {
    const config = getConfig(c.env);
    const target = await getUserById(c.env.DB, c.req.param("id"));
    if (!target) throw notFound("User");
    if (target.id === c.get("user").id || roleOf(config, target) === "admin") {
      throw new AppError(400, "cannot_delete_admin", "Administrator accounts can't be deleted here.");
    }
    await deleteUser(c.env.DB, target.id);
    return c.json({ ok: true });
  })

  .get("/settings", async (c) => {
    const config = getConfig(c.env);
    const [settings, searchesUsed, knowledgeReady, tableRowsRead, storage, studioChars] = await Promise.all([
      getAppSettings(c.env.DB, config),
      webSearchesToday(c.env.DB),
      hasSearchableKnowledge(c.env.DB),
      tableRowsReadToday(c.env.DB),
      storageOverview(c.env.DB),
      studioCharsToday(c.env.DB),
    ]);
    const web = webToolContext(c.env, config.appName, new URL(c.req.url).origin, settings);
    return c.json({
      settings,
      // GitHub tools are listed as available so they can be switched off for everyone (each user still connects).
      tools: toolInfo({
        web,
        knowledgeReady,
        github: config.githubAppEnabled,
        githubActions: config.githubActionsAppEnabled,
        tables: true,
        documents: true,
        googleCalendar: config.googleConnectEnabled,
        gmailSend: config.googleConnectEnabled,
      }),
      github: { configured: config.githubAppEnabled },
      githubActions: { configured: config.githubActionsAppEnabled },
      // Google Calendar and Gmail (v0.15.0): the sign-in client and GOOGLE_TOKEN_KEY are set.
      google: { configured: config.googleConnectEnabled },
      webSearch: {
        keyConfigured: Boolean(web.tavilyApiKey),
        usedToday: Math.min(searchesUsed, settings.webSearchDailyLimit),
      },
      // Spreadsheet calculations (v0.14.0): rows the database read for them today, whole app.
      tables: { rowsReadToday: tableRowsRead },
      // Storage meter (v0.16.0): the database's size against the free plan's 500 MB, and each file feature's text.
      storage,
      // VESPER Agent's studio voice (v0.17.1): characters read today for the whole app.
      studioVoice: { charsToday: studioChars },
    });
  })

  /** Partial update: only the fields sent are changed. */
  .put("/settings", async (c) => {
    const patch = await parseJson(c, appSettingsSchema.partial());
    return c.json({ settings: await updateAppSettings(c.env.DB, getConfig(c.env), patch) });
  })

  /** 👍/👎 on answers, newest first (?rating=up|down, ?before=<updatedAt> for the next page), plus counts per model. */
  .get("/feedback", async (c) => {
    const ratingParam = c.req.query("rating");
    const rating = ratingParam === "up" ? 1 : ratingParam === "down" ? -1 : undefined;
    const before = Number(c.req.query("before"));
    const limit = 30;
    const [items, summary] = await Promise.all([
      listFeedback(c.env.DB, { ...(rating ? { rating } : {}), limit: limit + 1, ...(before > 0 ? { before } : {}) }),
      feedbackSummary(c.env.DB),
    ]);
    return c.json({ items: items.slice(0, limit), hasMore: items.length > limit, summary });
  });
