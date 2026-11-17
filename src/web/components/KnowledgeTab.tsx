/**
 * Admin panel → Knowledge: folders of documents that VESPER answers from (with citations).
 * Files are read in this browser (lib/extract.ts), split into passages (shared/chunking.ts) and sent
 * in small batches; only their text is stored. Web pages are read by the server.
 */
import { FileText, FolderPlus, Globe, Library, Loader2, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chunkUnits } from "../../shared/chunking";
import type { KnowledgeChunkInput, KnowledgeCollectionDto, KnowledgeDocumentDto, KnowledgeUsageDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { ACCEPTED_FILES, ExtractError, extractFile } from "../lib/extract";

type Notice = (message: string, kind?: "error" | "info") => void;

/** Roughly how much text a printed page holds; used only to explain sizes in pages. */
const CHARS_PER_PAGE = 3_000;
const BATCH_CHUNKS = 50;
const BATCH_CHARS = 100_000;

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof ExtractError ? e.message : fallback);
const pagesOf = (chars: number) => Math.max(1, Math.round(chars / CHARS_PER_PAGE));
const KIND_LABEL: Record<KnowledgeDocumentDto["kind"], string> = { pdf: "PDF", docx: "Word", txt: "Text", md: "Markdown", csv: "CSV", web: "Web page" };

interface UploadItem {
  id: number;
  collectionId: string;
  name: string;
  state: "working" | "done" | "error";
  message: string;
}

/** Passages in request-sized batches (count and size). */
function batches(chunks: KnowledgeChunkInput[]): KnowledgeChunkInput[][] {
  const out: KnowledgeChunkInput[][] = [];
  let current: KnowledgeChunkInput[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && (current.length >= BATCH_CHUNKS || size + chunk.text.length > BATCH_CHARS)) {
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

/** Retry once after a network or server hiccup (passages are keyed, so re-sending is safe). */
async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1_500));
      return work();
    }
    throw error;
  }
}

async function uploadFile(collectionId: string, file: File, progress: (message: string) => void): Promise<KnowledgeDocumentDto> {
  const extracted = await extractFile(file, progress);
  const chunks = chunkUnits(extracted.units);
  if (chunks.length === 0) throw new ExtractError("No readable text was found in this file.");
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  const { document } = await api.admin.knowledge.createDocument({
    collectionId,
    title: file.name.slice(0, 200),
    kind: extracted.kind,
    pages: extracted.pages,
    expectedChunks: chunks.length,
    totalChars,
  });
  try {
    let sent = 0;
    for (const batch of batches(chunks)) {
      progress(`Saving… ${Math.round((sent / chunks.length) * 100)}%`);
      await withRetry(() => api.admin.knowledge.addChunks(document.id, batch));
      sent += batch.length;
    }
    return (await withRetry(() => api.admin.knowledge.completeDocument(document.id))).document;
  } catch (error) {
    await api.admin.knowledge.deleteDocument(document.id).catch(() => {}); // no half-saved documents
    throw error;
  }
}

