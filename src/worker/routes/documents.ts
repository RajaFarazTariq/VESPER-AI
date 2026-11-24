/**
 * Documents in chat (v0.16.0): adding a document. The browser reads the file, splits its text into passages and sends:
 *   POST   /api/documents                → its name and size; counts today's limit (returns its id)
 *   POST   /api/documents/:id/chunks     → up to 50 passages at a time (safe to send again)
 *   POST   /api/documents/:id/complete   → ready to be sent with a message
 *   DELETE /api/documents/:id            → remove a document that wasn't sent (gives back today's count)
 * Sending the message (POST /api/chat with `documents`) links the document to the chat.
 */
import { Hono } from "hono";
import { z } from "zod";
import { CHUNK_HARD_LIMIT } from "../../shared/chunking";
import { CHAT_DOCUMENT_KINDS, DOCUMENT_LIMITS, documentsAllowed } from "../../shared/documents";
import type { ChatDocumentKind } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import {
  addChatDocumentChunks,
  completeChatDocument,
  createChatDocument,
  deleteUnsentChatDocument,
  DocumentError,
} from "../db/documents";
import { utcDay } from "../db/provider-state";
import { consumeDailyDocument, refundDailyDocument } from "../db/users";
import { getConfig } from "../env";
import { AppError, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";

/**
 * A batch of 50 passages of up to 4,000 characters, as JSON. Most text is 1 byte per character in UTF-8, but Urdu
 * and Arabic take 2 and Chinese 3, so this leaves room for those (passages are usually about 1,200 characters).
 */
const CHUNKS_BODY_LIMIT = 640 * 1024;
const CREATE_BODY_LIMIT = 4 * 1024;

// Upper limits on sizes are checked in db/documents.ts, which says plainly what is too large.
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(CHAT_DOCUMENT_KINDS as [ChatDocumentKind, ...ChatDocumentKind[]]),
  bytes: z.number().int().min(1),
  pages: z.number().int().min(1).nullable().optional(),
  expectedChunks: z.number().int().min(0),
  totalChars: z.number().int().min(0),
});
const chunksSchema = z.object({
  chunks: z
    .array(
      z.object({
        seq: z.number().int().min(0),
        // Kept to 120 characters when stored.
        location: z.string().max(1_000),
        text: z.string().max(CHUNK_HARD_LIMIT, "Passage text is empty or too long."),
      }),
    )
    .min(1)
    .max(DOCUMENT_LIMITS.chunksPerBatch),
});

/** Turn storage errors into API errors with plain messages. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    const status = { not_found: 404, invalid: 400, conflict: 409, limit: 409, full: 507 }[error.code] as 400 | 404 | 409 | 507;
    throw new AppError(status, error.code === "invalid" ? "bad_request" : `document_${error.code}`, error.message);
  }
}

const uploadLimiter = rateLimit("documents", 240, 60_000, (c) => c.get("user").id);

export const documentRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .post("/", uploadLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, createSchema, CREATE_BODY_LIMIT);
    const settings = await getAppSettings(c.env.DB, getConfig(c.env));
    if (!documentsAllowed(settings)) throw new AppError(403, "documents_off", "Documents are switched off.");
    // Admins are counted (usage view) but never limited.
    const perDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : settings.documentsPerDay;
    if (!(await consumeDailyDocument(c.env.DB, user.id, perDay))) {
      throw new AppError(
        429,
        "document_limit",
        perDay <= 0
          ? "Adding documents is paused for your account."
          : `You've added ${perDay} ${perDay === 1 ? "document" : "documents"} today, the daily limit. It resets at 00:00 UTC.`,
      );
    }
    const day = utcDay();
    try {
      const document = await run(() => createChatDocument(c.env.DB, user.id, { ...body, pages: body.pages ?? null }));
      return c.json({ document }, 201);
    } catch (error) {
      await refundDailyDocument(c.env.DB, user.id, day).catch(() => {});
      throw error;
    }
  })

  .post("/:id/chunks", uploadLimiter, async (c) => {
    const body = await parseJson(c, chunksSchema, CHUNKS_BODY_LIMIT);
    const document = await run(() => addChatDocumentChunks(c.env.DB, c.get("user").id, c.req.param("id"), body.chunks));
    return c.json({ document });
  })

  .post("/:id/complete", async (c) => c.json({ document: await run(() => completeChatDocument(c.env.DB, c.get("user").id, c.req.param("id"))) }))

  .delete("/:id", async (c) => {
    const user = c.get("user");
    const removed = await deleteUnsentChatDocument(c.env.DB, user.id, c.req.param("id"));
    if (!removed) throw notFound("Document");
    // Added and removed the same day: it doesn't count.
    const day = utcDay(removed.createdAt);
    if (day === utcDay()) await refundDailyDocument(c.env.DB, user.id, day);
    return c.json({ ok: true });
  });
