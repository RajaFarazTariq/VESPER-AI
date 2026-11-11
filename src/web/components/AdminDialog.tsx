import { ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminUserDto, AppSettingsDto, ModelsResponse, ToolInfoDto, UserModelOption } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { formatRelative } from "../lib/format";
import { Field, Toggle } from "./SettingsDialog";

type Tab = "users" | "settings" | "models" | "providers";

interface Props {
  currentUserId: string;
  models: ModelsResponse | null;
  refreshingModels: boolean;
  onRefreshModels: () => void;
  onClose: () => void;
  onNotice: (message: string, kind?: "error" | "info") => void;
}

const MAX_INSTRUCTIONS = 4000;

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const formatDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Administrator-only panel: users, app-wide settings and provider status. */
export function AdminDialog({ currentUserId, models, refreshingModels, onRefreshModels, onClose, onNotice }: Props) {
  const [tab, setTab] = useState<Tab>("users");
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs: [Tab, string][] = [
    ["users", "Users"],
    ["settings", "App settings"],
    ["models", "Models"],
    ["providers", "Providers"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-2xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl outline-none sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 id="admin-title" className="text-lg font-semibold">
            Admin panel
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)]" aria-label="Close admin panel">
            <X size={18} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-3 thin-scroll" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm ${
                tab === id ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-soft)] hover:text-[var(--text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 thin-scroll">
          {tab === "users" ? <UsersTab currentUserId={currentUserId} onNotice={onNotice} /> : null}
          {tab === "settings" ? <SettingsTab onNotice={onNotice} /> : null}
          {tab === "models" ? <ModelsTab models={models} onNotice={onNotice} /> : null}
          {tab === "providers" ? <ProvidersTab models={models} refreshing={refreshingModels} onRefresh={onRefreshModels} /> : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Users

function UsersTab({ currentUserId, onNotice }: { currentUserId: string; onNotice: Props["onNotice"] }) {
  const [users, setUsers] = useState<AdminUserDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultLimit, setDefaultLimit] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, settings] = await Promise.all([api.admin.users(), api.admin.settings()]);
      setUsers(list.users);
      setDefaultLimit(settings.settings.defaultDailyLimit);
    } catch (e) {
      setUsers([]);
      setError(errorText(e, "Could not load users."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (user: AdminUserDto) => setUsers((list) => (list ?? []).map((u) => (u.id === user.id ? user : u)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-soft)]">
          {users ? `${users.length} account${users.length === 1 ? "" : "s"}` : "Loading…"}
          {defaultLimit !== null ? ` · default limit ${defaultLimit} messages/day (admins unlimited)` : ""}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)]"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      <ul className="space-y-2">
        {(users ?? []).map((u) => (
          <UserRow key={u.id} user={u} isSelf={u.id === currentUserId} defaultLimit={defaultLimit} onChanged={replace} onDeleted={(id) => setUsers((l) => (l ?? []).filter((x) => x.id !== id))} onNotice={onNotice} />
        ))}
      </ul>
    </div>
  );
}

