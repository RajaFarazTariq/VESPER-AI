import { Check, ListTodo, Pencil, Search, StickyNote, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListDto, ListItemDto, NoteDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { listCounts, matchesSearch } from "../lib/format";

/** The server's limits (it checks them again). */
const LIST_NAME_MAX = 40;
const NOTE_MAX = 2000;
/** GET /api/lists returns at most this many notes (the newest). */
const NOTES_SHOWN = 200;

const iconButton = "shrink-0 rounded p-1 text-[var(--text-soft)] hover:text-[var(--text)] disabled:opacity-40";
const deleteButton = "shrink-0 rounded p-1 text-[var(--text-soft)] hover:text-[var(--danger)] disabled:opacity-40";
const input = "min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm";
const dateText = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Settings → Lists & notes (v0.19.0): the lists ("To-do", "Shopping"…) and notes VESPER keeps when asked in a chat or
 * in VESPER Agent. Here they can be checked off, renamed, edited and deleted; changes save at once.
 */
export function ListsNotesTab() {
  const [lists, setLists] = useState<ListDto[] | null>(null);
  const [notes, setNotes] = useState<NoteDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The last action's problem, shown in the list or note it is about (`where`), or at the top. */
  const [error, setError] = useState<{ text: string; where: string | null } | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  /** The latest request per list: an answer to an earlier one (arriving late) doesn't undo a newer change. */
  const latest = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    try {
      const data = await api.lists.get();
      setLists(data.lists);
      setNotes(data.notes);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load your lists and notes."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** After something is removed, the focus goes to the first match (e.g. the next item), else to `fallback`. */
  const focusSoon = (selectors: string[]) =>
    requestAnimationFrame(() => {
      for (const selector of selectors) {
        const el = selector ? root.current?.querySelector<HTMLElement>(selector) : null;
        if (el) return el.focus();
      }
    });
  const fail = (e: unknown, fallback: string, where: string | null) => setError({ text: errorText(e, fallback), where });
  const errorAt = (where: string) => (error?.where === where ? error.text : null);
  /** Editing stopped (saved or cancelled): that place's problem goes. */
  const clearAt = (where: string) => setError((e) => (e?.where === where ? null : e));
  const putList = (list: ListDto) => setLists((all) => (all ?? []).map((l) => (l.id === list.id ? list : l)));
  /** Sends a change to a list; its answer (the list as it now is) is used only if no newer change was sent since. */
  const changeList = async (listId: string, request: () => Promise<{ list: ListDto }>) => {
    const n = (latest.current.get(listId) ?? 0) + 1;
    latest.current.set(listId, n);
    const { list } = await request();
    if (latest.current.get(listId) === n) putList(list);
  };
  const patchItem = (listId: string, itemId: string, patch: Partial<ListItemDto>) =>
    setLists((all) => (all ?? []).map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) } : l)));

  const toggle = async (list: ListDto, item: ListItemDto) => {
    setError(null);
    patchItem(list.id, item.id, { done: !item.done });
    try {
      await changeList(list.id, () => api.lists.updateItem(list.id, item.id, { done: !item.done }));
    } catch (e) {
      patchItem(list.id, item.id, { done: item.done });
      fail(e, "Couldn't save that. Please try again.", `list:${list.id}`);
    }
  };

  const removeItem = async (list: ListDto, item: ListItemDto) => {
    setError(null);
    const at = list.items.findIndex((i) => i.id === item.id);
    const next = list.items[at + 1] ?? list.items[at - 1];
    setLists((all) => (all ?? []).map((l) => (l.id === list.id ? { ...l, items: l.items.filter((i) => i.id !== item.id) } : l)));
    focusSoon([next ? `[data-item="${CSS.escape(next.id)}"]` : "", `[data-list-heading="${CSS.escape(list.id)}"]`]);
    try {
      await changeList(list.id, () => api.lists.removeItem(list.id, item.id));
    } catch (e) {
      fail(e, "Couldn't remove that item.", `list:${list.id}`);
      void load();
    }
  };

  const renameList = async (list: ListDto, name: string) => {
    setError(null);
    try {
      await changeList(list.id, () => api.lists.rename(list.id, name));
      return true;
    } catch (e) {
      fail(e, "Couldn't rename the list.", `list:${list.id}`);
      return false;
    }
  };

  const removeList = async (list: ListDto) => {
    const count = list.items.length;
    const what = count ? ` and its ${count} item${count === 1 ? "" : "s"}` : "";
    if (!window.confirm(`Delete the list "${list.name}"${what}? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.lists.remove(list.id);
      const all = lists ?? [];
      const at = all.findIndex((l) => l.id === list.id);
      const next = all[at + 1] ?? all[at - 1];
      setLists(all.filter((l) => l.id !== list.id));
      focusSoon([next ? `[data-list-heading="${CSS.escape(next.id)}"]` : "", "#lists-heading"]);
    } catch (e) {
      fail(e, "Couldn't delete the list.", `list:${list.id}`);
    }
  };

  const saveNote = async (note: NoteDto, text: string) => {
    setError(null);
    try {
      const { note: saved } = await api.notes.update(note.id, text);
      setNotes((all) => (all ?? []).map((n) => (n.id === saved.id ? saved : n)));
      return true;
    } catch (e) {
      fail(e, "Couldn't save the note.", `note:${note.id}`);
      return false;
    }
  };

  const removeNote = async (note: NoteDto, shown: NoteDto[]) => {
    setError(null);
    try {
      await api.notes.remove(note.id);
      const at = shown.findIndex((n) => n.id === note.id);
      const next = shown[at + 1] ?? shown[at - 1];
      setNotes((all) => (all ?? []).filter((n) => n.id !== note.id));
      focusSoon([next ? `[data-note="${CSS.escape(next.id)}"]` : "", "#notes-heading"]);
    } catch (e) {
      fail(e, "Couldn't delete the note.", `note:${note.id}`);
    }
  };

  if (loadError && !lists) return <p className="text-sm text-[var(--danger)]">{loadError}</p>;
  if (!lists || !notes) return <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const shownNotes = query.trim() ? notes.filter((n) => matchesSearch(n.text, query)) : notes;

  return (
    <div ref={root} className="space-y-6">
      <p className="text-sm text-[var(--text-soft)]">
        VESPER keeps these when you ask in a chat or in VESPER Agent, for example “Add milk and eggs to my shopping list” or “Note that the gate code
        is on the green card”. Check things off and tidy up here; changes save at once.
      </p>
      {/* Announced here; shown in the list or note it is about when there is one. */}
      {error ? (
        <p role="alert" className={error.where ? "sr-only" : "text-sm text-[var(--danger)]"}>
          {error.text}
        </p>
      ) : null}

      <section aria-labelledby="lists-heading">
        <h3 id="lists-heading" tabIndex={-1} className="mb-2 flex items-center gap-2 text-sm font-medium outline-none">
          <ListTodo size={15} className="text-[var(--accent)]" aria-hidden="true" /> Lists {lists.length ? `(${lists.length})` : ""}
        </h3>
        {lists.length === 0 ? (
          <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">
            No lists yet. Try telling VESPER: “Add call Ali to my to-do list.”
          </p>
        ) : (
          <div className="space-y-3">
            {lists.map((list) => (
              <ListCard
                key={list.id}
                list={list}
                error={errorAt(`list:${list.id}`)}
                onEditingDone={() => clearAt(`list:${list.id}`)}
                onToggle={(item) => void toggle(list, item)}
                onRemoveItem={(item) => void removeItem(list, item)}
                onRename={(name) => renameList(list, name)}
                onDelete={() => void removeList(list)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="notes-heading">
        <h3 id="notes-heading" tabIndex={-1} className="mb-2 flex items-center gap-2 text-sm font-medium outline-none">
          <StickyNote size={15} className="text-[var(--accent)]" aria-hidden="true" /> Notes {notes.length ? `(${notes.length})` : ""}
        </h3>
        {notes.length === 0 ? (
          <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">
            No notes yet. Try: “Note that the spare key is with Sara.” Passwords, card or bank numbers, ID card numbers and phone numbers are never
            saved.
          </p>
        ) : (
          <>
            <label className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm focus-within:border-[var(--accent)]">
              <Search size={14} className="shrink-0 text-[var(--text-soft)]" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder="Search notes"
                aria-label="Search notes"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--text-soft)]"
              />
            </label>
            {shownNotes.length === 0 ? (
              <p className="px-1 py-2 text-sm text-[var(--text-soft)]">No notes match your search.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                {shownNotes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    error={errorAt(`note:${note.id}`)}
                    onEditingDone={() => clearAt(`note:${note.id}`)}
                    onSave={(text) => saveNote(note, text)}
                    onDelete={() => void removeNote(note, shownNotes)}
                  />
                ))}
              </ul>
            )}
            {notes.length >= NOTES_SHOWN ? <p className="mt-1.5 text-xs text-[var(--text-soft)]">Showing your {NOTES_SHOWN} newest notes.</p> : null}
          </>
        )}
      </section>
    </div>
  );
}

/** One list: its name (rename, delete) and its items (tick off, remove). */
function ListCard({
  list,
  error,
  onEditingDone,
  onToggle,
  onRemoveItem,
  onRename,
  onDelete,
}: {
  list: ListDto;
  /** The last change to this list that didn't work. */
  error: string | null;
  onEditingDone: () => void;
  onToggle: (item: ListItemDto) => void;
  onRemoveItem: (item: ListItemDto) => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const stopEditing = () => {
    setEditing(false);
    setName(list.name);
    onEditingDone();
    requestAnimationFrame(() => heading.current?.focus());
  };

  return (
    <div className="rounded-xl border border-[var(--border)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const next = name.trim();
              if (!next || next === list.name) return stopEditing();
              setBusy(true);
              const ok = await onRename(next);
              setBusy(false);
              if (ok) stopEditing();
            }}
          >
            <input
              value={name}
              maxLength={LIST_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  stopEditing();
                }
              }}
              aria-label="List name"
              autoFocus
              className={input}
            />
            <button type="submit" disabled={busy || !name.trim()} className={iconButton} aria-label="Save list name" title="Save">
              <Check size={15} />
            </button>
            <button type="button" onClick={stopEditing} className={iconButton} aria-label="Cancel renaming" title="Cancel">
              <X size={15} />
            </button>
          </form>
        ) : (
          <>
            <h4 ref={heading} tabIndex={-1} data-list-heading={list.id} className="min-w-0 flex-1 truncate text-sm font-medium outline-none" title={list.name}>
              {list.name}
            </h4>
            <span className="shrink-0 text-xs text-[var(--text-soft)]">{listCounts(list.items)}</span>
            <button
              type="button"
              onClick={() => {
                setName(list.name);
                setEditing(true);
              }}
              className={iconButton}
              aria-label={`Rename list: ${list.name}`}
              title="Rename"
            >
              <Pencil size={13} />
            </button>
            <button type="button" onClick={onDelete} className={deleteButton} aria-label={`Delete list: ${list.name}`} title="Delete list">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {error ? <p className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--danger)]">{error}</p> : null}
      {list.items.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-[var(--text-soft)]">Nothing on this list.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]" aria-label={list.name}>
          {list.items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 px-3 py-2 text-sm">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => onToggle(item)}
                  data-item={item.id}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                />
                <span className={`min-w-0 break-words ${item.done ? "text-[var(--text-soft)] line-through" : ""}`}>{item.text}</span>
              </label>
              <button type="button" onClick={() => onRemoveItem(item)} className={deleteButton} aria-label={`Remove: ${item.text}`} title="Remove">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One note: its text and date; edit or delete it. */
function NoteRow({
  note,
  error,
  onEditingDone,
  onSave,
  onDelete,
}: {
  note: NoteDto;
  /** The last change to this note that didn't work (e.g. "Notes can't hold passwords…"). */
  error: string | null;
  onEditingDone: () => void;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const stopEditing = () => {
    setEditing(false);
    setText(note.text);
    onEditingDone();
    requestAnimationFrame(() => editButton.current?.focus());
  };

  return (
    <li className="px-3 py-2 text-sm">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const next = text.trim();
            if (!next || next === note.text) return stopEditing();
            setBusy(true);
            const ok = await onSave(next);
            setBusy(false);
            if (ok) stopEditing();
          }}
        >
          <textarea
            value={text}
            maxLength={NOTE_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                stopEditing();
              }
            }}
            rows={3}
            aria-label="Edit note"
            autoFocus
            aria-invalid={error ? true : undefined}
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          />
          {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-[var(--text-soft)]">
              {text.length}/{NOTE_MAX}
            </span>
            <button type="button" onClick={stopEditing} className="rounded-lg px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{note.text}</p>
          <span className="shrink-0 pt-0.5 text-[11px] text-[var(--text-soft)]">{dateText(note.updatedAt)}</span>
          <button
            ref={editButton}
            type="button"
            data-note={note.id}
            onClick={() => {
              setText(note.text);
              setEditing(true);
            }}
            className={iconButton}
            aria-label={`Edit note: ${note.text.slice(0, 60)}`}
            title="Edit"
          >
            <Pencil size={13} />
          </button>
          <button type="button" onClick={onDelete} className={deleteButton} aria-label={`Delete note: ${note.text.slice(0, 60)}`} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      )}
      {error && !editing ? <p className="mt-1 text-xs text-[var(--danger)]">{error}</p> : null}
    </li>
  );
}
