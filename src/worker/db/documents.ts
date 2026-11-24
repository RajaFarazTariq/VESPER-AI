/**
 * Documents in chat (v0.16.0): storing the documents users add (tables from migrations/0015_chat_documents.sql).
 *
 * Adding a document (the browser has already read the file and split its text into passages):
 *   createChatDocument    → the document ("uploading"), after checking the limits
 *   addChatDocumentChunks → batches of passages (safe to send again after a network error)
 *   completeChatDocument  → "ready" once every passage is there
 * Sending the message links the document to the chat (linkChatDocuments). Deleting the chat deletes its documents;
 * documents that were never sent are removed by the daily clean-up after 24 hours (or at once when the user removes them).
 * Searching and reading them for an answer: db/document-search.ts.
 */
import { CHUNK_HARD_LIMIT } from "../../shared/chunking";
import { DOCUMENT_LIMITS, DOCUMENT_STORAGE_CHARS } from "../../shared/documents";
import type { ChatDocumentDto, ChatDocumentKind, KnowledgeChunkInput, MessageDocumentDto } from "../../shared/types";
import { newId } from "../lib/crypto";

export class DocumentError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "limit" | "full",
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
/** Documents added but never sent are removed after this long. */
export const UNSENT_DOCUMENT_MS = DAY_MS;
/** D1 allows 100 bound parameters per statement; 4 per passage row. */
const ROWS_PER_INSERT = 20;
/** A passage's place in the file ("page 12", "section “Leave policy”") is kept this short. */
const LOCATION_CHARS = 120;

interface DocumentRow {
  id: string;
  name: string;
  kind: ChatDocumentKind;
  status: "uploading" | "ready";
  pages: number | null;
  expected_chunks: number;
  chunk_count: number;
  char_count: number;
  created_at: number;
}

const COLUMNS = "id, name, kind, status, pages, expected_chunks, chunk_count, char_count, created_at";

const toDto = (r: DocumentRow): ChatDocumentDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  status: r.status,
  pages: r.pages,
  chunkCount: r.chunk_count,
  charCount: r.char_count,
  createdAt: r.created_at,
});