export function KnowledgeTab({ onNotice }: { onNotice: Notice }) {
  const [collections, setCollections] = useState<KnowledgeCollectionDto[] | null>(null);
  const [usage, setUsage] = useState<KnowledgeUsageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const nextUpload = useRef(1);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.admin.knowledge.list();
      setCollections(data.collections);
      setUsage(data.usage);
    } catch (e) {
      setCollections([]);
      setError(errorText(e, "Could not load the knowledge base."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateUpload = (id: number, patch: Partial<UploadItem>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  /** Files are processed one after another; each shows its own progress line. */
  const addFiles = async (collectionId: string, files: File[]) => {
    const queued = files.map((file) => ({ file, id: nextUpload.current++ }));
    setUploads((list) => [
      ...list.filter((u) => u.state === "working"),
      ...queued.map(({ file, id }) => ({ id, collectionId, name: file.name, state: "working" as const, message: "Waiting…" })),
    ]);
    for (const { file, id } of queued) {
      try {
        const doc = await uploadFile(collectionId, file, (message) => updateUpload(id, { message }));
        const pages = doc.pages ?? pagesOf(doc.charCount);
        updateUpload(id, { state: "done", message: `Added (${doc.pages ? "" : "about "}${pages} page${pages === 1 ? "" : "s"}${doc.pages ? "" : " of text"})` });
      } catch (e) {
        updateUpload(id, { state: "error", message: errorText(e, "Upload failed. Please try again.") });
      }
      await load();
    }
  };

  const percent = usage ? Math.min(100, (usage.chars / usage.maxChars) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Library size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <p className="text-sm text-[var(--text-soft)]">
              Add documents for <span className="font-medium text-[var(--text)]">everyone</span> to get answers from. VESPER cites the document and page. Files are read in
              your browser and only their text is stored, so keep your own copies.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)]"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {usage ? (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-[var(--text-soft)]">
              <span>
                Space used: {percent < 1 && usage.chars > 0 ? "under 1" : Math.round(percent)}% (about {pagesOf(usage.chars).toLocaleString()} of{" "}
                {Math.round(usage.maxChars / CHARS_PER_PAGE).toLocaleString()} pages)
              </span>
              <span>
                {usage.documents} document{usage.documents === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Knowledge space used">
              <div className={`h-full rounded-full ${percent > 90 ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`} style={{ width: `${Math.max(percent, usage.chars > 0 ? 1 : 0)}%` }} />
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

      {creating ? (
        <FolderForm
          submitLabel="Create folder"
          onCancel={() => setCreating(false)}
          onSubmit={async (values) => {
            await api.admin.knowledge.createCollection(values);
            setCreating(false);
            await load();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-text)]"
        >
          <FolderPlus size={15} /> New folder
        </button>
      )}

      {collections === null ? <p className="text-sm text-[var(--text-soft)]">Loading…</p> : null}
      {collections?.length === 0 && !creating ? (
        <p className="text-sm text-[var(--text-soft)]">No folders yet. Create one (for example "Company policies"), then upload files into it.</p>
      ) : null}

      <ul className="space-y-3">
        {(collections ?? []).map((c) => (
          <CollectionCard
            key={c.id}
            collection={c}
            uploads={uploads.filter((u) => u.collectionId === c.id)}
            onFiles={(files) => void addFiles(c.id, files)}
            onChanged={load}
            onNotice={onNotice}
          />
        ))}
      </ul>
    </div>
  );
}

function FolderForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: { name: string; description: string };
  submitLabel: string;
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2 rounded-xl border border-[var(--border)] p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ name: name.trim(), description: description.trim() });
        } catch (err) {
          setError(errorText(err, "Couldn't save the folder."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder="Folder name, e.g. Company policies"
        aria-label="Folder name"
        autoFocus
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder="What's in it (optional). Helps VESPER know when to look here, e.g. HR policies: leave, salaries, working hours."
        aria-label="Folder description"
        className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
      />
      {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)]">
          Cancel
        </button>
      </div>
    </form>
  );
}

