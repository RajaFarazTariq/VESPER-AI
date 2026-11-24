/**
 * Documents in chat (v0.16.0): the assistant's tools for the documents the user attached to a chat.
 *
 * - search_documents: the best passages for a question. Full-text search (FTS5, BM25) over the chat's passages finds
 *   up to 30 candidates, the knowledge base's re-ranker orders them by meaning, and the best 6 come back with their
 *   file name and page or section, so the answer can cite "(report.pdf, page 12)".
 * - read_document: a document in order (from the start, a page or a part), about 6,500 characters at a time, for
 *   summaries, overviews, "what's on page 5" and short documents. Long documents are read in parts (next_part).
 * Both only ever see the ready documents of this chat of this user (db/document-search.ts). A file can come from
 * anyone and may contain instructions, so its text is wrapped as untrusted data, like a web page.
 */
import { z } from "zod";
import { DOCUMENT_READ_CHARS, READ_DOCUMENT_TOOL, SEARCH_DOCUMENTS_TOOL } from "../../shared/documents";
import type { ChatDocumentKind, SourceDto } from "../../shared/types";
import {
  conversationDocuments,
  readDocumentPassages,
  searchDocumentChunks,
  type ChatDocumentMeta,
  type DocumentPassage,
} from "../db/document-search";
import { rerank } from "./knowledge";
import { clip, wrapUntrusted } from "./net";
import { define, ToolInputError, type AgentTool, type ToolContext } from "./types";

const CANDIDATES = 30;
const RESULTS = 6;
const PASSAGE_CHARS = 800;
/** The source chip's pop-up shows this much of the passage (SourceDto.excerpt). */
const EXCERPT_CHARS = 600;
const MAX_SOURCES = 10;
/** Neighbouring passages repeat up to ~200 characters (shared/chunking.ts); a longer repeat isn't overlap. */
const MAX_OVERLAP_CHARS = 400;
const UNTRUSTED_SOURCE = "the user's documents";
const HOW_TO_CITE = "Cite the passages you use inline as (file name, location), e.g. (report.pdf, page 12).";

const KIND_TEXT: Record<ChatDocumentKind, string> = { pdf: "a PDF", docx: "a Word document", txt: "a text file", md: "a Markdown file" };

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const span = (from: number, to: number) => (from === to ? String(from) : `${from}–${to}`);
const norm = (s: string) => s.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").toLowerCase();
/** Models sometimes send null for "not given": treat it as missing. */
const withoutNulls = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v;

/** "D1 (report.pdf)" */
const named = (d: ChatDocumentMeta) => `${d.ref} (${clip(d.name, 80)})`;

/** The chat's documents, or a message for the model when there are none. */
async function chatDocuments(ctx: ToolContext): Promise<ChatDocumentMeta[]> {
  const documents = ctx.conversationId ? await conversationDocuments(ctx.db, ctx.userId, ctx.conversationId) : [];
  if (documents.length === 0) throw new ToolInputError("No document is attached to this chat. Ask the user to attach one.");
  return documents;
}

/** The document the model means: D2 (or 2), a file name with or without its extension, or the newest when not given. */
export function pickDocument(documents: ChatDocumentMeta[], ref: string | undefined): ChatDocumentMeta {
  if (ref === undefined || ref.trim() === "") return documents[documents.length - 1]!;
  const wanted = norm(ref);
  const numbered = /^d\s*(\d+)$|^(\d+)$/.exec(wanted);
  if (numbered) {
    const d = documents[Number(numbered[1] ?? numbered[2]) - 1];
    if (d) return d;
  }
  // The same name twice (a newer copy of a file): the newest.
  const byName = documents.filter((d) => [d.name, d.name.replace(/\.[a-z0-9]{2,8}$/i, "")].map(norm).includes(wanted));
  if (byName.length > 0) return byName[byName.length - 1]!;
  throw new ToolInputError(`No document "${clip(ref, 80)}" in this chat. Use one of: ${documents.map(named).join(", ")}.`);
}