/** One of the user's documents. Someone else's is "not found", the same as one that doesn't exist. */
async function ownDocument(db: D1Database, userId: string, documentId: string): Promise<DocumentRow> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM chat_documents WHERE id = ?1 AND user_id = ?2`)
    .bind(documentId, userId)
    .first<DocumentRow>();
  if (!row) throw new DocumentError("not_found", "Document not found.");
  return row;
}

/** Text of every user's stored chat documents (characters), against the app-wide budget. */
export async function chatDocumentStorageUsed(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(char_count), 0) AS n FROM chat_documents").first<{ n: number }>();
  return row?.n ?? 0;
}

const TOO_LARGE = `The document is too large (about ${DOCUMENT_LIMITS.pages} pages at most). Split it into smaller files.`;
const STORAGE_FULL =
  "Storage for documents is full right now. Delete older chats that have documents, or ask the administrator.";

/**
 * Start adding a document: checks its size and how many documents the user keeps, then stores it as "uploading".
 * `totalChars` is the text of all its passages together (what is stored). The daily limit is counted by the caller
 * (before this) and given back if this refuses.
 */
export async function createChatDocument(
  db: D1Database,
  userId: string,
  input: { name: string; kind: ChatDocumentKind; bytes: number; pages: number | null; expectedChunks: number; totalChars: number },
): Promise<ChatDocumentDto> {
  if (input.bytes > DOCUMENT_LIMITS.fileBytes) {
    throw new DocumentError("invalid", `The file is larger than ${DOCUMENT_LIMITS.fileBytes / (1024 * 1024)} MB.`);
  }
  if (input.pages !== null && input.pages > DOCUMENT_LIMITS.pages) {
    throw new DocumentError(
      "invalid",
      `This PDF has ${input.pages.toLocaleString("en-US")} pages; up to ${DOCUMENT_LIMITS.pages} can be attached. Split it into smaller files.`,
    );
  }
  if (input.expectedChunks < 1 || input.totalChars < 1) {
    throw new DocumentError("invalid", "This file has no readable text (a scanned PDF needs to be converted to text first).");
  }
  if (input.expectedChunks > DOCUMENT_LIMITS.chunks || input.totalChars > DOCUMENT_LIMITS.chars) {
    throw new DocumentError("invalid", TOO_LARGE);
  }
  const kept = await db.prepare("SELECT COUNT(*) AS n FROM chat_documents WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  if ((kept?.n ?? 0) >= DOCUMENT_LIMITS.stored) {
    throw new DocumentError(
      "limit",
      `You can keep up to ${DOCUMENT_LIMITS.stored} documents. Delete an older chat that has documents to add more.`,
    );
  }
  const own = await db
    .prepare("SELECT COALESCE(SUM(char_count), 0) AS n FROM chat_documents WHERE user_id = ?1")
    .bind(userId)
    .first<{ n: number }>();
  if ((own?.n ?? 0) + input.totalChars > DOCUMENT_LIMITS.userChars) {
    throw new DocumentError(
      "limit",
      "Your documents already use all of your space (about 1,500 pages). Delete an older chat that has documents to add more.",
    );
  }
  if ((await chatDocumentStorageUsed(db)) + input.totalChars > DOCUMENT_STORAGE_CHARS) throw new DocumentError("full", STORAGE_FULL);

  const now = Date.now();
  const row: DocumentRow = {
    id: newId(),
    name: input.name,
    kind: input.kind,
    status: "uploading",
    pages: input.pages,
    expected_chunks: input.expectedChunks,
    chunk_count: 0,
    char_count: 0,
    created_at: now,
  };
  await db
    .prepare(
      `INSERT INTO chat_documents (id, user_id, conversation_id, name, kind, bytes, pages, status, expected_chunks, chunk_count, char_count, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 'uploading', ?7, 0, 0, ?8, ?8)`,
    )
    .bind(row.id, userId, row.name, row.kind, input.bytes, row.pages, row.expected_chunks, now)
    .run();
  return toDto(row);
}

/**
 * Store a batch of passages for a document that is still uploading. Sending a batch again (after a network error) is
 * harmless: passages already there are skipped and don't count twice. Returns the document with its new counts.
 */
export async function addChatDocumentChunks(
  db: D1Database,
  userId: string,
  documentId: string,
  chunks: KnowledgeChunkInput[],
): Promise<ChatDocumentDto> {
  const doc = await ownDocument(db, userId, documentId);
  if (doc.status !== "uploading") throw new DocumentError("conflict", "This document is already complete.");
  if (chunks.length === 0) return toDto(doc);
  if (chunks.length > DOCUMENT_LIMITS.chunksPerBatch) {
    throw new DocumentError("invalid", `Send at most ${DOCUMENT_LIMITS.chunksPerBatch} passages at a time.`);
  }
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq >= doc.expected_chunks) {
      throw new DocumentError("invalid", "Passage number out of range.");
    }
    if (!chunk.text.trim() || chunk.text.length > CHUNK_HARD_LIMIT) throw new DocumentError("invalid", "Passage text is empty or too long.");
  }

  // Only passages not stored yet count against the limits (once each, even if a batch repeats one).
  const marks = chunks.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(`SELECT seq FROM chat_document_chunks WHERE document_id = ?1 AND seq IN (${marks})`)
    .bind(documentId, ...chunks.map((c) => c.seq))
    .all<{ seq: number }>();
  const fresh = new Map<number, KnowledgeChunkInput>();
  for (const chunk of chunks) if (!fresh.has(chunk.seq)) fresh.set(chunk.seq, chunk);
  for (const { seq } of results) fresh.delete(seq);
  if (fresh.size === 0) return toDto(doc);
  const rows = [...fresh.values()];
  const chars = rows.reduce((n, c) => n + c.text.length, 0);
  if (doc.char_count + chars > DOCUMENT_LIMITS.chars) throw new DocumentError("invalid", TOO_LARGE);
  if ((await chatDocumentStorageUsed(db)) + chars > DOCUMENT_STORAGE_CHARS) throw new DocumentError("full", STORAGE_FULL);

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const part = rows.slice(i, i + ROWS_PER_INSERT);
    const values = part.map((_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4})`).join(", ");
    // OR IGNORE: the same batch sent twice at the same moment still stores each passage once.
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO chat_document_chunks (document_id, seq, location, text) VALUES ${values}`)
        .bind(...part.flatMap((c) => [documentId, c.seq, c.location.slice(0, LOCATION_CHARS), c.text])),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE chat_documents SET
           chunk_count = (SELECT COUNT(*) FROM chat_document_chunks WHERE document_id = ?1),
           char_count = (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM chat_document_chunks WHERE document_id = ?1),
           updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(documentId, Date.now()),
  );
  await db.batch(statements);
  return toDto(await ownDocument(db, userId, documentId));
}

/** Mark a document ready once every passage is there; only then can it be sent with a message. */
export async function completeChatDocument(db: D1Database, userId: string, documentId: string): Promise<ChatDocumentDto> {
  const doc = await ownDocument(db, userId, documentId);
  if (doc.status === "ready") return toDto(doc);
  if (doc.chunk_count < doc.expected_chunks) {
    throw new DocumentError("conflict", "The upload is incomplete. Remove the file and attach it again.");
  }
  // Batches sent at the same time are each checked before the others are stored, so the size is checked once more here:
  // a document over the limit never becomes ready (it is removed by the browser, or by the daily clean-up).
  if (doc.char_count > DOCUMENT_LIMITS.chars) throw new DocumentError("invalid", TOO_LARGE);
  await db.prepare("UPDATE chat_documents SET status = 'ready', updated_at = ?2 WHERE id = ?1").bind(documentId, Date.now()).run();
  return toDto({ ...doc, status: "ready" });
}

/**
 * Remove a document the user added but hasn't sent (the ✕ on its chip); its passages and their index entries go with
 * it. Sent documents stay with their chat. Returns when it was added (for giving back today's count), or null when
 * there was nothing to remove.
 */
export async function deleteUnsentChatDocument(db: D1Database, userId: string, documentId: string): Promise<{ createdAt: number } | null> {
  const row = await db
    .prepare("DELETE FROM chat_documents WHERE id = ?1 AND user_id = ?2 AND conversation_id IS NULL RETURNING created_at")
    .bind(documentId, userId)
    .first<{ created_at: number }>();
  return row ? { createdAt: row.created_at } : null;
}

/** The user's ready documents that aren't in a chat yet, as chips for the message (in the order asked). */
export async function unsentReadyDocuments(db: D1Database, userId: string, ids: string[]): Promise<MessageDocumentDto[]> {
  if (ids.length === 0) return [];
  const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, pages, char_count AS chars FROM chat_documents
        WHERE user_id = ?1 AND id IN (${marks}) AND status = 'ready' AND conversation_id IS NULL`,
    )
    .bind(userId, ...ids)
    .all<MessageDocumentDto>();
  return ids.flatMap((id) => results.filter((r) => r.id === id));
}

/** How many documents a chat already has. */
export async function conversationDocumentCount(db: D1Database, userId: string, conversationId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM chat_documents WHERE conversation_id = ?1 AND user_id = ?2")
    .bind(conversationId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Attach the documents to the chat their message was sent in. Only the user's own, ready, unsent documents move. */
export async function linkChatDocuments(db: D1Database, userId: string, ids: string[], conversationId: string): Promise<void> {
  if (ids.length === 0) return;
  const marks = ids.map((_, i) => `?${i + 4}`).join(", ");
  await db
    .prepare(
      `UPDATE chat_documents SET conversation_id = ?1, updated_at = ?3
        WHERE user_id = ?2 AND id IN (${marks}) AND status = 'ready' AND conversation_id IS NULL`,
    )
    .bind(conversationId, userId, Date.now(), ...ids)
    .run();
}

/** For the daily clean-up: documents added but never sent (or never finished) within 24 hours are removed. */
export function chatDocumentCleanup(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM chat_documents WHERE conversation_id IS NULL AND created_at < ?1").bind(now - UNSENT_DOCUMENT_MS),
    db.prepare("DELETE FROM chat_documents WHERE status = 'uploading' AND created_at < ?1").bind(now - UNSENT_DOCUMENT_MS),
  ];
}
