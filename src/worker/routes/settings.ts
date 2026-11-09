import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { settingsSchema, updateSettings } from "../db/users";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";

export const settingsRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", (c) => c.json({ settings: c.get("user").settings }))

  /** Partial update: only the fields sent are changed. */
  .put("/", async (c) => {
    const patch = await parseJson(c, settingsSchema.partial());
    const settings = { ...c.get("user").settings, ...patch };
    await updateSettings(c.env.DB, c.get("user").id, settings);
    return c.json({ settings });
  });
