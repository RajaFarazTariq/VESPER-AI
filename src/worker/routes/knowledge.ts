/**
 * Knowledge base management (admin panel → Knowledge). Administrator only.
 *
 * Uploading a file: the browser extracts the text and splits it into passages, then
 *   POST /documents                  → creates the document ("uploading") after checking the free space
 *   POST /documents/:id/chunks       → stores passages in batches of up to 50 (safe to retry)
 *   POST /documents/:id/complete     → marks it "ready" (searchable)
 * Adding a web page: POST /web reads the page on the server and does all three steps at once.
 */
import { Hono } from "hono";
import { z } from "zod";
import { chunkUnits, CHUNK_HARD_LIMIT } from "../../shared/chunking";
import type { AppEnv } from "../app-env";
import {
  addChunks,
  completeDocument,
  createCollection,
  createDocument,
  deleteCollection,
  deleteDocument,
  KNOWLEDGE_KINDS,
  KnowledgeError,
  knowledgeUsage,
  listCollections,
  MAX_CHUNKS_PER_BATCH,
  updateCollection,
} from "../db/knowledge";
import { getConfig } from "../env";
import { AppError, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireAdmin, requireUser } from "../middleware/auth";
import { clip } from "../tools/net";
import { ToolInputError } from "../tools/types";
import { fetchPageText } from "../tools/web";
import { VERSION } from "../version";

/** A web page adds at most this much text (keeps one request within the free plan's per-request limits). */
const MAX_WEB_PAGE_CHARS = 100_000;

const name = z.string().trim().min(1, "Give the folder a name.").max(80);
const description = z.string().trim().max(300);
const id = z.string().trim().min(1).max(64);

const chunkSchema = z.object({
  seq: z.number().int().min(0).max(100_000),
  location: z.string().max(120),
  text: z.string().min(1).max(CHUNK_HARD_LIMIT),
});

/** Turn storage errors into API errors with plain messages. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    switch (error.code) {
      case "not_found":
        throw new AppError(404, "not_found", error.message);
      case "knowledge_full":
        throw new AppError(409, "knowledge_full", error.message);
      case "conflict":
        throw new AppError(409, "conflict", error.message);
      default:
        throw new AppError(400, "bad_request", error.message);
    }
  }
}

export const knowledgeRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)

  .get("/", async (c) => {
    const [collections, usage] = await Promise.all([listCollections(c.env.DB), knowledgeUsage(c.env.DB)]);
    return c.json({ collections, usage });
  })

  .post("/collections", async (c) => {
    const body = await parseJson(c, z.object({ name, description: description.default("") }));
    return c.json({ collection: await run(() => createCollection(c.env.DB, body)) }, 201);
  })

  .patch("/collections/:id", async (c) => {
    const body = await parseJson(
      c,
      z.object({ name: name.optional(), description: description.optional() }).refine((b) => b.name !== undefined || b.description !== undefined, {
        message: "Nothing to update.",
      }),
    );
    await run(() => updateCollection(c.env.DB, c.req.param("id"), body));
    return c.json({ ok: true });
  })

  .delete("/collections/:id", async (c) => {
    if (!(await deleteCollection(c.env.DB, c.req.param("id")))) throw notFound("Folder");
    return c.json({ ok: true });
  })

  .post("/documents", async (c) => {
    const body = await parseJson(
      c,
      z.object({
        collectionId: id,
        title: z.string().trim().min(1).max(200),
        kind: z.enum(KNOWLEDGE_KINDS.filter((k) => k !== "web") as ["pdf", "docx", "txt", "md", "csv"]),
        pages: z.number().int().min(1).max(100_000).nullable().optional(),
        expectedChunks: z.number().int().min(1).max(100_000),
        totalChars: z.number().int().min(1).max(1_000_000_000),
      }),
    );
    const document = await run(() => createDocument(c.env.DB, { ...body, pages: body.pages ?? null }));
    return c.json({ document }, 201);
  })

  .post("/documents/:id/chunks", async (c) => {
    const body = await parseJson(c, z.object({ chunks: z.array(chunkSchema).min(1).max(MAX_CHUNKS_PER_BATCH) }));
    return c.json({ document: await run(() => addChunks(c.env.DB, c.req.param("id"), body.chunks)) });
  })

  .post("/documents/:id/complete", async (c) => c.json({ document: await run(() => completeDocument(c.env.DB, c.req.param("id"))) }))

  .delete("/documents/:id", async (c) => {
    if (!(await deleteDocument(c.env.DB, c.req.param("id")))) throw notFound("Document");
    return c.json({ ok: true });
  })

  /** Read a public web page now and add its text to a folder. */
  .post("/web", async (c) => {
    const body = await parseJson(c, z.object({ collectionId: id, url: z.string().trim().min(8).max(2000) }));
    const origin = new URL(c.req.url).origin;
    let page: Awaited<ReturnType<typeof fetchPageText>>;
    try {
      page = await fetchPageText(body.url, {
        userAgent: `${getConfig(c.env).appName.replace(/[^\w.-]/g, "") || "Assistant"}/${VERSION} (+${origin})`,
        maxBytes: 2_000_000,
      });
    } catch (error) {
      if (error instanceof ToolInputError) throw new AppError(400, "page_unreadable", error.message);
      throw error;
    }
    const chunks = chunkUnits([{ location: "", text: page.text.slice(0, MAX_WEB_PAGE_CHARS) }]);
    if (chunks.length === 0) throw new AppError(400, "page_unreadable", "The page has no readable text.");
    const document = await run(async () => {
      const doc = await createDocument(c.env.DB, {
        collectionId: body.collectionId,
        title: clip(page.title || page.url.hostname, 200),
        kind: "web",
        sourceUrl: page.url.href,
        expectedChunks: chunks.length,
        totalChars: chunks.reduce((n, ch) => n + ch.text.length, 0),
      });
      try {
        for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_BATCH) {
          await addChunks(c.env.DB, doc.id, chunks.slice(i, i + MAX_CHUNKS_PER_BATCH));
        }
        return await completeDocument(c.env.DB, doc.id);
      } catch (error) {
        await deleteDocument(c.env.DB, doc.id).catch(() => {}); // don't leave a half-added page behind
        throw error;
      }
    });
    return c.json({ document }, 201);
  });