/** The start of a passage for the source chip's pop-up: spaces tidied, line breaks kept, at most 600 characters. */
export function excerptOf(text: string): string {
  const clean = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (clean.length <= EXCERPT_CHARS) return clean;
  const cut = clean.slice(0, EXCERPT_CHARS - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > EXCERPT_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One source per document and location, in the order used (at most 10), with the passage's start to show. */
function sourcesOf(passages: { documentId: string; location: string; text: string }[], byId: Map<string, ChatDocumentMeta>): SourceDto[] {
  const seen = new Set<string>();
  const out: SourceDto[] = [];
  for (const p of passages) {
    const d = byId.get(p.documentId);
    const key = `${p.documentId}|${p.location}`;
    if (!d || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: d.name, ...(p.location ? { location: p.location } : {}), kind: "document", excerpt: excerptOf(p.text) });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * The next passage without the lines it repeats from the one before (passages of the same page or section overlap
 * a little so a fact on the boundary is still found; read in order, the repeat is noise).
 */
export function withoutOverlap(previous: string, next: string): string {
  // Only the first lines that fit in MAX_OVERLAP_CHARS can be a repeat, so only those are tried (longest first). This
  // keeps the work small for passages made of very short lines (a PDF table gives one line per cell), where trying
  // every line count would take far more than the free plan's 10 ms of CPU.
  const lines = next.split("\n");
  const ends: number[] = []; // ends[k - 1]: length of the first k lines joined
  let length = -1;
  for (let k = 1; k < lines.length; k++) {
    length += lines[k - 1]!.length + 1;
    if (length > MAX_OVERLAP_CHARS) break;
    ends.push(length);
  }
  for (let k = ends.length; k > 0; k--) {
    const end = ends[k - 1]!;
    const head = next.slice(0, end);
    if (previous === head || previous.endsWith(`\n${head}`)) return next.slice(end + 1);
  }
  return next;
}

/**
 * Passages in order as one text: "[page 3]" before each new page or section, the overlap between neighbours left
 * out, until the budget would be exceeded (always at least one passage). The budget counts the text as it is sent
 * (JSON), so the result stays under the agent's 8,000-character cut.
 */
export function assemblePassages(passages: DocumentPassage[], budget = DOCUMENT_READ_CHARS): { text: string; used: DocumentPassage[] } {
  const pieces: string[] = [];
  const used: DocumentPassage[] = [];
  let size = 0;
  for (const p of passages) {
    const previous = used[used.length - 1];
    const sameUnit = previous !== undefined && previous.location === p.location && previous.seq === p.seq - 1;
    const piece = sameUnit
      ? `\n${withoutOverlap(previous.text, p.text)}`
      : `${used.length > 0 ? "\n\n" : ""}${p.location ? `[${p.location}]\n` : ""}${p.text}`;
    const cost = JSON.stringify(piece).length - 2;
    if (used.length > 0 && size + cost > budget) break;
    pieces.push(piece);
    used.push(p);
    size += cost;
  }
  return { text: pieces.join(""), used };
}

const documentRef = z.union([z.string().trim().max(200), z.number().transform(String)]).optional();
const positiveNumber = z.coerce.number().int().min(1).max(100_000).optional();

export const searchDocuments = define({
  name: SEARCH_DOCUMENTS_TOOL,
  label: "Your documents",
  description:
    "Search the documents the user attached to this chat (D1, D2… are listed in your instructions). Returns the best passages " +
    "for a question, each with its file name and page or section to cite. Use it for specific questions about the documents; " +
    "use specific key words, and try synonyms before concluding the documents don't cover it. For a summary, an overview or " +
    "what a given page says, use read_document instead.",
  risk: "read",
  requiresMemory: false,
  // Offered only in chats that have a ready document (and in the tool lists while the admin has documents on).
  isAvailable: ({ documents }) => Boolean(documents),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: 'Key words or a short question, e.g. "notice period termination"' },
      document: { type: "string", description: 'Optional: search only one document, e.g. "D2" or its file name. Leave out to search all.' },
    },
    required: ["query"],
  },
  schema: z.preprocess(withoutNulls, z.object({ query: z.string().trim().min(2).max(300), document: documentRef })),
  async run({ query, document }, ctx) {
    const documents = await chatDocuments(ctx);
    const only = document ? pickDocument(documents, document) : null;
    const candidates = await searchDocumentChunks(ctx.db, ctx.userId, ctx.conversationId!, query, {
      ...(only ? { documentId: only.id } : {}),
      limit: CANDIDATES,
    });
    if (candidates.length === 0) {
      return {
        content: JSON.stringify({
          query,
          results: [],
          note: only
            ? `Nothing found in ${named(only)}. Try other key words, search all the documents, or read it in order with ${READ_DOCUMENT_TOOL}.`
            : `Nothing found. Try other key words or synonyms, or read a document in order with ${READ_DOCUMENT_TOOL}; if still nothing, the documents probably don't cover this.`,
        }),
        summary: `Nothing found for "${clip(query, 60)}"`,
      };
    }
    const byId = new Map(documents.map((d) => [d.id, d]));
    const best = (await rerank(ctx.ai, query, candidates, RESULTS, "document")).filter((h) => byId.has(h.documentId));
    const results = best.map((h, i) => {
      const d = byId.get(h.documentId)!;
      return { ref: i + 1, document: d.name, document_ref: d.ref, ...(h.location ? { location: h.location } : {}), text: clip(h.text, PASSAGE_CHARS) };
    });
    return {
      content: wrapUntrusted(UNTRUSTED_SOURCE, { query, results, how_to_cite: HOW_TO_CITE }),
      summary: `Found ${plural(best.length, "passage")} in ${plural(new Set(best.map((h) => h.documentId)).size, "document")}`,
      sources: sourcesOf(best, byId),
      evidence: best.map((h) => h.text).join("\n\n"), // whole passages, for the number check
    };
  },
});