function CollectionCard({
  collection,
  uploads,
  onFiles,
  onChanged,
  onNotice,
}: {
  collection: KnowledgeCollectionDto;
  uploads: UploadItem[];
  onFiles: (files: File[]) => void;
  onChanged: () => Promise<void>;
  onNotice: Notice;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [webBusy, setWebBusy] = useState(false);
  const busy = uploads.some((u) => u.state === "working");

  const addWeb = async () => {
    setWebBusy(true);
    try {
      const { document } = await api.admin.knowledge.addWebPage(collection.id, url.trim());
      onNotice(`Added "${document.title}".`, "info");
      setUrl("");
      setWebOpen(false);
      await onChanged();
    } catch (e) {
      onNotice(errorText(e, "Couldn't add that page."), "error");
    } finally {
      setWebBusy(false);
    }
  };

  const small = "inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-40";

  return (
    <li className="rounded-xl border border-[var(--border)] p-3">
      {editing ? (
        <FolderForm
          initial={{ name: collection.name, description: collection.description }}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await api.admin.knowledge.updateCollection(collection.id, values);
            setEditing(false);
            await onChanged();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">{collection.name}</p>
            {collection.description ? <p className="mt-0.5 text-xs text-[var(--text-soft)]">{collection.description}</p> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={small} disabled={busy} onClick={() => fileInput.current?.click()}>
              <Upload size={12} /> Upload files
            </button>
            <button type="button" className={small} onClick={() => setWebOpen((o) => !o)}>
              <Globe size={12} /> Add web page
            </button>
            <button type="button" className={small} onClick={() => setEditing(true)} aria-label={`Edit folder ${collection.name}`}>
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className={`${small} text-[var(--danger)]`}
              disabled={busy}
              aria-label={`Delete folder ${collection.name}`}
              onClick={async () => {
                const n = collection.documents.length;
                if (!window.confirm(`Delete the folder "${collection.name}"${n ? ` and its ${n} document${n === 1 ? "" : "s"}` : ""}? This cannot be undone.`)) return;
                try {
                  await api.admin.knowledge.deleteCollection(collection.id);
                  await onChanged();
                } catch (e) {
                  onNotice(errorText(e, "Couldn't delete the folder."), "error");
                }
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />

      {webOpen ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void addWeb();
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            placeholder="https://example.com/page"
            aria-label="Web page address"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={webBusy || !url.trim()}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
          >
            {webBusy ? "Reading…" : "Add"}
          </button>
        </form>
      ) : null}

      {uploads.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-2 text-xs">
              {u.state === "working" ? <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent)]" /> : null}
              <span className="min-w-0 truncate font-medium">{u.name}</span>
              <span className={`shrink-0 ${u.state === "error" ? "text-[var(--danger)]" : "text-[var(--text-soft)]"}`}>{u.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {collection.documents.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--text-soft)]">No documents yet. Upload PDF, Word (.docx), text, Markdown or CSV files, or add a web page.</p>
      ) : (
        <ul className="mt-3 max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] thin-scroll">
          {collection.documents.map((d) => (
            <DocumentRow key={d.id} doc={d} onChanged={onChanged} onNotice={onNotice} />
          ))}
        </ul>
      )}
    </li>
  );
}

function DocumentRow({ doc, onChanged, onNotice }: { doc: KnowledgeDocumentDto; onChanged: () => Promise<void>; onNotice: Notice }) {
  const Icon = doc.kind === "web" ? Globe : FileText;
  const size = doc.pages ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}` : `about ${pagesOf(doc.charCount)} page${pagesOf(doc.charCount) === 1 ? "" : "s"} of text`;
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <Icon size={14} className="shrink-0 text-[var(--text-soft)]" />
      <div className="min-w-0 flex-1">
        {doc.sourceUrl ? (
          <a href={doc.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="block truncate hover:underline" title={doc.sourceUrl}>
            {doc.title}
          </a>
        ) : (
          <p className="truncate" title={doc.title}>
            {doc.title}
          </p>
        )}
        <p className="text-xs text-[var(--text-soft)]">
          {KIND_LABEL[doc.kind]} · {size} · added {new Date(doc.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
          {doc.status !== "ready" ? <span className="text-[var(--danger)]"> · incomplete upload, delete and try again</span> : null}
        </p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-md p-1.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
        aria-label={`Delete ${doc.title}`}
        onClick={async () => {
          if (!window.confirm(`Delete "${doc.title}" from the knowledge base?`)) return;
          try {
            await api.admin.knowledge.deleteDocument(doc.id);
            await onChanged();
          } catch (e) {
            onNotice(errorText(e, "Couldn't delete the document."), "error");
          }
        }}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}
