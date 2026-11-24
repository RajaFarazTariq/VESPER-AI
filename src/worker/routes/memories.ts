import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { hasSearchableKnowledge } from "../db/knowledge";
import { getConfig } from "../env";
import { addMemory, deleteAllMemories, deleteMemory, listMemories, MAX_MEMORY_CHARS, MemoryLimitError, updateMemory } from "../db/memories";
import { AppError, notFound } from "../lib/errors";
import { sensitiveMessage, sensitiveReason } from "../lib/sensitive";
import { parseJson } from "../lib/validation";

/** Passwords, card/bank numbers, ID card numbers and phone numbers are never stored (v0.10.0). */
function refuseSensitive(content: string): void {
  const reason = sensitiveReason(content);
  if (reason) throw new AppError(400, "sensitive_memory", sensitiveMessage(reason));
}

const updateSchema = z
  .object({ content: z.string().trim().min(1).max(MAX_MEMORY_CHARS).optional(), pinned: z.boolean().optional() })
  .refine((p) => p.content !== undefined || p.pinned !== undefined, { message: "Nothing to update." });
import { requireUser } from "../middleware/auth";
import { toolInfo, webToolContext } from "../tools/registry";
import { githubConnected } from "../tools/github-client";
import { githubAllowed, googleAllowed } from "./connections";
import { googleConnection } from "../tools/google-client";

export const memoryRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => c.json({ memories: await listMemories(c.env.DB, c.get("user").id) }))

  .post("/", async (c) => {
    const { content } = await parseJson(c, z.object({ content: z.string().trim().min(1).max(MAX_MEMORY_CHARS) }));
    refuseSensitive(content);
    try {
      const memory = await addMemory(c.env.DB, c.get("user").id, content, "user");
      return c.json({ memory }, 201);
    } catch (error) {
      if (error instanceof MemoryLimitError) throw new AppError(409, "memory_full", error.message);
      throw error;
    }
  })

  /** Edit the text and/or pin ("always use") one of your memories. */
  .patch("/:id", async (c) => {
    const patch = await parseJson(c, updateSchema);
    if (patch.content !== undefined) refuseSensitive(patch.content);
    const memory = await updateMemory(c.env.DB, c.get("user").id, c.req.param("id"), patch);
    if (!memory) throw notFound("Memory");
    return c.json({ memory });
  })

  .delete("/:id", async (c) => {
    const deleted = await deleteMemory(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!deleted) throw notFound("Memory");
    return c.json({ ok: true });
  })

  .delete("/", async (c) => c.json({ deleted: await deleteAllMemories(c.env.DB, c.get("user").id) }));

/** Tools users can switch on/off in Settings; tools the admin disabled or that can't run here aren't listed. */
export const toolRoutes = new Hono<AppEnv>().use(requireUser).get("/", async (c) => {
  const config = getConfig(c.env);
  const [settings, knowledgeReady] = await Promise.all([getAppSettings(c.env.DB, config), hasSearchableKnowledge(c.env.DB)]);
  const web = webToolContext(c.env, config.appName, new URL(c.req.url).origin, settings);
  const github = githubAllowed(c.env, c.get("user"), settings) && (await githubConnected(c.env.DB, c.get("user").id));
  // Table analysis is listed while spreadsheets are on (it's offered in chats that have one).
  const tables = settings.tablesEnabled;
  // Google (v0.15.0): the calendar and email tools are listed once connected, for what the user allowed.
  const google = googleAllowed(c.env, c.get("user"), settings) ? await googleConnection(c.env.DB, c.get("user").id) : null;
  return c.json({
    tools: toolInfo({ web, knowledgeReady, github, tables, googleCalendar: google?.calendar === true, gmailSend: google?.gmailSend === true }).filter(
      (t) => t.available && !settings.disabledTools.includes(t.name),
    ),
  });
});
