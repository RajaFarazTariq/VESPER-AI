/**
 * v0.16.0: documents in chat. The upload API (create → passages in batches → complete, remove while unsent) with its
 * limits and privacy, and what happens to the stored text when a chat is deleted or a document is never sent.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DOCUMENT_LIMITS } from "../src/shared/documents";
import type { KnowledgeChunkInput } from "../src/shared/types";
import { app } from "../src/worker/app";
import { createConversation } from "../src/worker/db/conversations";
import {
  addChatDocumentChunks,
  completeChatDocument,
  createChatDocument,
  linkChatDocuments,
  unsentReadyDocuments,
} from "../src/worker/db/documents";
import { cleanup } from "../src/worker/db/provider-state";

const ORIGIN = "http://localhost";

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), env, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json };
}
async function login(name: string) {
  const { response } = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: name }) });
  const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  const me = await call("/api/auth/me", { cookie });
  return { cookie, id: me.json.user.id as string };
}
const post = (path: string, body: unknown, cookie: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const remove = (id: string, cookie: string) => call(`/api/documents/${id}`, { method: "DELETE", cookie });
const setApp = (patch: object, cookie: string) => call("/api/admin/settings", { method: "PUT", body: JSON.stringify(patch), cookie });

/** One passage per page, each mentioning `word` (to find it in the full-text index). */
const passages = (n: number, word = "harbour"): KnowledgeChunkInput[] =>
  Array.from({ length: n }, (_, seq) => ({ seq, location: `page ${seq + 1}`, text: `Page ${seq + 1} is about the ${word}. ${"More text. ".repeat(20)}` }));
const chars = (parts: KnowledgeChunkInput[]) => parts.reduce((n, c) => n + c.text.length, 0);
const meta = (parts: KnowledgeChunkInput[], extra: object = {}) => ({
  name: "report.pdf",
  kind: "pdf",
  bytes: 50_000,
  pages: parts.length,
  expectedChunks: parts.length,
  totalChars: chars(parts),
  ...extra,
});

