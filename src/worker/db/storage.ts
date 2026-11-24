/**
 * The storage meter in the admin panel (v0.16.0): how full the database is, so the owner sees it coming.
 *
 * On the free plan one D1 database holds at most 500 MB, and once it is full every write fails (new messages
 * included). D1 reports the database's size with the result of every query (`meta.size_after`), so reading it costs
 * one tiny query. The three features that keep files' text each have their own cap; their use is shown next to it.
 */
import { DOCUMENT_STORAGE_CHARS } from "../../shared/documents";
import { TABLE_STORAGE_CHARS } from "../../shared/tables";
import { D1_FREE_DATABASE_BYTES, type StorageDto } from "../../shared/types";
import { chatDocumentStorageUsed } from "./documents";
import { knowledgeUsage } from "./knowledge";
import { tableStorageUsed } from "./tables";

/** The whole database's size in bytes, or null when D1 doesn't say. */
export async function databaseBytes(db: D1Database): Promise<number | null> {
  try {
    const result = await db.prepare("SELECT 1").run();
    const size = (result.meta as { size_after?: unknown }).size_after;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

export async function storageOverview(db: D1Database): Promise<StorageDto> {
  const [bytes, knowledge, tableChars, documentChars] = await Promise.all([
    databaseBytes(db),
    knowledgeUsage(db),
    tableStorageUsed(db),
    chatDocumentStorageUsed(db),
  ]);
  return {
    bytes,
    maxBytes: D1_FREE_DATABASE_BYTES,
    knowledge: { chars: knowledge.chars, maxChars: knowledge.maxChars },
    spreadsheets: { chars: tableChars, maxChars: TABLE_STORAGE_CHARS },
    documents: { chars: documentChars, maxChars: DOCUMENT_STORAGE_CHARS },
  };
}
