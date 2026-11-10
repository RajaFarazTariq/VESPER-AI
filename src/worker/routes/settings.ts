import { Hono } from "hono";
import type { UserSettings } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings, userMayUseModel } from "../db/app-settings";
import { settingsSchema, updateSettings, type SessionUser } from "../db/users";
import { getConfig } from "../env";
import { badRequest } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";

/**
 * The settings as this user may use them: a regular user's saved default model that the admin has
 * since removed from the list (admin panel → Models) becomes Auto.
 */
export async function effectiveSettings(db: D1Database, env: AppEnv["Bindings"], user: SessionUser): Promise<UserSettings> {
  if (user.role === "admin" || user.settings.defaultModel === "auto") return user.settings;
  const app = await getAppSettings(db, getConfig(env));
  return userMayUseModel(app, user.settings.defaultModel) ? user.settings : { ...user.settings, defaultModel: "auto" };
}

export const settingsRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => c.json({ settings: await effectiveSettings(c.env.DB, c.env, c.get("user")) }))

  /** Partial update: only the fields sent are changed. */
  .put("/", async (c) => {
    const user = c.get("user");
    const patch = await parseJson(c, settingsSchema.partial());
    const current = await effectiveSettings(c.env.DB, c.env, user);
    if (user.role !== "admin" && patch.defaultModel !== undefined && patch.defaultModel !== current.defaultModel) {
      const app = await getAppSettings(c.env.DB, getConfig(c.env));
      if (!userMayUseModel(app, patch.defaultModel)) throw badRequest("That model isn't available. Choose Auto or a model from the list.");
    }
    const settings = { ...current, ...patch };
    await updateSettings(c.env.DB, user.id, settings);
    return c.json({ settings });
  });
