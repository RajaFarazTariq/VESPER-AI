/**
 * Lists and notes (v0.19.0), for Settings → Lists & notes. VESPER fills them in the chat (tools/lists.ts); here the
 * user sees, ticks, renames and deletes them. Everything is the user's own: another account's ids give "not found".
 *   GET    /api/lists                          → { lists, notes } (lists by last change; notes newest first, ≤ 200)
 *   PATCH  /api/lists/:listId                  { name }            → { list }
 *   DELETE /api/lists/:listId                                      → { ok: true }
 *   PATCH  /api/lists/:listId/items/:itemId    { done?, text? }    → { list }
 *   DELETE /api/lists/:listId/items/:itemId                        → { list }
 *   PATCH  /api/notes/:noteId                  { text }            → { note }
 *   DELETE /api/notes/:noteId                                      → { ok: true }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import {
  allLists,
  cleanNote,
  deleteList,
  deleteNote,
  getList,
  listName,
  listNotes,
  MAX_ITEM_CHARS,
  MAX_LIST_NAME,
  MAX_NOTE_CHARS,
  oneLine,
  removeItems,
  renameList,
  updateItem,
  updateNote,
} from "../db/lists";
import { AppError, badRequest, notFound } from "../lib/errors";
import { sensitiveMessage, sensitiveReason } from "../lib/sensitive";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";

const renameSchema = z.object({ name: z.string().max(200) });
const itemSchema = z
  .object({ done: z.boolean().optional(), text: z.string().max(1_000).optional() })
  .refine((p) => p.done !== undefined || p.text !== undefined, { message: "Nothing to update." });
const noteSchema = z.object({ text: z.string().max(MAX_NOTE_CHARS * 2) });

export const listRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => {
    const userId = c.get("user").id;
    const [lists, notes] = await Promise.all([allLists(c.env.DB, userId), listNotes(c.env.DB, userId)]);
    return c.json({ lists, notes });
  })

  .patch("/:listId", async (c) => {
    const userId = c.get("user").id;
    const { name: raw } = await parseJson(c, renameSchema, 4 * 1024);
    const name = listName(raw);
    if (!name) throw badRequest("Give the list a name.");
    if (name.name.length > MAX_LIST_NAME) throw badRequest(`Keep a list name under ${MAX_LIST_NAME} characters.`);
    const renamed = await renameList(c.env.DB, userId, c.req.param("listId"), name);
    if (renamed === "taken") throw new AppError(409, "list_name_taken", `There is already a list called "${name.name}".`);
    if (!renamed) throw notFound("List");
    return c.json({ list: await getList(c.env.DB, userId, renamed.id) });
  })

  .delete("/:listId", async (c) => {
    if (!(await deleteList(c.env.DB, c.get("user").id, c.req.param("listId")))) throw notFound("List");
    return c.json({ ok: true });
  })

  .patch("/:listId/items/:itemId", async (c) => {
    const userId = c.get("user").id;
    const listId = c.req.param("listId");
    const patch = await parseJson(c, itemSchema, 4 * 1024);
    const text = patch.text === undefined ? undefined : oneLine(patch.text);
    if (text !== undefined && !text) throw badRequest("An item needs some text.");
    if (text !== undefined && text.length > MAX_ITEM_CHARS) throw badRequest(`Keep an item under ${MAX_ITEM_CHARS} characters.`);
    // Like memories and notes: passwords and card/bank/ID/phone numbers are never kept.
    const reason = text === undefined ? null : sensitiveReason(text);
    if (reason) throw new AppError(400, "sensitive_item", sensitiveMessage(reason));
    const changed = await updateItem(c.env.DB, userId, listId, c.req.param("itemId"), { ...(text !== undefined ? { text } : {}), ...(patch.done !== undefined ? { done: patch.done } : {}) });
    if (!changed) throw notFound("Item");
    return c.json({ list: await getList(c.env.DB, userId, listId) });
  })

  .delete("/:listId/items/:itemId", async (c) => {
    const userId = c.get("user").id;
    const listId = c.req.param("listId");
    if (!(await removeItems(c.env.DB, userId, listId, [c.req.param("itemId")]))) throw notFound("Item");
    return c.json({ list: await getList(c.env.DB, userId, listId) });
  });

export const noteRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .patch("/:noteId", async (c) => {
    const { text: raw } = await parseJson(c, noteSchema, 16 * 1024);
    const text = cleanNote(raw);
    if (!text) throw badRequest("A note needs some text.");
    if (text.length > MAX_NOTE_CHARS) throw badRequest(`A note can be at most ${MAX_NOTE_CHARS.toLocaleString("en-US")} characters.`);
    // Passwords, card/bank numbers, ID card numbers and phone numbers are never kept, exactly like memories.
    const reason = sensitiveReason(text);
    if (reason) throw new AppError(400, "sensitive_note", sensitiveMessage(reason));
    const note = await updateNote(c.env.DB, c.get("user").id, c.req.param("noteId"), text);
    if (!note) throw notFound("Note");
    return c.json({ note });
  })

  .delete("/:noteId", async (c) => {
    if (!(await deleteNote(c.env.DB, c.get("user").id, c.req.param("noteId")))) throw notFound("Note");
    return c.json({ ok: true });
  });
