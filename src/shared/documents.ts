/**
 * Documents in chat (v0.16.0): limits and file types shared by the browser and the server.
 *
 * The browser reads the file (the free server has too little computing time per request to parse a PDF) with the same
 * reader as the knowledge base (web/lib/extract.ts), splits the text into passages (shared/chunking.ts) and uploads
 * only the passages. The server stores them per chat with a full-text index; the assistant finds the right passages
 * for each question (search_documents) or reads a document in order (read_document), and cites "file, page X".
 */
import type { AppSettingsDto, ChatDocumentKind } from "./types";

/** The assistant's tools for documents in chat: find passages for a question, and read a document in order. */
export const SEARCH_DOCUMENTS_TOOL = "search_documents";
export const READ_DOCUMENT_TOOL = "read_document";

/** Documents are on: the admin's switch, and the document search isn't switched off for everyone. */
export const documentsAllowed = (settings: Pick<AppSettingsDto, "documentsEnabled" | "disabledTools">) =>
  settings.documentsEnabled && !settings.disabledTools.includes(SEARCH_DOCUMENTS_TOOL);

export const DOCUMENT_LIMITS = {
  /** Size of the original file (it is read in the browser and never uploaded). */
  fileBytes: 20 * 1024 * 1024,
  /** PDF pages in one file. */
  pages: 300,
  /** Characters of text in one file (about 300 pages). */
  chars: 1_000_000,
  /** Passages in one file (about 1,200 characters each, with a little overlap). */
  chunks: 1_500,
  /** Passages per upload request (keeps each request small, well under D1's per-request limits). */
  chunksPerBatch: 50,
  /** Documents in one chat. */
  perChat: 5,
  /** Documents attached to one message. */
  perMessage: 3,
  /** Documents one user keeps (in all chats, plus ones added but not sent yet). Deleting a chat frees its documents. */
  stored: 30,
  /** Text one user keeps in all their documents (about 1,500 pages), so one person can't fill the space for everyone. */
  userChars: 5_000_000,
} as const;

/**
 * Stored text of all users' chat documents together (characters). With the full-text index that is roughly 2–3 times
 * as many bytes, so this keeps chat documents to about 100–120 MB of the free D1 database (500 MB per database).
 */
export const DOCUMENT_STORAGE_CHARS = 40_000_000;

/** A document this short is given to the assistant whole by read_document (one tool result holds at most 8,000). */
export const DOCUMENT_READ_CHARS = 6_500;

const EXTENSIONS: Record<string, ChatDocumentKind> = { pdf: "pdf", docx: "docx", txt: "txt", md: "md", markdown: "md" };
export const CHAT_DOCUMENT_KINDS: readonly ChatDocumentKind[] = ["pdf", "docx", "txt", "md"];

/** The document kind from a file name, or null when it isn't one VESPER reads in chat (spreadsheets go elsewhere). */
export function documentKind(fileName: string): ChatDocumentKind | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

/** For the file picker: document extensions and their usual types. */
export const DOCUMENT_ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
