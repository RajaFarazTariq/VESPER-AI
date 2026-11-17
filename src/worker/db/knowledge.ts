/**
 * Knowledge base storage (tables from migrations/0004_knowledge_base.sql).
 *
 * Collections hold documents; documents hold passages ("chunks") of extracted text. Files are read
 * in the administrator's browser and arrive here as passages in small batches (the free Workers
 * plan allows only ~10 ms of CPU per request, so the server never parses PDFs itself). A document
 * is searchable once it is "ready"; an interrupted upload stays "uploading" and can be deleted.
 *
 * Search: FTS5 full-text match (BM25), then the tool re-orders the best candidates by meaning.
 */
import type {
  KnowledgeChunkInput,
  KnowledgeCollectionDto,
  KnowledgeDocKind,
  KnowledgeDocumentDto,
  KnowledgeUsageDto,
} from "../../shared/types";
import { CHUNK_HARD_LIMIT } from "../../shared/chunking";
import { newId } from "../lib/crypto";

/**
 * Total text the knowledge base may hold: 50 million characters, about 15,000 pages. With its search
 * index that is roughly 100–150 MB of the free 500 MB database, leaving plenty for conversations.
 */
export const MAX_KNOWLEDGE_CHARS = 50_000_000;
export const MAX_COLLECTIONS = 50;
export const MAX_DOCUMENTS_PER_COLLECTION = 500;
/** One document: about 1,000 pages. */
export const MAX_DOCUMENT_CHARS = 3_000_000;
export const MAX_DOCUMENT_CHUNKS = 5_000;
/** Passages per upload request (keeps each request small and well under the D1 per-request limits). */
export const MAX_CHUNKS_PER_BATCH = 50;
/** D1 allows 100 bound parameters per statement; 4 per passage row. */
const ROWS_PER_INSERT = 20;

export const KNOWLEDGE_KINDS: readonly KnowledgeDocKind[] = ["pdf", "docx", "txt", "md", "csv", "web"];

export class KnowledgeError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "knowledge_full" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

interface CollectionRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
}

interface DocumentRow {
  id: string;
  collection_id: string;
  title: string;
  kind: KnowledgeDocKind;
  source_url: string | null;
  status: "uploading" | "ready";
  pages: number | null;
  expected_chunks: number;
  chunk_count: number;
  char_count: number;
  created_at: number;
}

const DOC_COLUMNS =
  "id, collection_id, title, kind, source_url, status, pages, expected_chunks, chunk_count, char_count, created_at";

const docDto = (r: DocumentRow): KnowledgeDocumentDto => ({
  id: r.id,
  collectionId: r.collection_id,
  title: r.title,
  kind: r.kind,
  sourceUrl: r.source_url,
  status: r.status,
  pages: r.pages,
  chunkCount: r.chunk_count,
  charCount: r.char_count,
  createdAt: r.created_at,
});

// ------------------------------------------------------------------ Collections

export async function listCollections(db: D1Database): Promise<KnowledgeCollectionDto[]> {
  const [collections, documents] = await db.batch([
    db.prepare("SELECT id, name, description, created_at FROM kb_collections ORDER BY name COLLATE NOCASE"),
    db.prepare(`SELECT ${DOC_COLUMNS} FROM kb_documents ORDER BY created_at DESC`),
  ]);
  const byCollection = new Map<string, KnowledgeDocumentDto[]>();
  for (const row of (documents?.results ?? []) as DocumentRow[]) {
    const list = byCollection.get(row.collection_id) ?? [];
    list.push(docDto(row));
    byCollection.set(row.collection_id, list);
  }
  return ((collections?.results ?? []) as CollectionRow[]).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    createdAt: c.created_at,
    documents: byCollection.get(c.id) ?? [],
  }));
}

export async function knowledgeUsage(db: D1Database): Promise<KnowledgeUsageDto> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(char_count), 0) AS chars, COUNT(*) AS documents FROM kb_documents")
    .first<{ chars: number; documents: number }>();
  return { chars: row?.chars ?? 0, maxChars: MAX_KNOWLEDGE_CHARS, documents: row?.documents ?? 0 };
}

async function assertNameFree(db: D1Database, name: string, exceptId?: string): Promise<void> {
  const clash = await db
    .prepare("SELECT id FROM kb_collections WHERE name = ?1 COLLATE NOCASE AND id != ?2")
    .bind(name, exceptId ?? "")
    .first();
  if (clash) throw new KnowledgeError("conflict", `There is already a folder called "${name}".`);
}

export async function createCollection(db: D1Database, input: { name: string; description: string }): Promise<KnowledgeCollectionDto> {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM kb_collections").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_COLLECTIONS) {
    throw new KnowledgeError("conflict", `You can have up to ${MAX_COLLECTIONS} folders. Delete one first.`);
  }
  await assertNameFree(db, input.name);
  const now = Date.now();
  const collection: KnowledgeCollectionDto = { id: newId(), name: input.name, description: input.description, createdAt: now, documents: [] };
  await db
    .prepare("INSERT INTO kb_collections (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(collection.id, collection.name, collection.description, now)
    .run();
  return collection;
}