/** A ready, unsent document stored for a user, as the upload API would. */
async function seed(userId: string, word = "harbour", n = 3) {
  const parts = passages(n, word);
  const doc = await createChatDocument(env.DB, userId, { name: `${word}.pdf`, kind: "pdf", bytes: 1_000, pages: n, expectedChunks: n, totalChars: chars(parts) });
  await addChatDocumentChunks(env.DB, userId, doc.id, parts);
  return completeChatDocument(env.DB, userId, doc.id);
}
const indexed = async (word: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM chat_document_chunks_fts WHERE chat_document_chunks_fts MATCH ?1").bind(word).first<number>("n");
const countedToday = async (userId: string) =>
  (await env.DB.prepare("SELECT documents FROM user_usage_daily WHERE user_id = ?1").bind(userId).first<number>("documents")) ?? 0;

describe("adding documents to a chat", () => {
  it("stores the passages in batches (sending one again is harmless) and makes the document ready to send", async () => {
    const ann = await login("ann");
    const parts = passages(60);
    parts[0]!.location = `page 1 ${"x".repeat(300)}`;
    const created = await post("/api/documents", meta(parts), ann.cookie);
    expect(created.response.status).toBe(201);
    const id = created.json.document.id as string;
    expect(created.json.document).toMatchObject({ name: "report.pdf", kind: "pdf", status: "uploading", pages: 60, chunkCount: 0, charCount: 0 });

    const first = await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(0, 50) }, ann.cookie);
    expect(first.json.document).toMatchObject({ chunkCount: 50, charCount: chars(parts.slice(0, 50)) });
    const again = await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(0, 50) }, ann.cookie);
    expect(again.json.document).toMatchObject({ chunkCount: 50, charCount: chars(parts.slice(0, 50)) });
    const second = await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(50) }, ann.cookie);
    expect(second.json.document).toMatchObject({ status: "uploading", chunkCount: 60, charCount: chars(parts) });

    const done = await post(`/api/documents/${id}/complete`, {}, ann.cookie);
    expect(done.json.document).toMatchObject({ status: "ready", chunkCount: 60 });
    expect((await post(`/api/documents/${id}/complete`, {}, ann.cookie)).json.document.status).toBe("ready");
    expect(await unsentReadyDocuments(env.DB, ann.id, [id])).toEqual([{ id, name: "report.pdf", kind: "pdf", pages: 60, chars: chars(parts) }]);
    expect(await env.DB.prepare("SELECT MAX(LENGTH(location)) AS n FROM chat_document_chunks").first("n")).toBe(120);
    expect(await indexed("harbour")).toBe(60);
  });

  it("refuses unfinished uploads, passages after it is ready, and passages that don't fit", async () => {
    const ann = await login("ann");
    const parts = passages(3);
    const id = (await post("/api/documents", meta(parts), ann.cookie)).json.document.id as string;
    await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(0, 2) }, ann.cookie);
    const early = await post(`/api/documents/${id}/complete`, {}, ann.cookie);
    expect(early.response.status).toBe(409);
    expect(early.json.error).toEqual({ code: "document_conflict", message: "The upload is incomplete. Remove the file and attach it again." });

    const outOfRange = await post(`/api/documents/${id}/chunks`, { chunks: [{ seq: 3, location: "", text: "Too far." }] }, ann.cookie);
    expect([outOfRange.response.status, outOfRange.json.error.message]).toEqual([400, "Passage number out of range."]);
    const empty = await post(`/api/documents/${id}/chunks`, { chunks: [{ seq: 2, location: "", text: "   " }] }, ann.cookie);
    expect([empty.response.status, empty.json.error.message]).toEqual([400, "Passage text is empty or too long."]);

    await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(2) }, ann.cookie);
    expect((await post(`/api/documents/${id}/complete`, {}, ann.cookie)).response.status).toBe(200);
    const late = await post(`/api/documents/${id}/chunks`, { chunks: parts.slice(0, 1) }, ann.cookie);
    expect([late.response.status, late.json.error.code]).toEqual([409, "document_conflict"]);
  });

  it("keeps documents private: someone else can't add to, finish or remove yours", async () => {
    const ann = await login("ann");
    const eve = await login("eve");
    const parts = passages(2);
    const id = (await post("/api/documents", meta(parts), ann.cookie)).json.document.id as string;
    expect((await post(`/api/documents/${id}/chunks`, { chunks: parts }, eve.cookie)).response.status).toBe(404);
    expect((await post(`/api/documents/${id}/complete`, {}, eve.cookie)).response.status).toBe(404);
    expect((await remove(id, eve.cookie)).response.status).toBe(404);
    const own = await post(`/api/documents/${id}/chunks`, { chunks: parts }, ann.cookie);
    expect(own.json.document.chunkCount).toBe(2);
  });

  it("counts documents per day (admins never limited); removing an unsent one the same day gives it back", async () => {
    const ann = await login("ann");
    const admin = await login("octocat");
    const parts = passages(1);
    await setApp({ documentsPerDay: 1 }, admin.cookie);
    const first = await post("/api/documents", meta(parts), ann.cookie);
    expect(first.response.status).toBe(201);
    const second = await post("/api/documents", meta(parts), ann.cookie);
    expect(second.response.status).toBe(429);
    expect(second.json.error).toEqual({ code: "document_limit", message: "You've added 1 document today, the daily limit. It resets at 00:00 UTC." });
    expect((await remove(first.json.document.id, ann.cookie)).json).toEqual({ ok: true });
    expect((await post("/api/documents", meta(parts), ann.cookie)).response.status).toBe(201);

    for (let i = 0; i < 3; i++) expect((await post("/api/documents", meta(parts), admin.cookie)).response.status).toBe(201);
    const users = (await call("/api/admin/users", { cookie: admin.cookie })).json.users;
    expect(users.find((u: any) => u.login === "ann").todayDocuments).toBe(1);
    expect(users.find((u: any) => u.login === "octocat").todayDocuments).toBe(3);

    await setApp({ documentsPerDay: 0 }, admin.cookie);
    expect((await post("/api/documents", meta(parts), ann.cookie)).json.error.message).toBe("Adding documents is paused for your account.");
  });

  it("says plainly when a document is too large, and limits how many a user keeps and the storage for everyone", async () => {
    const ann = await login("ann");
    const parts = passages(1);
    const tooLarge = "The document is too large (about 300 pages at most). Split it into smaller files.";
    const refused = async (extra: object) => {
      const r = await post("/api/documents", meta(parts, extra), ann.cookie);
      return [r.response.status, r.json.error.code, r.json.error.message];
    };
    expect(await refused({ pages: 301 })).toEqual([400, "bad_request", "This PDF has 301 pages; up to 300 can be attached. Split it into smaller files."]);
    expect(await refused({ totalChars: DOCUMENT_LIMITS.chars + 1 })).toEqual([400, "bad_request", tooLarge]);
    expect(await refused({ expectedChunks: DOCUMENT_LIMITS.chunks + 1 })).toEqual([400, "bad_request", tooLarge]);
    expect(await refused({ bytes: DOCUMENT_LIMITS.fileBytes + 1 })).toEqual([400, "bad_request", "The file is larger than 20 MB."]);
    // Refused documents don't count against today's limit.
    expect(await countedToday(ann.id)).toBe(0);

    for (let i = 0; i < DOCUMENT_LIMITS.stored; i++) {
      await createChatDocument(env.DB, ann.id, { name: `d${i}.txt`, kind: "txt", bytes: 10, pages: null, expectedChunks: 1, totalChars: 10 });
    }
    expect(await refused({})).toEqual([409, "document_limit", "You can keep up to 30 documents. Delete an older chat that has documents to add more."]);

    const bob = await login("bob");
    await env.DB.prepare("UPDATE chat_documents SET char_count = 40000000 WHERE id = (SELECT id FROM chat_documents LIMIT 1)").run();
    const full = await post("/api/documents", meta(parts), bob.cookie);
    expect([full.response.status, full.json.error.code]).toEqual([507, "document_full"]);
    expect(await countedToday(ann.id)).toBe(0);
    expect(await countedToday(bob.id)).toBe(0);
  });

  it("is refused when the admin switches documents off, and the chat screen is told", async () => {
    const ann = await login("ann");
    const admin = await login("octocat");
    expect((await call("/api/media/features", { cookie: ann.cookie })).json.documents).toEqual({
      enabled: true,
      perDay: 10,
      perChat: 5,
      perMessage: 3,
      maxPages: 300,
      maxMegabytes: 20,
    });
    await setApp({ documentsEnabled: false }, admin.cookie);
    const off = await post("/api/documents", meta(passages(1)), admin.cookie);
    expect([off.response.status, off.json.error.code, off.json.error.message]).toEqual([403, "documents_off", "Documents are switched off."]);
    expect((await call("/api/media/features", { cookie: ann.cookie })).json.documents.enabled).toBe(false);
  });
});

