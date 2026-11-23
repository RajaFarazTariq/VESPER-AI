/**
 * Adding a spreadsheet to a message (v0.14.0): read it in a background worker, then upload the rows in blocks
 * (three at a time, each retried on a network error), then mark it ready. Removing it before sending deletes it.
 */
import type { MessageFileDto, TableFileDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { TableReadError, type ReadFile } from "./table-read";

/** A spreadsheet waiting in the message box. */
export interface PendingTable {
  /** Local id (the server's id is `fileId`, once uploading has started). */
  id: string;
  name: string;
  status: "reading" | "uploading" | "ready";
  /** Upload progress, 0 to 1. */
  progress: number;
  fileId?: string;
  rows?: number;
  sheets?: number;
}

/** What the message carries once the file is ready. */
export const messageFile = (t: PendingTable): MessageFileDto => ({ id: t.fileId!, name: t.name, sheets: t.sheets ?? 1, rows: t.rows ?? 0 });

/** Dates like 03/04/2026 are read month-first only for US English browsers. */
const preferMdy = () => /^en-us\b/i.test(globalThis.navigator?.language ?? "");

class Aborted extends Error {}

/** Read in the page itself (when a background worker can't be started). */
async function readHere(file: File, onProgress: (message: string) => void): Promise<ReadFile> {
  const { readTableFile } = await import("./table-file");
  return readTableFile(file, { preferMdy: preferMdy() }, onProgress);
}

/** Read the file in a background worker. Throws TableReadError with a message for the user. */
export function readInBackground(file: File, onProgress: (message: string) => void, signal: AbortSignal): Promise<ReadFile> {
  return new Promise<ReadFile>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./table-reader.worker.ts", import.meta.url), { type: "module" });
    } catch {
      readHere(file, onProgress).then(resolve, reject);
      return;
    }
    let heard = false;
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new Aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<{ type: string; message?: string; result?: ReadFile }>) => {
      heard = true;
      const data = event.data;
      if (data.type === "progress") {
        onProgress(data.message ?? "");
        return;
      }
      finish();
      if (data.type === "done" && data.result) resolve(data.result);
      else reject(new TableReadError(data.message || "That spreadsheet couldn't be read."));
    });
    worker.addEventListener("error", () => {
      finish();
      // The worker didn't start at all (old browser or a blocked script): read in the page instead.
      if (!heard) readHere(file, onProgress).then(resolve, reject);
      else reject(new TableReadError("That spreadsheet couldn't be read."));
    });
    worker.postMessage({ file, preferMdy: preferMdy() });
  });
}

/** Send again after a network or server hiccup (blocks are stored once, so repeating is safe). */
async function withRetry<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (signal.aborted) throw new Aborted();
      const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500) && error.status !== 507;
      if (!transient || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

/** Upload a read file: its overview, then its rows, then "ready". On failure nothing is left behind. */
export async function uploadTables(read: ReadFile, onStarted: (fileId: string) => void, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<TableFileDto> {
  const { file } = await api.files.create(
    { name: read.name, kind: read.kind, bytes: read.bytes, tables: read.tables.map(({ blocks, ...table }) => ({ ...table, chunks: blocks.length })) },
    signal,
  );
  onStarted(file.id);
  try {
    const jobs = read.tables.flatMap((table, i) => table.blocks.map((rows, seq) => ({ table: file.tables[i]!.id, seq, rows })));
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < jobs.length) {
        if (signal.aborted) throw new Aborted();
        const job = jobs[next++]!;
        await withRetry(() => api.files.addChunks(file.id, job.table, [{ seq: job.seq, rows: job.rows }], signal), signal);
        onProgress(++done / jobs.length);
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    return (await withRetry(() => api.files.complete(file.id, signal), signal)).file;
  } catch (error) {
    void api.files.remove(file.id).catch(() => {});
    throw error;
  }
}

/** The plain message for a failed read or upload (nothing for a cancelled one). */
export function tableErrorMessage(error: unknown): string | null {
  if (error instanceof Aborted) return null;
  if (error instanceof TableReadError || error instanceof ApiError) return error.message;
  return "That spreadsheet couldn't be added. Please try again.";
}
