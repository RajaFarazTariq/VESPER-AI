import { Check, LogOut, MessageSquare, Pencil, Settings, ShieldCheck, SquarePen, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { ConversationDto, UserDto } from "../../shared/types";
import { groupConversations } from "../lib/format";

interface Props {
  appName: string;
  user: UserDto;
  conversations: ConversationDto[];
  hasMore: boolean;
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
  onOpenSettings: () => void;
  /** Shown only for administrators. */
  onOpenAdmin: () => void;
  onLogout: () => void;
}

export function Sidebar(props: Props) {
  const { conversations, activeId, open } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title) props.onRename(id, title);
    setEditing(null);
  };

  return (
    <>
      {open ? <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={props.onClose} aria-hidden /> : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Conversations"
      >
        <div className="flex items-center gap-2 p-3">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="flex-1 truncate font-semibold">{props.appName}</span>
          <button type="button" onClick={props.onClose} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)] md:hidden" aria-label="Close sidebar">
            <X size={18} />
          </button>
        </div>
        <div className="px-3">
          <button
            type="button"
            onClick={props.onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-medium hover:bg-[var(--bg-hover)]"
          >
            <SquarePen size={16} /> New chat
          </button>
        </div>

        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-2 thin-scroll">
          {conversations.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--text-soft)]">No conversations yet.</p>
          ) : (
            groupConversations(conversations).map(([label, items]) => (
              <div key={label} className="mb-3">
                <div className="px-3 pb-1 text-xs font-medium text-[var(--text-soft)]">{label}</div>
                {items.map((c) =>
                  editing === c.id ? (
                    <div key={c.id} className="flex items-center gap-1 rounded-lg bg-[var(--bg-hover)] px-2 py-1">
                      <input
                        autoFocus
                        value={draft}
                        maxLength={120}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c.id);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
                        aria-label="Conversation title"
                      />
                      <button type="button" onClick={() => commitRename(c.id)} className="rounded p-1 hover:bg-[var(--bg)]" aria-label="Save title">
                        <Check size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={c.id}
                      className={`group flex items-center rounded-lg ${c.id === activeId ? "bg-[var(--bg-hover)]" : "hover:bg-[var(--bg-hover)]"}`}
                    >
                      <button
                        type="button"
                        onClick={() => props.onSelect(c.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                        title={c.title}
                      >
                        <MessageSquare size={14} className="shrink-0 text-[var(--text-soft)]" />
                        <span className="truncate">{c.title}</span>
                      </button>
                      <div className={`flex shrink-0 pr-1 ${c.id === activeId ? "flex" : "flex md:hidden md:group-hover:flex"}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(c.id);
                            setDraft(c.title);
                          }}
                          className="rounded p-1.5 text-[var(--text-soft)] hover:text-[var(--text)]"
                          aria-label={`Rename ${c.title}`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete "${c.title}"? This cannot be undone.`)) props.onDelete(c.id);
                          }}
                          className="rounded p-1.5 text-[var(--text-soft)] hover:text-[var(--danger)]"
                          aria-label={`Delete ${c.title}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))
          )}
          {props.hasMore ? (
            <button type="button" onClick={props.onLoadMore} className="w-full rounded-lg px-3 py-2 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)]">
              Load older conversations
            </button>
          ) : null}
        </nav>

        <div className="flex items-center gap-2 border-t border-[var(--border)] p-3">
          {props.user.avatarUrl ? (
            <img src={props.user.avatarUrl} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-[var(--accent-text)]">
              {props.user.login.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{props.user.name || props.user.login}</span>
          {props.user.role === "admin" ? (
            <button type="button" onClick={props.onOpenAdmin} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)]" aria-label="Admin panel" title="Admin panel">
              <ShieldCheck size={17} />
            </button>
          ) : null}
          <button type="button" onClick={props.onOpenSettings} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)]" aria-label="Settings" title="Settings">
            <Settings size={17} />
          </button>
          <button type="button" onClick={props.onLogout} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)]" aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </aside>
    </>
  );
}