describe("stored documents", () => {
  it("can be removed only while unsent; deleting the chat deletes the documents, their passages and their index", async () => {
    const ann = await login("ann");
    const sent = await seed(ann.id, "harbour");
    const unsent = await seed(ann.id, "lighthouse");
    expect([await indexed("harbour"), await indexed("lighthouse")]).toEqual([3, 3]);

    // Removing an unsent one (the ✕ on its chip) takes its passages out of the index too.
    expect((await remove(unsent.id, ann.cookie)).response.status).toBe(200);
    expect(await indexed("lighthouse")).toBe(0);

    const conversation = await createConversation(env.DB, ann.id, "Report", "auto");
    await linkChatDocuments(env.DB, ann.id, [sent.id], conversation.id);
    expect((await remove(sent.id, ann.cookie)).response.status).toBe(404);
    expect(await unsentReadyDocuments(env.DB, ann.id, [sent.id])).toEqual([]);

    expect((await call(`/api/conversations/${conversation.id}`, { method: "DELETE", cookie: ann.cookie })).response.status).toBe(200);
    const left = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM chat_documents) AS documents, (SELECT COUNT(*) FROM chat_document_chunks) AS chunks",
    ).first();
    expect(left).toEqual({ documents: 0, chunks: 0 });
    expect(await indexed("harbour")).toBe(0);
  });

  it("are removed by the daily clean-up when they were never sent within a day", async () => {
    const ann = await login("ann");
    const old = await seed(ann.id, "harbour");
    const unfinished = await createChatDocument(env.DB, ann.id, { name: "half.txt", kind: "txt", bytes: 10, pages: null, expectedChunks: 2, totalChars: 20 });
    const recent = await seed(ann.id, "lighthouse");
    const kept = await seed(ann.id, "anchor");
    const conversation = await createConversation(env.DB, ann.id, "Report", "auto");
    await linkChatDocuments(env.DB, ann.id, [kept.id], conversation.id);
    const dayAgo = Date.now() - 25 * 3_600_000;
    await env.DB.prepare("UPDATE chat_documents SET created_at = ?1 WHERE id IN (?2, ?3, ?4)").bind(dayAgo, old.id, unfinished.id, kept.id).run();

    await cleanup(env.DB);
    const { results } = await env.DB.prepare("SELECT id FROM chat_documents ORDER BY name").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual([kept.id, recent.id]);
    expect(await indexed("harbour")).toBe(0);
  });
});