export async function updateCollection(db: D1Database, id: string, patch: { name?: string; description?: string }): Promise<void> {
  const existing = await db.prepare("SELECT id FROM kb_collections WHERE id = ?1").bind(id).first();
  if (!existing) throw new KnowledgeError("not_found", "Folder not found.");
  if (patch.name !== undefined) await assertNameFree(db, patch.name, id);
  await db
    .prepare(
      "UPDATE kb_collections SET name = COALESCE(?2, name), description = COALESCE(?3, description), updated_at = ?4 WHERE id = ?1",
    )
    .bind(id, patch.name ?? null, patch.description ?? null, Date.now())
    .run();
}

/** Deletes the folder, its documents and their passages (and their search-index entries). */
export async function deleteCollection(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM kb_collections WHERE id = ?1").bind(id).run();
  return result.meta.changes > 0;
}

// ------------------------------------------------------------------ Documents

export async function getDocument(db: D1Database, id: string): Promise<KnowledgeDocumentDto | null> {
  const row = await db.prepare(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE id = ?1`).bind(id).first<DocumentRow>();
  return row ? docDto(row) : null;
}

async function assertSpace(db: D1Database, extraChars: number): Promise<void> {
  const usage = await knowledgeUsage(db);
  if (usage.chars + extraChars > usage.maxChars) {
    throw new KnowledgeError(
      "knowledge_full",
      "The knowledge base is full (free-plan space). Delete documents you no longer need to make room.",
    );
  }
}

/** Start a document: checks the folder, the per-document limits and the free space. */
export async function createDocument(
  db: D1Database,
  input: {
    collectionId: string;
    title: string;
    kind: KnowledgeDocKind;
    sourceUrl?: string | null;
    pages?: number | null;
    expectedChunks: number;
    totalChars: number;
  },
): Promise<KnowledgeDocumentDto> {
  const collection = await db.prepare("SELECT id FROM kb_collections WHERE id = ?1").bind(input.collectionId).first();
  if (!collection) throw new KnowledgeError("not_found", "Folder not found.");
  if (input.expectedChunks < 1) throw new KnowledgeError("invalid", "The document has no readable text.");
  if (input.expectedChunks > MAX_DOCUMENT_CHUNKS || input.totalChars > MAX_DOCUMENT_CHARS) {
    throw new KnowledgeError("invalid", "The document is too large (about 1,000 pages at most). Split it into smaller files.");
  }
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM kb_documents WHERE collection_id = ?1")
    .bind(input.collectionId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_DOCUMENTS_PER_COLLECTION) {
    throw new KnowledgeError("conflict", `A folder can hold up to ${MAX_DOCUMENTS_PER_COLLECTION} documents.`);
  }
  if (input.sourceUrl) {
    const dup = await db
      .prepare("SELECT id FROM kb_documents WHERE collection_id = ?1 AND source_url = ?2")
      .bind(input.collectionId, input.sourceUrl)
      .first();
    if (dup) throw new KnowledgeError("conflict", "That page is already in this folder. Delete it first to add a fresh copy.");
  }
  await assertSpace(db, input.totalChars);
  const now = Date.now();
  const row: DocumentRow = {
    id: newId(),
    collection_id: input.collectionId,
    title: input.title,
    kind: input.kind,
    source_url: input.sourceUrl ?? null,
    status: "uploading",
    pages: input.pages ?? null,
    expected_chunks: input.expectedChunks,
    chunk_count: 0,
    char_count: 0,
    created_at: now,
  };
  await db
    .prepare(
      `INSERT INTO kb_documents (${DOC_COLUMNS}, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    )
    .bind(row.id, row.collection_id, row.title, row.kind, row.source_url, row.status, row.pages, row.expected_chunks, 0, 0, now)
    .run();
  return docDto(row);
}

/**
 * Store a batch of passages. Re-sending a batch (after a network error) is harmless: passages are
 * keyed by (document, seq) and duplicates are ignored. Returns the document with updated counts.
 */
export async function addChunks(db: D1Database, documentId: string, chunks: KnowledgeChunkInput[]): Promise<KnowledgeDocumentDto> {
  const doc = await db.prepare(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE id = ?1`).bind(documentId).first<DocumentRow>();
  if (!doc) throw new KnowledgeError("not_found", "Document not found.");
  if (doc.status !== "uploading") throw new KnowledgeError("conflict", "This document is already complete.");
  if (chunks.length === 0) return docDto(doc);
  if (chunks.length > MAX_CHUNKS_PER_BATCH) throw new KnowledgeError("invalid", `Send at most ${MAX_CHUNKS_PER_BATCH} passages at a time.`);
  for (const chunk of chunks) {
    if (chunk.seq < 0 || chunk.seq >= doc.expected_chunks) throw new KnowledgeError("invalid", "Passage number out of range.");
    if (!chunk.text.trim() || chunk.text.length > CHUNK_HARD_LIMIT) throw new KnowledgeError("invalid", "Passage text is empty or too long.");
  }
  const batchChars = chunks.reduce((n, c) => n + c.text.length, 0);
  if (doc.char_count + batchChars > MAX_DOCUMENT_CHARS) throw new KnowledgeError("invalid", "The document is too large.");
  await assertSpace(db, batchChars);

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < chunks.length; i += ROWS_PER_INSERT) {
    const rows = chunks.slice(i, i + ROWS_PER_INSERT);
    const values = rows.map((_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4})`).join(", ");
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO kb_chunks (document_id, seq, location, text) VALUES ${values}`)
        .bind(...rows.flatMap((c) => [documentId, c.seq, c.location.slice(0, 120), c.text])),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE kb_documents SET
           chunk_count = (SELECT COUNT(*) FROM kb_chunks WHERE document_id = ?1),
           char_count = (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM kb_chunks WHERE document_id = ?1),
           updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(documentId, Date.now()),
  );
  await db.batch(statements);
  return (await getDocument(db, documentId))!;
}

/** Mark an upload finished; only then is the document searched. */
export async function completeDocument(db: D1Database, documentId: string): Promise<KnowledgeDocumentDto> {
  const doc = await getDocument(db, documentId);
  if (!doc) throw new KnowledgeError("not_found", "Document not found.");
  if (doc.status === "ready") return doc;
  const expected = await db.prepare("SELECT expected_chunks AS n FROM kb_documents WHERE id = ?1").bind(documentId).first<{ n: number }>();
  if (doc.chunkCount < (expected?.n ?? 0)) {
    throw new KnowledgeError("conflict", `The upload is incomplete (${doc.chunkCount} of ${expected?.n} parts). Upload the file again.`);
  }
  await db.prepare("UPDATE kb_documents SET status = 'ready', updated_at = ?2 WHERE id = ?1").bind(documentId, Date.now()).run();
  return { ...doc, status: "ready" };
}

export async function deleteDocument(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM kb_documents WHERE id = ?1").bind(id).run();
  return result.meta.changes > 0;
}

// ------------------------------------------------------------------ Search

/** True when at least one document is ready to search (the search tool is offered only then). */
export async function hasSearchableKnowledge(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS ok FROM kb_documents WHERE status = 'ready' LIMIT 1").first()) !== null;
}

/** Folders that have at least one searchable document (named in the system prompt). */
export async function searchableCollections(db: D1Database): Promise<{ name: string; description: string; documents: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.name, c.description, COUNT(d.id) AS documents
         FROM kb_collections c JOIN kb_documents d ON d.collection_id = c.id AND d.status = 'ready'
        GROUP BY c.id ORDER BY c.name COLLATE NOCASE LIMIT ?1`,
    )
    .bind(MAX_COLLECTIONS)
    .all<{ name: string; description: string; documents: number }>();
  return results;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my " +
    "no not of on or our please should so some tell than that the their them then there these they this those to " +
    "us was we were what when where which who whom why will with would you your about any all also give me show find"
  ).split(" "),
);

