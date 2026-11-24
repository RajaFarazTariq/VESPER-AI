/**
 * The message box's attachments, the parts that need nothing from the page itself (so the tests can run them too):
 * which list a picked, dropped or pasted file goes to (images, spreadsheets and documents share the paperclip
 * button), the line under a document's name, and the document limits checked before reading and before uploading.
 * Reading and uploading documents is in lib/documents.ts.
 */
import { DOCUMENT_LIMITS, documentKind } from "../../shared/documents";
import { tableKind } from "../../shared/tables";
import type { ChatDocumentKind, KnowledgeChunkInput } from "../../shared/types";

// ------------------------------------------------------------------ which list a file goes to

/** The attachment kinds switched on for the message box. */
export interface AttachKinds {
  images: boolean;
  tables: boolean;
  documents: boolean;
}

export interface RoutedFiles {
  images: File[];
  tables: File[];
  documents: File[];
  /** Files none of the switched-on kinds can take. */
  rejected: File[];
}

/**
 * Sort picked, dropped or pasted files: images first (by type, as lib/images.ts does), then spreadsheets (a .csv file
 * is always a spreadsheet, never a document), then documents. A kind that is switched off takes nothing.
 */
export function routeFiles(files: File[], on: AttachKinds): RoutedFiles {
  const out: RoutedFiles = { images: [], tables: [], documents: [], rejected: [] };
  for (const file of files) {
    if (on.images && file.type.startsWith("image/")) out.images.push(file);
    else if (on.tables && tableKind(file.name)) out.tables.push(file);
    else if (on.documents && documentKind(file.name)) out.documents.push(file);
    else out.rejected.push(file);
  }
  return out;
}

/** "a", "a or b", "a, b or c". */
export function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Why a file can't be attached, and what can be. */
export function rejectedFileMessage(file: File, on: AttachKinds): string {
  if (on.documents && /\.doc$/i.test(file.name)) {
    return `"${file.name}" can't be attached: old Word (.doc) files can't be read. Save it as .docx in Word first.`;
  }
  const kinds = [
    on.images ? "images" : "",
    on.tables ? "a spreadsheet (CSV, Excel or OpenDocument)" : "",
    on.documents ? "a document (PDF, Word, text or Markdown)" : "",
  ].filter(Boolean);
  return kinds.length ? `"${file.name}" can't be attached. Attach ${orList(kinds)}.` : `"${file.name}" can't be attached.`;
}

// ------------------------------------------------------------------ documents (v0.16.0)

const KIND_LABELS: Record<ChatDocumentKind, string> = { pdf: "PDF", docx: "Word document", txt: "Text", md: "Markdown" };

/** The line under a document's name: "PDF · 12 pages", "Word document", "Text", "Markdown". */
export function documentSubtitle(doc: { kind: ChatDocumentKind; pages?: number | null }): string {
  if (doc.kind === "pdf" && doc.pages) return `PDF · ${doc.pages.toLocaleString()} page${doc.pages === 1 ? "" : "s"}`;
  return KIND_LABELS[doc.kind] ?? "Document";
}

// The same wording as the server, which checks these limits again.
export const DOCUMENT_TOO_LARGE = "The document is too large (about 300 pages at most). Split it into smaller files.";
export const DOCUMENT_NO_TEXT = "This file has no readable text (a scanned PDF needs to be converted to text first).";
const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** A problem found before reading the file (its type, an empty file, its size), or null. */
export function documentProblem(file: File): string | null {
  if (!documentKind(file.name)) return "This file can't be attached as a document. Use PDF, Word (.docx), text (.txt) or Markdown (.md).";
  if (file.size === 0) return "The file is empty.";
  if (file.size > DOCUMENT_LIMITS.fileBytes) return `The file is larger than ${megabytes(DOCUMENT_LIMITS.fileBytes)} MB. Split it into smaller files.`;
  return null;
}

/** A problem with the passages that would be uploaded (no text, too much of it), or null. */
export function passagesProblem(chunks: KnowledgeChunkInput[]): string | null {
  if (chunks.length === 0) return DOCUMENT_NO_TEXT;
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  if (chars > DOCUMENT_LIMITS.chars || chunks.length > DOCUMENT_LIMITS.chunks) return DOCUMENT_TOO_LARGE;
  return null;
}

/** Passages in request-sized batches: at most 50 each (the server's limit) and about 100,000 characters. */
export function documentBatches(chunks: KnowledgeChunkInput[], maxChars = 100_000): KnowledgeChunkInput[][] {
  const out: KnowledgeChunkInput[][] = [];
  let current: KnowledgeChunkInput[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && (current.length >= DOCUMENT_LIMITS.chunksPerBatch || size + chunk.text.length > maxChars)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(chunk);
    size += chunk.text.length;
  }
  if (current.length) out.push(current);
  return out;
}
