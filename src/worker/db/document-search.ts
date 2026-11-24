/**
 * Documents in chat (v0.16.0): finding and reading the documents of one chat for an answer.
 *
 * Every query here is limited to the ready documents of one chat of one user, so a search can never return a passage
 * from someone else's file or from another chat. Storing the documents: db/documents.ts.
 *
 * - conversationDocuments: the chat's documents, numbered D1, D2… (named in the system prompt).
 * - searchDocumentChunks: full-text match (FTS5, BM25) over the chat's passages; the tool then re-orders them by meaning.
 * - readDocumentPassages: passages in order, from a part or from a page, for summaries and "what's on page 5".
 */
import type { ChatDocumentKind } from "../../shared/types";
import { buildMatchQuery } from "./knowledge";

/** A document as the assistant and the document tools see it. */
export interface ChatDocumentMeta {
  id: string;
  /** "D1", "D2"… in the order the documents were added to the chat (stable: documents are only ever added). */
  ref: string;
  name: string;
  kind: ChatDocumentKind;
  /** PDFs only. */
  pages: number | null;
  /** Characters of text. */
  chars: number;
  /** Passages; a ready document has all of them, numbered 0 to chunks − 1. */
  chunks: number;
  createdAt: number;
}

/**
 * The chat's ready documents, numbered D1, D2… in the order they joined the chat. `updated_at` is set when a document is
 * linked to its chat and never changed afterwards (a document uploaded earlier but sent later comes after, so the
 * numbers earlier answers used stay the same); documents sent together keep the order they were added in.
 */
export async function conversationDocuments(db: D1Database, userId: string, conversationId: string): Promise<ChatDocumentMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, pages, char_count, chunk_count, created_at FROM chat_documents
        WHERE conversation_id = ?1 AND user_id = ?2 AND status = 'ready'
        ORDER BY updated_at, created_at, id`,
    )
    .bind(conversationId, userId)
    .all<{ id: string; name: string; kind: ChatDocumentKind; pages: number | null; char_count: number; chunk_count: number; created_at: number }>();
  return results.map((r, i) => ({
    id: r.id,
    ref: `D${i + 1}`,
    name: r.name,
    kind: r.kind,
    pages: r.pages,
    chars: r.char_count,
    chunks: r.chunk_count,
    createdAt: r.created_at,
  }));
}

/** Does this chat have a ready document? (The document tools are offered only then.) */
export async function conversationHasDocuments(db: D1Database, userId: string, conversationId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM chat_documents WHERE conversation_id = ?1 AND user_id = ?2 AND status = 'ready' LIMIT 1")
    .bind(conversationId, userId)
    .first();
  return row !== null;
}

export interface DocumentHit {
  chunkId: number;
  documentId: string;
  /** The passage's place in its document (0-based; part = seq + 1). */
  seq: number;
  location: string;
  text: string;
}

/** Up to `limit` candidate passages from the chat's documents (or one of them), best keyword match first. */
export async function searchDocumentChunks(
  db: D1Database,
  userId: string,
  conversationId: string,
  query: string,
  options: { documentId?: string; limit?: number } = {},
): Promise<DocumentHit[]> {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const one = options.documentId ? "AND d.id = ?5" : "";
  const { results } = await db
    .prepare(
      `SELECT c.id AS chunkId, c.document_id AS documentId, c.seq, c.location, c.text
         FROM chat_document_chunks_fts
         JOIN chat_document_chunks c ON c.id = chat_document_chunks_fts.rowid
         JOIN chat_documents d ON d.id = c.document_id
        WHERE chat_document_chunks_fts MATCH ?1
          AND d.conversation_id = ?2 AND d.user_id = ?3 AND d.status = 'ready' ${one}
        ORDER BY chat_document_chunks_fts.rank
        LIMIT ?4`,
    )
    .bind(match, conversationId, userId, options.limit ?? 30, ...(options.documentId ? [options.documentId] : []))
    .all<DocumentHit>();
  return results;
}

export interface DocumentPassage {
  seq: number;
  location: string;
  text: string;
}

/** Passages fetched per read; more than fit in one read_document result even when they are short. */
const READ_ROWS = 60;

/**
 * A document's passages in order, starting at a passage (`fromSeq`) or at the first passage on page `fromPage` or
 * the next page that has text (PDF passages are in page order). Only the user's own ready document in this chat.
 * The caller stops adding passages at its character budget; this returns up to READ_ROWS of them.
 */
export async function readDocumentPassages(
  db: D1Database,
  userId: string,
  conversationId: string,
  documentId: string,
  from: { seq: number } | { page: number },
): Promise<DocumentPassage[]> {
  const start =
    "seq" in from
      ? "?5"
      : `(SELECT seq FROM chat_document_chunks
           WHERE document_id = ?1 AND location LIKE 'page %' AND CAST(substr(location, 6) AS INTEGER) >= ?5
           ORDER BY seq LIMIT 1)`;
  const { results } = await db
    .prepare(
      `SELECT c.seq, c.location, c.text
         FROM chat_document_chunks c
         JOIN chat_documents d ON d.id = c.document_id
        WHERE c.document_id = ?1 AND d.user_id = ?2 AND d.conversation_id = ?3 AND d.status = 'ready'
          AND c.seq >= ${start}
        ORDER BY c.seq
        LIMIT ?4`,
    )
    .bind(documentId, userId, conversationId, READ_ROWS, "seq" in from ? from.seq : from.page)
    .all<DocumentPassage>();
  return results;
}