/**
 * Turn a question or key words into a safe FTS5 query: words joined with OR (BM25 ranks passages
 * that contain more, and rarer, of them higher). Quoting each word means no user text is ever
 * interpreted as FTS5 syntax. Returns null when there is nothing to search for.
 */
export function buildMatchQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 || /\p{N}/u.test(w));
  const keep = words.filter((w) => !STOPWORDS.has(w));
  const terms = [...new Set(keep.length > 0 ? keep : words)].slice(0, 16);
  return terms.length > 0 ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

export interface KnowledgeHit {
  chunkId: number;
  text: string;
  location: string;
  documentId: string;
  title: string;
  kind: KnowledgeDocKind;
  sourceUrl: string | null;
  collection: string;
}

/** Up to `limit` candidate passages, best keyword match first (ready documents only). */
export async function searchChunks(
  db: D1Database,
  query: string,
  options: { collection?: string; limit?: number } = {},
): Promise<KnowledgeHit[]> {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const collectionFilter = options.collection ? "AND col.name = ?3 COLLATE NOCASE" : "";
  const statement = db
    .prepare(
      `SELECT c.id AS chunkId, c.text, c.location, d.id AS documentId, d.title, d.kind, d.source_url AS sourceUrl, col.name AS collection
         FROM kb_chunks_fts
         JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid
         JOIN kb_documents d ON d.id = c.document_id AND d.status = 'ready'
         JOIN kb_collections col ON col.id = d.collection_id
        WHERE kb_chunks_fts MATCH ?1 ${collectionFilter}
        ORDER BY kb_chunks_fts.rank
        LIMIT ?2`,
    )
    .bind(...(options.collection ? [match, options.limit ?? 30, options.collection] : [match, options.limit ?? 30]));
  const { results } = await statement.all<KnowledgeHit>();
  return results;
}
