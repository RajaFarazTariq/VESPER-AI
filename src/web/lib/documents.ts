/**
 * Adding a document to a message (v0.16.0): a PDF, Word, text or Markdown file. It is read here in the browser with
 * the knowledge base's reader (lib/extract.ts) and split into passages (shared/chunking.ts); only the passages are
 * uploaded, in batches (three at a time, each retried on a network error), then the document is marked ready.
 * Removing it before sending deletes it. The limits and wording are in lib/attachments.ts.
 */
import { chunkUnits } from "../../shared/chunking";
import { DOCUMENT_LIMITS, documentKind } from "../../shared/documents";
import type { ChatDocumentDto, ChatDocumentKind, KnowledgeChunkInput, MessageDocumentDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { DOCUMENT_NO_TEXT, DOCUMENT_TOO_LARGE, documentBatches, documentProblem, passagesProblem } from "./attachments";
import { ExtractError, extractFile } from "./extract";
import { Aborted, withRetry } from "./tables";

/** A document waiting in the message box. */
export interface PendingDocument {
  /** Local id (the server's id is `documentId`, once uploading has started). */
  id: string;
  name: string;
  kind: ChatDocumentKind;
  status: "reading" | "uploading" | "ready";
  /** Upload progress, 0 to 1. */
  progress: number;
  /** While reading: what is happening, e.g. "Reading page 12 of 40…". */
  note?: string | undefined;
  documentId?: string;
  /** PDFs only. */
  pages?: number | null;
  /** Characters of text read from it (known once it's ready). */
  chars?: number;
}

/** What the message carries once the document is ready. */
export const messageDocument = (d: PendingDocument): MessageDocumentDto => ({
  id: d.documentId!,
  name: d.name,
  kind: d.kind,
  pages: d.pages ?? null,
  chars: d.chars ?? 0,
});

/** A read document, ready to upload. */
export interface ReadDocument {
  name: string;
  kind: ChatDocumentKind;
  bytes: number;
  pages: number | null;
  chunks: KnowledgeChunkInput[];
  /** Characters in all passages (what the server counts). */
  chars: number;
}

/** Read the file and split it into passages. Throws ExtractError with a message for the user. */
export async function readDocument(file: File, onProgress: (note: string) => void, signal: AbortSignal): Promise<ReadDocument> {
  const problem = documentProblem(file);
  if (problem) throw new ExtractError(problem);
  const kind = documentKind(file.name)!;
  let extracted: Awaited<ReturnType<typeof extractFile>>;
  try {
    // Stricter than the knowledge base: a file over the limits stops at once, not after every page is read.
    extracted = await extractFile(file, onProgress, {
      maxBytes: DOCUMENT_LIMITS.fileBytes,
      maxPages: DOCUMENT_LIMITS.pages,
      tooManyPages: (pages, max) => `This PDF has ${pages.toLocaleString()} pages; up to ${max} can be attached. Split it into smaller files.`,
      maxChars: DOCUMENT_LIMITS.chars,
      tooMuchText: DOCUMENT_TOO_LARGE,
      noText: DOCUMENT_NO_TEXT,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Aborted();
    throw error;
  }
  if (signal.aborted) throw new Aborted();
  const chunks = chunkUnits(extracted.units);
  const tooBig = passagesProblem(chunks);
  if (tooBig) throw new ExtractError(tooBig);
  return { name: file.name, kind, bytes: file.size, pages: extracted.pages, chunks, chars: chunks.reduce((n, c) => n + c.text.length, 0) };
}

/** Upload a read document: its details, then its passages, then "ready". On failure nothing is left behind. */
export async function uploadDocument(
  read: ReadDocument,
  onStarted: (documentId: string) => void,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<ChatDocumentDto> {
  // Not cancelled half-way: a cancelled request could still add the document on the server, and then nothing here
  // would know to delete it. A removal during this request is handled right after it.
  const { document } = await api.documents.create({
    name: read.name.slice(0, 200),
    kind: read.kind,
    bytes: read.bytes,
    pages: read.pages,
    expectedChunks: read.chunks.length,
    totalChars: read.chars,
  });
  let failed = false;
  try {
    if (signal.aborted) throw new Aborted();
    onStarted(document.id);
    const jobs = documentBatches(read.chunks);
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < jobs.length && !failed) {
        if (signal.aborted) throw new Aborted();
        const batch = jobs[next++]!;
        await withRetry(() => api.documents.addChunks(document.id, batch, signal), signal);
        done += batch.length;
        onProgress(done / read.chunks.length);
      }
    };
    // One failed batch stops the others (the document is deleted anyway).
    const guarded = () =>
      lane().catch((error: unknown) => {
        failed = true;
        throw error;
      });
    await Promise.all([guarded(), guarded(), guarded()]);
    return (await withRetry(() => api.documents.complete(document.id, signal), signal)).document;
  } catch (error) {
    void api.documents.remove(document.id).catch(() => {});
    throw error;
  }
}

/** The plain message for a failed read or upload (nothing for a cancelled one). */
export function documentErrorMessage(error: unknown): string | null {
  if (error instanceof Aborted || (error instanceof DOMException && error.name === "AbortError")) return null;
  if (error instanceof ExtractError || error instanceof ApiError) return error.message;
  return "That document couldn't be added. Please try again.";
}
