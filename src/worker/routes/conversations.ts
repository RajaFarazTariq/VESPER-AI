import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import {
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  updateConversation,
} from "../db/conversations";
import { badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";

const idSchema = z.uuid();

function parseId(raw: string): string {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw notFound("Conversation");
  return parsed.data;
}

export const conversationRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const beforeRaw = c.req.query("before");
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) throw badRequest("Invalid 'before' cursor.");
    const conversations = await listConversations(c.env.DB, c.get("user").id, limit + 1, before);
    const hasMore = conversations.length > limit;
    return c.json({ conversations: conversations.slice(0, limit), hasMore });
  })

  .get("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const conversation = await getConversation(c.env.DB, c.get("user").id, id);
    if (!conversation) throw notFound("Conversation");
    const messages = await listMessages(c.env.DB, id);
    return c.json({ conversation, messages });
  })

  .patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(120) }));
    const updated = await updateConversation(c.env.DB, c.get("user").id, id, { title: body.title });
    if (!updated) throw notFound("Conversation");
    const conversation = await getConversation(c.env.DB, c.get("user").id, id);
    return c.json({ conversation });
  })

  .delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = await deleteConversation(c.env.DB, c.get("user").id, id);
    if (!deleted) throw notFound("Conversation");
    return c.json({ ok: true });
  });
