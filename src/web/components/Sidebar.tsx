import {
  Check,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationDto, UserDto } from "../../shared/types";
import { groupConversations } from "../lib/format";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";

interface Props {
  appName: string;
  user: UserDto;
  conversations: ConversationDto[];
  hasMore: boolean;
  activeId: string | null;
  /** Mobile drawer open. */
  open: boolean;
  /** Desktop: narrow icon rail instead of the full sidebar. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
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

export function Avatar({ user, size = 32 }: { user: UserDto; size?: number }) {
  return user.avatarUrl ? (
    <img src={user.avatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
  ) : (
    <div
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-[var(--accent-text)]"
      aria-hidden
    >
      {(user.name || user.login).slice(0, 1).toUpperCase()}
    </div>
  );
}

const iconButton = "flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]";

export function Sidebar(props: Props) {
  const { conversations, activeId, open, collapsed } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title) props.onRename(id, title);
    setEditing(null);
  };

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations), [conversations, q]);

  // Desktop rail: icons only.
  const rail = (
    <aside
      className="hidden w-[60px] shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--bg-sidebar)] py-3 md:flex"
      aria-label="Sidebar (collapsed)"
    >
      <button type="button" onClick={props.onToggleCollapsed} className={iconButton} aria-label="Expand sidebar" title="Expand sidebar">
        <PanelLeftOpen size={18} />
      </button>
      <button type="button" onClick={props.onNewChat} className={iconButton} aria-label="New chat" title="New chat">
        <SquarePen size={18} />
      </button>
      <button
        type="button"
        onClick={() => {
          props.onToggleCollapsed();
          setTimeout(() => searchRef.current?.focus(), 50);
        }}
        className={iconButton}
        aria-label="Search chats"
        title="Search chats"
      >
        <Search size={18} />
      </button>
      <div className="flex-1" />
      <ProfileMenu {...props} compact />
    </aside>
  );

  return (
    <>
      {open ? <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden" onClick={props.onClose} aria-hidden /> : null}
      {collapsed ? rail : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[280px] flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "flex translate-x-0" : "flex -translate-x-full"
        } ${collapsed ? "md:hidden" : "md:flex"}`}
        aria-label="Conversations"
      >
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="flex-1 truncate font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-tight">{props.appName}</span>
          <button type="button" onClick={props.onClose} className={`${iconButton} md:hidden`} aria-label="Close sidebar">
            <X size={18} />
          </button>
          <button type="button" onClick={props.onToggleCollapsed} className={`${iconButton} hidden md:flex`} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>

        <div className="space-y-2 px-3 pt-1">
          <button
            type="button"
            onClick={props.onNewChat}
            className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm font-medium shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
          >
            <SquarePen size={16} className="text-[var(--accent)]" /> New chat
          </button>
          <label className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-soft)] focus-within:bg-[var(--bg-hover)] hover:bg-[var(--bg-hover)]">
            <Search size={15} className="shrink-0" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search chats"
              aria-label="Search chats"
              className="min-w-0 flex-1 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-soft)]"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} className="rounded p-0.5 hover:text-[var(--text)]" aria-label="Clear search">
                <X size={14} />
              </button>
            ) : null}
          </label>
        </div>

        <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-2 thin-scroll" aria-label="Chat history">
          {visible.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-[var(--text-soft)]">
              {q ? (props.hasMore ? "No loaded chats match. Try loading older chats below." : "No chats match your search.") : "No conversations yet."}
            </p>
          ) : (
            groupConversations(visible).map(([label, items]) => (
              <div key={label} className="mb-4">
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">{label}</div>
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
                      className={`group relative flex items-center rounded-lg transition-colors ${
                        c.id === activeId ? "bg-[var(--bg-hover)] text-[var(--text)]" : "text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      }`}
                    >
                      {c.id === activeId ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-[var(--accent)]" aria-hidden /> : null}
                      <button
                        type="button"
                        onClick={() => props.onSelect(c.id)}
                        className={`flex min-w-0 flex-1 items-center px-3 py-2 text-left text-sm ${c.id === activeId ? "font-medium" : ""}`}
                        title={c.title}
                        aria-current={c.id === activeId ? "page" : undefined}
                      >
                        <span className="truncate">{c.title}</span>
                      </button>
                      <div className={`shrink-0 pr-1 ${c.id === activeId ? "flex" : "flex md:hidden md:group-hover:flex md:group-focus-within:flex"}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(c.id);
                            setDraft(c.title);
                          }}
                          className="rounded-md p-1.5 text-[var(--text-soft)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
                          aria-label={`Rename ${c.title}`}
                          title="Rename"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete "${c.title}"? This cannot be undone.`)) props.onDelete(c.id);
                          }}
                          className="rounded-md p-1.5 text-[var(--text-soft)] hover:bg-[var(--bg)] hover:text-[var(--danger)]"
                          aria-label={`Delete ${c.title}`}
                          title="Delete"
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
              Load older chats
            </button>
          ) : null}
        </nav>

        <div className="border-t border-[var(--border)] p-2">
          <ProfileMenu {...props} />
        </div>
      </aside>
    </>
  );
}

/** The account button at the bottom of the sidebar, with Settings, Admin, theme and sign-out. */
function ProfileMenu(props: Props & { compact?: boolean }) {
  const { user, compact } = props;
  // Each menu instance has its own state: the rail and the full sidebar can both be in the page.
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-[var(--bg-hover)]";
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={compact ? "rounded-full p-0.5 hover:ring-2 hover:ring-[var(--border-strong)]" : "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-[var(--bg-hover)]"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar user={user} size={compact ? 32 : 34} />
        {compact ? null : (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{user.name || user.login}</span>
              {user.role === "admin" ? (
                <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">Admin</span>
              ) : null}
            </span>
            {user.email ? <span className="block truncate text-xs text-[var(--text-soft)]">{user.email}</span> : null}
          </span>
        )}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute bottom-full z-50 mb-2 w-64 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-lg)] ${compact ? "left-0" : "left-0 right-0 w-auto"}`}
        >
          <button type="button" role="menuitem" className={item} onClick={run(props.onOpenSettings)}>
            <Settings size={16} className="text-[var(--text-soft)]" /> Settings
          </button>
          {user.role === "admin" ? (
            <button type="button" role="menuitem" className={item} onClick={run(props.onOpenAdmin)}>
              <ShieldCheck size={16} className="text-[var(--text-soft)]" /> Admin panel
            </button>
          ) : null}
          <div className="my-1 border-t border-[var(--border)]" />
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">Theme</div>
          <div className="grid grid-cols-3 gap-1 px-1 pb-1" role="group" aria-label="Theme">
            {(
              [
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
                ["system", "Auto", Monitor],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTheme(value);
                  setThemePreference(value);
                }}
                aria-pressed={theme === value}
                className={`flex flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] ${
                  theme === value ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-soft)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-[var(--border)]" />
          <button type="button" role="menuitem" className={`${item} text-[var(--danger)]`} onClick={run(props.onLogout)}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