export const readDocument = define({
  name: READ_DOCUMENT_TOOL,
  label: "Read a document",
  description:
    "Read a document the user attached to this chat in order: from the start, from a page (PDFs) or from a part. Use it for " +
    "summaries and overviews, for what a given page or section says, and for short documents. A long document comes in parts: " +
    "the result says which parts it covers and gives next_part to read on.",
  risk: "read",
  requiresMemory: false,
  isAvailable: ({ documents }) => Boolean(documents),
  parameters: {
    type: "object",
    properties: {
      document: { type: "string", description: 'Which document, e.g. "D1" or its file name (default: the newest).' },
      page: { type: "integer", description: "PDFs: start at this page." },
      part: { type: "integer", description: "Start at this part (1 = the beginning), e.g. the next_part of an earlier read." },
    },
  },
  schema: z.preprocess(withoutNulls, z.object({ document: documentRef, page: positiveNumber, part: positiveNumber })),
  async run({ document, page, part }, ctx) {
    const documents = await chatDocuments(ctx);
    const doc = pickDocument(documents, document);
    const total = doc.chunks;
    let from: { seq: number } | { page: number } = { seq: 0 };
    if (part !== undefined) {
      if (part > total) throw new ToolInputError(`${named(doc)} has ${plural(total, "part")}, so there is no part ${part}.`);
      from = { seq: part - 1 };
    } else if (page !== undefined) {
      if (!doc.pages) {
        throw new ToolInputError(
          `${named(doc)} is ${KIND_TEXT[doc.kind]} without page numbers. Read it from the start or by part (it has ${plural(total, "part")}), or use ${SEARCH_DOCUMENTS_TOOL}.`,
        );
      }
      if (page > doc.pages) throw new ToolInputError(`${named(doc)} has ${plural(doc.pages, "page")}, so there is no page ${page}.`);
      from = { page };
    }
    const passages = await readDocumentPassages(ctx.db, ctx.userId, ctx.conversationId!, doc.id, from);
    if (passages.length === 0) {
      throw new ToolInputError("page" in from ? `There is no text on page ${from.page} or after it in ${named(doc)}.` : `${named(doc)} has no text to read.`);
    }
    const { text, used } = assemblePassages(passages);
    const first = used[0]!.seq + 1;
    const last = used[used.length - 1]!.seq + 1;
    const more = last < total;
    const pages = used.flatMap((p) => {
      const m = /^page (\d+)$/.exec(p.location);
      return m ? [Number(m[1])] : [];
    });
    const startPage = pages[0];
    const notes = [
      // A page without text (a picture, a blank page): the read starts at the next page that has some.
      ...("page" in from && startPage !== undefined && startPage > from.page ? [`Page ${from.page} has no text; this starts at page ${startPage}.`] : []),
      first === 1
        ? more
          ? `This is the start of a longer document. For a summary of all of it, say it covers these parts, or read on with next_part; for specific questions use ${SEARCH_DOCUMENTS_TOOL}.`
          : "This is the whole document."
        : more
          ? `More of the document follows: read on with next_part; for specific questions use ${SEARCH_DOCUMENTS_TOOL}.`
          : "This is the end of the document.",
    ];
    return {
      content: wrapUntrusted(UNTRUSTED_SOURCE, {
        document: doc.name,
        document_ref: doc.ref,
        total_parts: total,
        parts: span(first, last),
        ...(pages.length ? { pages: span(Math.min(...pages), Math.max(...pages)) } : {}),
        ...(doc.pages ? { total_pages: doc.pages } : {}),
        text,
        ...(more ? { next_part: last + 1 } : {}),
        note: notes.join(" "),
        how_to_cite: HOW_TO_CITE,
      }),
      summary: `Read ${named(doc)}, ${first === last ? `part ${first}` : `parts ${span(first, last)}`} of ${total}`,
      sources: sourcesOf(
        used.map((p) => ({ ...p, documentId: doc.id })),
        new Map([[doc.id, doc]]),
      ),
    };
  },
});

/** The document tools, in the order they are listed (after Table analysis). */
export const DOCUMENT_TOOLS: AgentTool[] = [searchDocuments, readDocument];