function Badge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "accent" | "danger" }) {
  const tones = {
    neutral: "bg-[var(--bg-soft)] text-[var(--text-soft)]",
    accent: "bg-[var(--accent)]/15 text-[var(--accent)]",
    danger: "bg-[var(--danger)]/15 text-[var(--danger)]",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}

function UserRow({
  user,
  isSelf,
  defaultLimit,
  onChanged,
  onDeleted,
  onNotice,
}: {
  user: AdminUserDto;
  isSelf: boolean;
  defaultLimit: number | null;
  onChanged: (u: AdminUserDto) => void;
  onDeleted: (id: string) => void;
  onNotice: Props["onNotice"];
}) {
  const [limitDraft, setLimitDraft] = useState(user.dailyLimit === null ? "" : String(user.dailyLimit));
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === "admin";
  const effectiveLimit = user.dailyLimit ?? defaultLimit;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onNotice(errorText(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };

  const limitValue = limitDraft.trim() === "" ? null : Number(limitDraft);
  const limitValid = limitValue === null || (Number.isInteger(limitValue) && limitValue >= 0 && limitValue <= 100_000);
  const limitChanged = limitValue !== user.dailyLimit;

  return (
    <li className="rounded-xl border border-[var(--border)] p-3">
      <div className="flex items-start gap-3">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-[var(--accent-text)]">
            {(user.name || user.login).slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{user.name || user.login}</span>
            {isAdmin ? <Badge tone="accent">Admin</Badge> : null}
            {user.status === "blocked" ? <Badge tone="danger">Blocked</Badge> : null}
            {isSelf ? <Badge>You</Badge> : null}
            {user.google ? <Badge>Google</Badge> : null}
            {user.github ? <Badge>GitHub</Badge> : null}
          </div>
          <p className="truncate text-xs text-[var(--text-soft)]">{user.email ?? user.login}</p>
          <p className="mt-1 text-xs text-[var(--text-soft)]">
            Today: {user.todayMessages}
            {isAdmin ? " messages (unlimited)" : effectiveLimit !== null ? ` / ${effectiveLimit} messages` : " messages"} · {user.conversations} chat
            {user.conversations === 1 ? "" : "s"} · last sign-in {formatDate(user.lastLoginAt)} · joined {formatDate(user.createdAt)}
          </p>
        </div>
      </div>

      {!isAdmin ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-soft)]">
            Daily limit
            <input
              value={limitDraft}
              onChange={(e) => setLimitDraft(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder={`default (${defaultLimit ?? "…"})`}
              aria-label={`Daily message limit for ${user.name || user.login}`}
              className="w-28 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
          <button
            type="button"
            disabled={busy || !limitValid || !limitChanged}
            onClick={() =>
              void run(async () => {
                const { user: saved } = await api.admin.updateUser(user.id, { dailyLimit: limitValue });
                onChanged(saved);
                onNotice("Daily limit saved.", "info");
              })
            }
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            Save limit
          </button>
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = user.status === "blocked" ? "active" : "blocked";
                if (next === "blocked" && !window.confirm(`Block ${user.name || user.login}? They are signed out at once and can't sign in again until unblocked.`)) return;
                const { user: saved } = await api.admin.updateUser(user.id, { status: next });
                onChanged(saved);
                onNotice(next === "blocked" ? "User blocked." : "User unblocked.", "info");
              })
            }
            className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
              user.status === "blocked" ? "border border-[var(--border)] hover:bg-[var(--bg-hover)]" : "bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/20"
            }`}
          >
            {user.status === "blocked" ? "Unblock" : "Block"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!window.confirm(`Delete ${user.name || user.login} and ALL of their chats and memories? This cannot be undone.`)) return;
                await api.admin.deleteUser(user.id);
                onDeleted(user.id);
                onNotice("User deleted.", "info");
              })
            }
            className="rounded-lg p-1.5 text-[var(--text-soft)] hover:text-[var(--danger)] disabled:opacity-40"
            aria-label={`Delete ${user.name || user.login}`}
            title="Delete user"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

// ------------------------------------------------------------------ App settings

function SettingsTab({ onNotice }: { onNotice: Props["onNotice"] }) {
  const [saved, setSaved] = useState<AppSettingsDto | null>(null);
  const [draft, setDraft] = useState<AppSettingsDto | null>(null);
  const [limitText, setLimitText] = useState("");
  const [tools, setTools] = useState<ToolInfoDto[]>([]);
  const [searchText, setSearchText] = useState("");
  const [webSearch, setWebSearch] = useState<{ keyConfigured: boolean; usedToday: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.settings().then(
      (r) => {
        setSaved(r.settings);
        setDraft(r.settings);
        setLimitText(String(r.settings.defaultDailyLimit));
        setSearchText(String(r.settings.webSearchDailyLimit));
        setTools(r.tools);
        setWebSearch(r.webSearch);
      },
      (e: unknown) => setError(errorText(e, "Could not load settings.")),
    );
  }, []);

  if (!draft || !saved) return error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const limit = Number(limitText);
  const limitValid = limitText.trim() !== "" && Number.isInteger(limit) && limit >= 0 && limit <= 100_000;
  const searches = Number(searchText);
  const searchValid = searchText.trim() !== "" && Number.isInteger(searches) && searches >= 0 && searches <= 1_000;
  const next: AppSettingsDto = {
    ...draft,
    defaultDailyLimit: limitValid ? limit : draft.defaultDailyLimit,
    webSearchDailyLimit: searchValid ? searches : draft.webSearchDailyLimit,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Only this tab's fields: the model list is saved by the Models tab, so it is never overwritten here.
      const { userModels: _models, ...patch } = next;
      const { settings } = await api.admin.updateSettings(patch);
      setSaved(settings);
      setDraft(settings);
      setLimitText(String(settings.defaultDailyLimit));
      setSearchText(String(settings.webSearchDailyLimit));
      onNotice("App settings saved.", "info");
    } catch (e) {
      setError(errorText(e, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Toggle
        checked={draft.signupsOpen}
        onChange={(signupsOpen) => setDraft({ ...draft, signupsOpen })}
        label="Sign-ups open"
        hint="When off, nobody new can create an account. Everyone who already has an account can still sign in."
      />
      <Toggle
        checked={draft.showReasoningToUsers}
        onChange={(showReasoningToUsers) => setDraft({ ...draft, showReasoningToUsers })}
        label="Show the assistant's thinking notes to users"
        hint="Some models write out their reasoning before answering. Off: users see only the answer (you always see everything)."
      />
      <Field label="Messages per user per day" hint="Applies to everyone without a personal limit (set those in Users). Admins are unlimited. Resets at 00:00 UTC.">
        <input
          value={limitText}
          onChange={(e) => setLimitText(e.target.value.replace(/[^\d]/g, ""))}
          inputMode="numeric"
          aria-label="Default daily message limit"
          className={`w-32 rounded-lg border bg-[var(--bg)] px-3 py-2 text-sm ${limitValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
        />
      </Field>
      <Field label="Instructions for the assistant" hint="Added to every user's conversations (e.g. tone, language, topics to avoid). Users can't see or change this.">
        <textarea
          value={draft.botInstructions}
          maxLength={MAX_INSTRUCTIONS}
          onChange={(e) => setDraft({ ...draft, botInstructions: e.target.value })}
          rows={5}
          placeholder="e.g. Always answer in simple English. Keep replies short unless asked for detail."
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
        />
        <div className="mt-1 text-right text-xs text-[var(--text-soft)]">
          {draft.botInstructions.length}/{MAX_INSTRUCTIONS}
        </div>
      </Field>
      <Field
        label="Web searches per day (whole app)"
        hint="Shared by all users, admins included. Tavily's free plan is 1,000 searches a month, so 30 a day stays within it. 0 turns web search off. Resets at 00:00 UTC."
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Web searches per day"
            className={`w-32 rounded-lg border bg-[var(--bg)] px-3 py-2 text-sm ${searchValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          {webSearch ? (
            webSearch.keyConfigured ? (
              <span className="text-xs text-[var(--text-soft)]">
                Used today: {webSearch.usedToday} of {saved.webSearchDailyLimit}
              </span>
            ) : (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Not active yet: add the <code>TAVILY_API_KEY</code> secret in Cloudflare.
              </span>
            )
          ) : null}
        </div>
      </Field>
      <Field label="Tools available to everyone" hint="A tool switched off here is removed for all users, including you.">
        <div className="space-y-2">
          {tools.map((t) => (
            <div key={t.name} className="rounded-xl border border-[var(--border)] p-3">
              <Toggle
                checked={!draft.disabledTools.includes(t.name)}
                onChange={(on) =>
                  setDraft({
                    ...draft,
                    disabledTools: on ? draft.disabledTools.filter((n) => n !== t.name) : [...draft.disabledTools, t.name],
                  })
                }
                label={t.label}
                hint={t.description}
              />
              {!t.available ? (
                <span className="ml-12 mt-1 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                  {t.name === "web_search" ? "Not available: needs the TAVILY_API_KEY secret (or searches per day is 0)" : "Not available on this server"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Field>
      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
        {error ? <span className="mr-auto text-sm text-[var(--danger)]">{error}</span> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || !limitValid || !searchValid || saving}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Models for users

const MAX_USER_MODELS = 20;
const MAX_MODEL_LABEL = 40;
const suggestLabel = (label: string) => (label.split("/").pop() ?? label).slice(0, MAX_MODEL_LABEL);

function ModelsTab({ models, onNotice }: { models: ModelsResponse | null; onNotice: Props["onNotice"] }) {
  const [saved, setSaved] = useState<UserModelOption[] | null>(null);
  const [draft, setDraft] = useState<UserModelOption[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.settings().then(
      (r) => {
        setSaved(r.settings.userModels);
        setDraft(r.settings.userModels);
      },
      (e: unknown) => setError(errorText(e, "Could not load the model list.")),
    );
  }, []);

  if (!saved) return error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const offered = new Set((models?.providers ?? []).flatMap((p) => p.models.map((m) => `${p.id}:${m.id}`)));
  const chosen = new Set(draft.map((m) => m.value));
  const labelsValid = draft.every((m) => m.label.trim().length > 0 && m.label.trim().length <= MAX_MODEL_LABEL);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const q = query.trim().toLowerCase();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { settings } = await api.admin.updateSettings({ userModels: draft.map((m) => ({ value: m.value, label: m.label.trim() })) });
      setSaved(settings.userModels);
      setDraft(settings.userModels);
      onNotice("Model list saved. Users see it the next time they open or refresh the app.", "info");
    } catch (e) {
      setError(errorText(e, "Could not save the model list."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--text-soft)]">
        Users always have <b>Auto</b> (the app picks the best available free model). Add up to {MAX_USER_MODELS} more models here, each with a
        simple name users will see (for example "Fast" or "Smart"). You can always use every model yourself.
      </p>

      <div>
        <div className="mb-1.5 text-sm font-medium">Available to users ({draft.length})</div>
        {draft.length === 0 ? (
          <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">None yet: users only have Auto.</p>
        ) : (
          <ul className="space-y-2">
            {draft.map((m, i) => (
              <li key={m.value} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] p-2.5">
                <input
                  value={m.label}
                  maxLength={MAX_MODEL_LABEL}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  aria-label={`Name users see for ${m.value}`}
                  className={`w-40 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm ${m.label.trim() ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-soft)]" title={m.value}>
                  {m.value}
                  {models && !offered.has(m.value) ? <span className="ml-1 text-amber-600 dark:text-amber-400">(not offered by the provider right now)</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  className="rounded-md p-1 text-[var(--text-soft)] hover:text-[var(--danger)]"
                  aria-label={`Remove ${m.label || m.value}`}
                  title="Remove"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-sm font-medium">All free models</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search models"
            className="ml-auto w-40 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
          />
        </div>
        <div className="max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] thin-scroll">
          {(models?.providers ?? [])
            .filter((p) => p.configured && p.models.length > 0)
            .map((p) => {
              const visible = p.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
              if (visible.length === 0) return null;
              return (
                <div key={p.id}>
                  <div className="sticky top-0 bg-[var(--bg-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">{p.label}</div>
                  {visible.map((m) => {
                    const value = `${p.id}:${m.id}`;
                    const added = chosen.has(value);
                    return (
                      <div key={value} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{m.label}</span>
                        {m.id === p.defaultModel ? <span className="text-xs text-[var(--text-soft)]">default</span> : null}
                        <button
                          type="button"
                          disabled={added || draft.length >= MAX_USER_MODELS}
                          onClick={() => setDraft([...draft, { value, label: suggestLabel(m.label) }])}
                          className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-40"
                        >
                          {added ? "Added" : "Add"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          {!models ? <p className="px-3 py-3 text-sm text-[var(--text-soft)]">Loading models…</p> : null}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
        {error ? <span className="mr-auto text-sm text-[var(--danger)]">{error}</span> : null}
        {!labelsValid ? <span className="mr-auto text-sm text-[var(--danger)]">Every model needs a name.</span> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || !labelsValid || saving}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Providers

function ProvidersTab({ models, refreshing, onRefresh }: { models: ModelsResponse | null; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm text-[var(--text-soft)]">
          API keys are stored as encrypted secrets in your Cloudflare Worker (Settings → Variables and Secrets), never in the browser or the
          repository. The app only uses free tiers and never switches to a paid model.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
      {(models?.providers ?? []).map((p) => (
        <div key={p.id} className="rounded-xl border border-[var(--border)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.label}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                p.configured ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-[var(--bg-soft)] text-[var(--text-soft)]"
              }`}
            >
              {p.configured ? "Configured" : "Not configured"}
            </span>
            {p.cooldownUntil ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                Cooling down · {formatRelative(p.cooldownUntil)}
              </span>
            ) : null}
            <a href={p.signupUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--accent)]">
              {p.id === "workers-ai" ? "Free limits" : "Get a free key"} <ExternalLink size={12} />
            </a>
          </div>
          <p className="mt-2 text-sm">{p.freeTier}</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[var(--text-soft)]">
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {p.configured ? (
            <p className="mt-2 text-xs text-[var(--text-soft)]">
              Today (UTC): {p.today.requests} requests, {p.today.failures} failed · default model: {p.defaultModel ?? "n/a"}
              {p.lastError && p.cooldownUntil ? <span className="block text-[var(--danger)]">Last error: {p.lastError}</span> : null}
            </p>
          ) : null}
        </div>
      ))}
      <p className="text-xs text-[var(--text-soft)]">Automatic order: {models?.order.join(" → ")} (change with the PROVIDER_ORDER variable).</p>
    </div>
  );
}
