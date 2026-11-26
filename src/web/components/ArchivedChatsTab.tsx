import { ArchiveRestore, MessageSquare, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { matchesSearch } from "../lib/format";

const dateText = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const rowButton =
  "inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-50";

/**
 * Settings → Archived chats (v0.19.0): chats archived from the sidebar. Open one to read it (it stays archived until
 * a message is sent in it), restore it to the sidebar, or delete it for good.
 */
export function ArchivedChatsTab({
  onOpen,
  onRestored,
  onDeleted,
}: {
  onOpen: (conversation: ConversationDto) => void;
  onRestored: (conversation: ConversationDto) => void;
  onDeleted: (id: string) => void;
}) {
  const [chats, setChats] = useState<ConversationDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listArchivedConversations();
      setChats(r.conversations);
      setHasMore(r.hasMore);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load your archived chats."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    const oldest = chats?.[chats.length - 1];
    setBusy("more");
    try {
      // Archived chats come most recently archived first, so the next page starts before the oldest archive time.
      const r = await api.listArchivedConversations(oldest?.archivedAt ?? oldest?.updatedAt);
      setChats((list) => [...(list ?? []), ...r.conversations.filter((c) => !(list ?? []).some((x) => x.id === c.id))]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError(errorText(e, "Couldn't load more."));
    } finally {
      setBusy(null);
    }
  };

  /** A row went away: the focus moves to the next row (or the one before, or the search box). */
  const dropRow = (id: string, shown: ConversationDto[]) => {
    const at = shown.findIndex((c) => c.id === id);
    const next = shown[at + 1] ?? shown[at - 1];
    setChats((list) => (list ?? []).filter((c) => c.id !== id));
    requestAnimationFrame(() => {
      const el = next ? root.current?.querySelector<HTMLElement>(`[data-open="${CSS.escape(next.id)}"]`) : null;
      (el ?? searchBox.current)?.focus();
    });
  };

  const restore = async (chat: ConversationDto, shown: ConversationDto[]) => {
    setBusy(chat.id);
    setError(null);
    setNotice(null);
    try {
      const { conversation } = await api.archiveConversation(chat.id, false);
      dropRow(chat.id, shown);
      onRestored(conversation);
      setNotice(`“${chat.title}” is back in your chats.`);
    } catch (e) {
      setError(errorText(e, "Couldn't restore the chat."));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (chat: ConversationDto, shown: ConversationDto[]) => {
    if (!window.confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
    setBusy(chat.id);
    setError(null);
    setNotice(null);
    try {
      await api.deleteConversation(chat.id);
      dropRow(chat.id, shown);
      onDeleted(chat.id);
      setNotice("Chat deleted.");
    } catch (e) {
      setError(errorText(e, "Delete failed."));
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !chats) return <p className="text-sm text-[var(--danger)]">{loadError}</p>;
  if (!chats) return <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const q = query.trim();
  const shown = q ? chats.filter((c) => matchesSearch(c.title, q)) : chats;

  return (
    <div ref={root} className="space-y-3">
      <p className="text-sm text-[var(--text-soft)]">
        Archived chats are hidden from the sidebar and kept until you restore or delete them. Sending a message in one moves it back to your chats.
      </p>
      <label className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm focus-within:border-[var(--accent)]">
        <Search size={14} className="shrink-0 text-[var(--text-soft)]" aria-hidden="true" />
        <input
          ref={searchBox}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search archived chats"
          aria-label="Search archived chats"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--text-soft)]"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <p role="status" className={notice ? "text-sm text-[var(--text-soft)]" : "sr-only"}>
        {notice ?? ""}
      </p>

      {shown.length === 0 ? (
        <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">
          {q ? (hasMore ? "No loaded archived chats match. Try loading more below." : "No archived chats match your search.") : "No archived chats."}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="Archived chats">
          {shown.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={c.title}>
                  {c.title}
                </p>
                <p className="text-xs text-[var(--text-soft)]">Archived {dateText(c.archivedAt ?? c.updatedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button type="button" data-open={c.id} onClick={() => onOpen(c)} className={rowButton} aria-label={`Open ${c.title}`}>
                  <MessageSquare size={13} aria-hidden="true" /> Open
                </button>
                <button
                  type="button"
                  disabled={busy === c.id}
                  onClick={() => void restore(c, shown)}
                  className={rowButton}
                  aria-label={`Restore ${c.title}`}
                  title="Move back to your chats"
                >
                  <ArchiveRestore size={13} aria-hidden="true" /> Restore
                </button>
                <button
                  type="button"
                  disabled={busy === c.id}
                  onClick={() => void remove(c, shown)}
                  className={`${rowButton} hover:text-[var(--danger)]`}
                  aria-label={`Delete ${c.title}`}
                  title="Delete"
                >
                  <Trash2 size={13} aria-hidden="true" /> Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <button
          type="button"
          disabled={busy === "more"}
          onClick={() => void loadMore()}
          className="w-full rounded-lg px-3 py-2 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          {busy === "more" ? "Loading…" : "Load older archived chats"}
        </button>
      ) : null}
    </div>
  );
}