describe("the storage meter (admin)", () => {
  it("shows the database size against the free 500 MB and the text each file feature keeps", async () => {
    const admin = await login("octocat");
    const ann = await login("ann");
    const doc = await seed(ann.id, "harbour");
    const { response, json } = await call("/api/admin/settings", { cookie: admin.cookie });
    expect(response.status).toBe(200);
    const storage = json.storage;
    expect(storage.maxBytes).toBe(500 * 1024 * 1024);
    // D1 reports the size with every query; a test database may not, which the meter shows as "not available".
    expect(storage.bytes === null || (typeof storage.bytes === "number" && storage.bytes > 0)).toBe(true);
    expect(storage.documents).toEqual({ chars: doc.charCount, maxChars: 40_000_000 });
    expect(storage.spreadsheets).toEqual({ chars: 0, maxChars: 120_000_000 });
    expect(storage.knowledge).toEqual({ chars: 0, maxChars: 50_000_000 });
    // Regular users don't get it.
    expect((await call("/api/admin/settings", { cookie: ann.cookie })).response.status).toBe(403);
  });
});

describe("size checks that can't be raced (review fixes)", () => {
  it("never makes a document ready when parallel batches took it over the limit, and caps each user's text", async () => {
    const ann = await login("ann");
    const doc = await seed(ann.id, "harbour");
    // Pretend parallel batches stored more than one document may hold before any of them saw the others.
    const half = await createChatDocument(env.DB, ann.id, { name: "big.txt", kind: "txt", bytes: 10, pages: null, expectedChunks: 1, totalChars: 10 });
    await addChatDocumentChunks(env.DB, ann.id, half.id, passages(1));
    await env.DB.prepare("UPDATE chat_documents SET char_count = ?1 WHERE id = ?2").bind(DOCUMENT_LIMITS.chars + 1, half.id).run();
    const refused = await post(`/api/documents/${half.id}/complete`, {}, ann.cookie);
    expect([refused.response.status, refused.json.error.message]).toEqual([400, "The document is too large (about 300 pages at most). Split it into smaller files."]);
    expect(doc.status).toBe("ready");

    // Each user keeps at most 5 million characters of document text.
    await env.DB.prepare("UPDATE chat_documents SET char_count = ?1 WHERE id = ?2").bind(DOCUMENT_LIMITS.userChars, doc.id).run();
    const full = await post("/api/documents", meta(passages(1)), ann.cookie);
    expect([full.response.status, full.json.error.code]).toEqual([409, "document_limit"]);
    expect(full.json.error.message).toContain("about 1,500 pages");
    // Someone else can still add theirs.
    const bob = await login("bob");
    expect((await post("/api/documents", meta(passages(1)), bob.cookie)).response.status).toBe(201);
  });
});
