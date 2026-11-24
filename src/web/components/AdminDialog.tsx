import { ChevronDown, ExternalLink, RefreshCw, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOCUMENT_LIMITS } from "../../shared/documents";
import type {
  AdminUserDto,
  AppSettingsDto,
  FeedbackItemDto,
  FeedbackSummaryDto,
  ModelsResponse,
  StorageDto,
  StudioSpeaker,
  ToolInfoDto,
  UserModelOption,
} from "../../shared/types";
import { speakerLabel, STUDIO_SPEAKERS, STUDIO_VOICE_MAX_CHARS_PER_DAY } from "../../shared/voice";
import { api, ApiError } from "../api/client";
import { FEEDBACK_LABELS, formatRelative, providerLabel } from "../lib/format";
import { KnowledgeTab } from "./KnowledgeTab";
import { Field, Toggle } from "./SettingsDialog";

type Tab = "users" | "settings" | "models" | "knowledge" | "feedback" | "providers";

interface Props {
  currentUserId: string;
  models: ModelsResponse | null;
  refreshingModels: boolean;
  onRefreshModels: () => void;
  onClose: () => void;
  onNotice: (message: string, kind?: "error" | "info") => void;
}

const MAX_INSTRUCTIONS = 4000;

/** Website list from a text box: one per line (commas also work); the server tidies each entry. */
const siteLines = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

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
    ["knowledge", "Knowledge"],
    ["feedback", "Feedback"],
    ["providers", "Providers"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[3px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        className="rise-in flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-3xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)] outline-none sm:rounded-3xl"
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
          {tab === "knowledge" ? <KnowledgeTab onNotice={onNotice} /> : null}
          {tab === "feedback" ? <FeedbackTab /> : null}
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
            {user.githubConnected ? <Badge>Repos connected</Badge> : null}
            {user.githubActionsConnected ? <Badge>GitHub changes</Badge> : null}
            {user.googleConnected ? <Badge>Calendar/Gmail</Badge> : null}
          </div>
          <p className="truncate text-xs text-[var(--text-soft)]">{user.email ?? user.login}</p>
          <p className="mt-1 text-xs text-[var(--text-soft)]">
            Today: {user.todayMessages}
            {isAdmin ? " messages (unlimited)" : effectiveLimit !== null ? ` / ${effectiveLimit} messages` : " messages"}
            {user.todayImages > 0 ? ` · ${user.todayImages} image${user.todayImages === 1 ? "" : "s"}` : ""}
            {user.todaySpeechSeconds > 0 ? ` · ${Math.ceil(user.todaySpeechSeconds / 60)} min voice` : ""}
            {user.todayResearch > 0 ? ` · ${user.todayResearch} research run${user.todayResearch === 1 ? "" : "s"}` : ""}
            {user.todayAnswerChecks > 0 ? ` · ${user.todayAnswerChecks} answer check${user.todayAnswerChecks === 1 ? "" : "s"}` : ""}
            {user.todayGithubActions ? ` · ${user.todayGithubActions} GitHub change${user.todayGithubActions === 1 ? "" : "s"}` : ""}
            {user.todayTables ? ` · ${user.todayTables} spreadsheet${user.todayTables === 1 ? "" : "s"}` : ""}
            {user.todayDocuments ? ` · ${user.todayDocuments} document${user.todayDocuments === 1 ? "" : "s"}` : ""}
            {user.todayEmails ? ` · ${user.todayEmails} email${user.todayEmails === 1 ? "" : "s"}` : ""}
            {user.todayEvents ? ` · ${user.todayEvents} event${user.todayEvents === 1 ? "" : "s"}` : ""} · {user.conversations} chat
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

const MEGABYTE = 1024 * 1024;
/** "0.4 MB", "123 MB". */
const megabytes = (bytes: number) => {
  const mb = bytes / MEGABYTE;
  return `${mb < 10 ? mb.toLocaleString(undefined, { maximumFractionDigits: 1 }) : Math.round(mb).toLocaleString()} MB`;
};
/** "850,000", "1.2 million". */
const characters = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} million` : Math.round(n).toLocaleString();

/**
 * How full the database is (v0.16.0). The free plan allows 500 MB per database and new messages can't be saved once
 * it's full, so the admin sees it coming; each file feature's stored text is listed against its own cap.
 */
function StorageMeter({ storage }: { storage: StorageDto }) {
  const percent = storage.bytes === null ? null : Math.min(100, (storage.bytes / storage.maxBytes) * 100);
  const percentText = percent === null ? "" : percent > 0 && percent < 1 ? "under 1%" : `${Math.round(percent)}%`;
  const lines: [string, { chars: number; maxChars: number }][] = [
    ["Knowledge base", storage.knowledge],
    ["Spreadsheets", storage.spreadsheets],
    ["Documents in chat", storage.documents],
  ];
  return (
    <section className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-4" aria-labelledby="storage-title">
      <div>
        <h3 id="storage-title" className="text-sm font-medium">
          Storage
        </h3>
        <p className="mt-0.5 text-xs text-[var(--text-soft)]">
          The free plan allows {megabytes(storage.maxBytes)} per database. When it is full, new messages can't be saved.
        </p>
      </div>
      {storage.bytes === null || percent === null ? (
        <p className="text-xs text-[var(--text-soft)]">Database: size not available right now</p>
      ) : (
        <div>
          <p className="text-xs text-[var(--text-soft)]">
            Database: {megabytes(storage.bytes)} of {megabytes(storage.maxBytes)} ({percentText})
          </p>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
            role="meter"
            aria-label="Database space used"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${megabytes(storage.bytes)} of ${megabytes(storage.maxBytes)}`}
          >
            <div
              className={`h-full rounded-full ${percent >= 90 ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`}
              style={{ width: `${Math.max(percent, storage.bytes > 0 ? 1 : 0)}%` }}
            />
          </div>
        </div>
      )}
      <ul className="space-y-0.5 text-xs text-[var(--text-soft)]">
        {lines.map(([label, used]) => (
          <li key={label}>
            {label}: {characters(used.chars)} of {characters(used.maxChars)} characters
          </li>
        ))}
      </ul>
      {percent !== null && percent >= 70 ? (
        <p className={`text-xs ${percent >= 90 ? "font-medium text-[var(--danger)]" : "text-[var(--text)]"}`}>
          The database is getting full. Delete old chats with files, or ask for a second free database for files.
        </p>
      ) : null}
    </section>
  );
}

function SettingsTab({ onNotice }: { onNotice: Props["onNotice"] }) {
  const [saved, setSaved] = useState<AppSettingsDto | null>(null);
  const [draft, setDraft] = useState<AppSettingsDto | null>(null);
  const [limitText, setLimitText] = useState("");
  const [tools, setTools] = useState<ToolInfoDto[]>([]);
  const [searchText, setSearchText] = useState("");
  const [trustedText, setTrustedText] = useState("");
  const [blockedText, setBlockedText] = useState("");
  const [imagesText, setImagesText] = useState("");
  const [speechText, setSpeechText] = useState("");
  const [researchRunsText, setResearchRunsText] = useState("");
  const [researchKeepText, setResearchKeepText] = useState("");
  const [checksText, setChecksText] = useState("");
  const [webSearch, setWebSearch] = useState<{ keyConfigured: boolean; usedToday: number } | null>(null);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [actionsConfigured, setActionsConfigured] = useState(false);
  const [actionsText, setActionsText] = useState("");
  const [tablesText, setTablesText] = useState("");
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [emailsText, setEmailsText] = useState("");
  const [eventsText, setEventsText] = useState("");
  const [tableRowsText, setTableRowsText] = useState("");
  const [tableRowsRead, setTableRowsRead] = useState(0);
  const [documentsText, setDocumentsText] = useState("");
  /** VESPER Agent's studio voice (v0.17.1): characters per day for the whole app, and how many were read today. */
  const [studioCharsText, setStudioCharsText] = useState("");
  const [studioCharsToday, setStudioCharsToday] = useState(0);
  const [storage, setStorage] = useState<StorageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.settings().then(
      (r) => {
        setSaved(r.settings);
        setDraft(r.settings);
        setLimitText(String(r.settings.defaultDailyLimit));
        setSearchText(String(r.settings.webSearchDailyLimit));
        setTrustedText(r.settings.trustedSites.join("\n"));
        setBlockedText(r.settings.blockedSites.join("\n"));
        setImagesText(String(r.settings.imagesPerDay));
        setSpeechText(String(r.settings.speechMinutesPerDay));
        setResearchRunsText(String(r.settings.researchRunsPerDay));
        setResearchKeepText(String(r.settings.researchSearchReserve));
        setChecksText(String(r.settings.answerChecksPerDay));
        setTools(r.tools);
        setWebSearch(r.webSearch);
        setGithubConfigured(Boolean(r.github?.configured));
        setActionsConfigured(Boolean(r.githubActions?.configured));
        setActionsText(String(r.settings.githubActionsPerDay));
        setTablesText(String(r.settings.tablesPerDay));
        setTableRowsText(String(r.settings.tablesRowsPerDay));
        setTableRowsRead(r.tables?.rowsReadToday ?? 0);
        setGoogleConfigured(Boolean(r.google?.configured));
        setEmailsText(String(r.settings.emailsPerDay));
        setEventsText(String(r.settings.eventsPerDay));
        setDocumentsText(String(r.settings.documentsPerDay));
        setStudioCharsText(String(r.settings.studioVoiceCharsPerDay));
        setStudioCharsToday(r.studioVoice?.charsToday ?? 0);
        setStorage(r.storage ?? null);
      },
      (e: unknown) => setError(errorText(e, "Could not load settings.")),
    );
  }, []);

  if (!draft || !saved) return error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const limit = Number(limitText);
  const limitValid = limitText.trim() !== "" && Number.isInteger(limit) && limit >= 0 && limit <= 100_000;
  const searches = Number(searchText);
  const searchValid = searchText.trim() !== "" && Number.isInteger(searches) && searches >= 0 && searches <= 1_000;
  const imagesPerDay = Number(imagesText);
  const imagesValid = imagesText.trim() !== "" && Number.isInteger(imagesPerDay) && imagesPerDay >= 0 && imagesPerDay <= 1_000;
  const speechMinutes = Number(speechText);
  const speechValid = speechText.trim() !== "" && Number.isInteger(speechMinutes) && speechMinutes >= 0 && speechMinutes <= 1_440;
  const researchRuns = Number(researchRunsText);
  const researchRunsValid = researchRunsText.trim() !== "" && Number.isInteger(researchRuns) && researchRuns >= 0 && researchRuns <= 100;
  const researchKeep = Number(researchKeepText);
  const researchKeepValid = researchKeepText.trim() !== "" && Number.isInteger(researchKeep) && researchKeep >= 0 && researchKeep <= 1_000;
  const checksPerDay = Number(checksText);
  const checksValid = checksText.trim() !== "" && Number.isInteger(checksPerDay) && checksPerDay >= 0 && checksPerDay <= 100;
  const actionsPerDay = Number(actionsText);
  const actionsValid = actionsText.trim() !== "" && Number.isInteger(actionsPerDay) && actionsPerDay >= 0 && actionsPerDay <= 100;
  const tablesPerDay = Number(tablesText);
  const tablesValid = tablesText.trim() !== "" && Number.isInteger(tablesPerDay) && tablesPerDay >= 0 && tablesPerDay <= 1_000;
  const tableRows = Number(tableRowsText);
  const tableRowsValid = tableRowsText.trim() !== "" && Number.isInteger(tableRows) && tableRows >= 0 && tableRows <= 4_500_000;
  const emailsPerDay = Number(emailsText);
  const emailsValid = emailsText.trim() !== "" && Number.isInteger(emailsPerDay) && emailsPerDay >= 0 && emailsPerDay <= 100;
  const eventsPerDay = Number(eventsText);
  const eventsValid = eventsText.trim() !== "" && Number.isInteger(eventsPerDay) && eventsPerDay >= 0 && eventsPerDay <= 100;
  const documentsPerDay = Number(documentsText);
  const documentsValid = documentsText.trim() !== "" && Number.isInteger(documentsPerDay) && documentsPerDay >= 0 && documentsPerDay <= 1_000;
  const studioChars = Number(studioCharsText);
  const studioCharsValid =
    studioCharsText.trim() !== "" && Number.isInteger(studioChars) && studioChars >= 0 && studioChars <= STUDIO_VOICE_MAX_CHARS_PER_DAY;
  const next: AppSettingsDto = {
    ...draft,
    defaultDailyLimit: limitValid ? limit : draft.defaultDailyLimit,
    webSearchDailyLimit: searchValid ? searches : draft.webSearchDailyLimit,
    trustedSites: siteLines(trustedText),
    blockedSites: siteLines(blockedText),
    imagesPerDay: imagesValid ? imagesPerDay : draft.imagesPerDay,
    speechMinutesPerDay: speechValid ? speechMinutes : draft.speechMinutesPerDay,
    researchRunsPerDay: researchRunsValid ? researchRuns : draft.researchRunsPerDay,
    researchSearchReserve: researchKeepValid ? researchKeep : draft.researchSearchReserve,
    answerChecksPerDay: checksValid ? checksPerDay : draft.answerChecksPerDay,
    githubActionsPerDay: actionsValid ? actionsPerDay : draft.githubActionsPerDay,
    tablesPerDay: tablesValid ? tablesPerDay : draft.tablesPerDay,
    tablesRowsPerDay: tableRowsValid ? tableRows : draft.tablesRowsPerDay,
    emailsPerDay: emailsValid ? emailsPerDay : draft.emailsPerDay,
    eventsPerDay: eventsValid ? eventsPerDay : draft.eventsPerDay,
    documentsPerDay: documentsValid ? documentsPerDay : draft.documentsPerDay,
    studioVoiceCharsPerDay: studioCharsValid ? studioChars : draft.studioVoiceCharsPerDay,
  };
  // Research can use the day's searches above the ones kept for normal chat.
  const researchSearches = next.webSearchDailyLimit - next.researchSearchReserve;
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
      setTrustedText(settings.trustedSites.join("\n")); // the server tidies entries ("https://www.who.int/x" → "who.int")
      setBlockedText(settings.blockedSites.join("\n"));
      setImagesText(String(settings.imagesPerDay));
      setSpeechText(String(settings.speechMinutesPerDay));
      setResearchRunsText(String(settings.researchRunsPerDay));
      setResearchKeepText(String(settings.researchSearchReserve));
      setChecksText(String(settings.answerChecksPerDay));
      setActionsText(String(settings.githubActionsPerDay));
      setTablesText(String(settings.tablesPerDay));
      setTableRowsText(String(settings.tablesRowsPerDay));
      setEmailsText(String(settings.emailsPerDay));
      setEventsText(String(settings.eventsPerDay));
      setDocumentsText(String(settings.documentsPerDay));
      setStudioCharsText(String(settings.studioVoiceCharsPerDay));
      onNotice("App settings saved.", "info");
    } catch (e) {
      setError(errorText(e, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {storage ? <StorageMeter storage={storage} /> : null}
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
      <Toggle
        checked={draft.localModelsForUsers}
        onChange={(localModelsForUsers) => setDraft({ ...draft, localModelsForUsers })}
        label="Local models (Ollama) for users"
        hint="Lets users run open models on their own computer with the Ollama app (Settings → Local models). Needs a technical setup on each computer, so it's off by default. You can always use it yourself."
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
      <Field
        label="Trusted websites"
        hint="One per line, e.g. who.int or sbp.org.pk (subdomains included). Web search puts these first. Government sites (.gov, gov.pk, .int…) and an organisation's own site are already ranked first automatically."
      >
        <textarea
          value={trustedText}
          onChange={(e) => setTrustedText(e.target.value)}
          rows={3}
          aria-label="Trusted websites"
          placeholder={"who.int\nsbp.org.pk"}
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm"
        />
      </Field>
      <Field label="Blocked websites" hint="One per line. Web search never uses these sites, e.g. statistics or content-farm sites you don't trust.">
        <textarea
          value={blockedText}
          onChange={(e) => setBlockedText(e.target.value)}
          rows={3}
          aria-label="Blocked websites"
          placeholder="example-stats-site.com"
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm"
        />
      </Field>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.researchEnabled}
          onChange={(researchEnabled) => setDraft({ ...draft, researchEnabled })}
          label="Deep research"
          hint="Research button in the message box: the model plans 2–4 searches, up to 3 pages are read, then it writes a report with sources and dates. Uses 2 model requests and 2–4 web searches per run; searches are set aside at the start and unused ones are given back."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Research runs per user per day
          <input
            value={researchRunsText}
            onChange={(e) => setResearchRunsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Research runs per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${researchRunsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; failed or stopped runs don't count)</span>
        </label>
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Web searches kept for normal chat
          <input
            value={researchKeepText}
            onChange={(e) => setResearchKeepText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Web searches kept for normal chat"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${researchKeepValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(research can't use the last ones of the day)</span>
        </label>
        <p className={`ml-12 text-xs ${researchSearches >= 2 ? "text-[var(--text-soft)]" : "text-amber-600 dark:text-amber-400"}`}>
          {researchSearches >= 2
            ? `Research can use ${researchSearches} of the ${next.webSearchDailyLimit} daily web searches (about ${Math.floor(researchSearches / 4)}–${Math.floor(researchSearches / 2)} runs a day for the whole app).`
            : `Research is effectively off: the searches kept for normal chat (${next.researchSearchReserve}) leave fewer than 2 of the ${next.webSearchDailyLimit} daily searches for it.`}
        </p>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.answerCheckEnabled}
          onChange={(answerCheckEnabled) => setDraft({ ...draft, answerCheckEnabled })}
          label="Check this answer"
          hint="A button under answers that used sources (web, documents, weather, research): one more model request lists the answer's key claims and rates each as supported, contradicted or not in the sources, with the source. Other providers are tried before Groq. Each answer is checked once; the result is saved with it."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Answer checks per user per day
          <input
            value={checksText}
            onChange={(e) => setChecksText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Answer checks per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${checksValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; failed checks don't count)</span>
        </label>
        <Toggle
          checked={draft.researchAutoCheck}
          onChange={(researchAutoCheck) => setDraft({ ...draft, researchAutoCheck })}
          label="Check research reports automatically"
          hint="Every finished deep-research report is checked against its sources the same way, right after it's written: 1 more model request per run. It doesn't use the user's answer checks."
        />
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.githubForUsers}
          onChange={(githubForUsers) => setDraft({ ...draft, githubForUsers })}
          label="GitHub for users"
          hint="Settings → Connections: each user connects their own GitHub (read-only) and chooses which repositories VESPER may read; then they can ask about code, issues and pull requests. Admins can always use it. At most 10 GitHub requests per message; nothing is changed on GitHub."
        />
        <p className={`ml-12 text-xs ${githubConfigured ? "text-[var(--text-soft)]" : "text-amber-600 dark:text-amber-400"}`}>
          {githubConfigured
            ? "The VESPER GitHub App is set up."
            : "Not set up yet: add GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG and GITHUB_TOKEN_KEY in Cloudflare (see the configuration guide)."}
        </p>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.githubActionsForUsers}
          onChange={(githubActionsForUsers) => setDraft({ ...draft, githubActionsForUsers })}
          label="GitHub changes for users"
          hint="Settings → Connections → GitHub changes: users connect the separate Actions app and choose which repositories VESPER may change. VESPER then prepares issues, comments and pull requests; each one is shown on a card and sent only when the user approves it. Pull requests always go on a new branch; nothing is merged or deleted. Admins can always use it."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          GitHub changes per user per day
          <input
            value={actionsText}
            onChange={(e) => setActionsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="GitHub changes per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${actionsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(approved changes; admins unlimited; failed ones don't count)</span>
        </label>
        <p className={`ml-12 text-xs ${actionsConfigured ? "text-[var(--text-soft)]" : "text-amber-600 dark:text-amber-400"}`}>
          {actionsConfigured
            ? "The VESPER Actions GitHub App is set up. While it's installable only on your own account, nobody else can connect it, whatever this switch says."
            : "Not set up yet: add GITHUB_ACTIONS_APP_CLIENT_ID, GITHUB_ACTIONS_APP_CLIENT_SECRET and GITHUB_ACTIONS_APP_SLUG in Cloudflare (GITHUB_TOKEN_KEY is shared; see the configuration guide)."}
        </p>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.googleForUsers}
          onChange={(googleForUsers) => setDraft({ ...draft, googleForUsers })}
          label="Google Calendar and Gmail for users"
          hint="Settings → Connections → Google: users connect their own Google account and tick what to allow (calendar events, sending email). VESPER reads their calendar and finds free time; it prepares events and emails that are shown on a card and added or sent only when the user approves them. It can't read anyone's inbox. Admins can always use it."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Emails per user per day
          <input
            value={emailsText}
            onChange={(e) => setEmailsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Emails per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${emailsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>Calendar events per user per day</span>
          <input
            value={eventsText}
            onChange={(e) => setEventsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Calendar events per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${eventsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(approved ones; admins unlimited; failed ones don't count)</span>
        </label>
        <p className={`ml-12 text-xs ${googleConfigured ? "text-[var(--text-soft)]" : "text-amber-600 dark:text-amber-400"}`}>
          {googleConfigured
            ? "Google is set up. While VESPER's Google app is in testing, only its test users can connect, and Google ends each connection after 7 days (users reconnect)."
            : "Not set up yet: add GOOGLE_TOKEN_KEY in Cloudflare and switch on the Gmail and Calendar APIs in Google Cloud (see the configuration guide)."}
        </p>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.imagesEnabled}
          onChange={(imagesEnabled) => setDraft({ ...draft, imagesEnabled })}
          label="Image attachments"
          hint="Paperclip, paste and drag-and-drop in the message box (up to 3 per message). Images go only to models that can see them: Gemini first, then a free OpenRouter vision model. Only a small preview is kept with the chat."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Images per user per day
          <input
            value={imagesText}
            onChange={(e) => setImagesText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Images per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${imagesValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; resets 00:00 UTC)</span>
        </label>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.tablesEnabled}
          onChange={(tablesEnabled) => setDraft({ ...draft, tablesEnabled })}
          label="Spreadsheets (CSV and Excel)"
          hint="Paperclip in the message box: attach a CSV or Excel file (up to 10 MB and 50,000 rows; 5 per chat) and ask questions about it. The file is read in the user's browser and its rows are kept with the chat (deleted with it). Figures are calculated by the database over every row; the AI only sees the column overview, 3 example rows and the results."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Spreadsheets per user per day
          <input
            value={tablesText}
            onChange={(e) => setTablesText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Spreadsheets per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${tablesValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; each user keeps up to 20)</span>
        </label>
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Rows read for calculations per day (whole app)
          <input
            value={tableRowsText}
            onChange={(e) => setTableRowsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Rows read for spreadsheet calculations per day"
            className={`w-28 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${tableRowsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>
            Used today: {tableRowsRead.toLocaleString()} of {saved.tablesRowsPerDay.toLocaleString()}
          </span>
        </label>
        <p className="ml-12 text-xs text-[var(--text-soft)]">
          Cloudflare's free database allows 5 million rows read a day for the whole app, and stops every request once they're used, so
          calculations get their own share (at most 4,500,000). A question reads each row of its table about twice: about 100,000 for a
          50,000-row file, 5,000 for a 2,500-row one. Resets at 00:00 UTC.
        </p>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.documentsEnabled}
          onChange={(documentsEnabled) => setDraft({ ...draft, documentsEnabled })}
          label="Documents in chat"
          hint={`Paperclip in the message box: attach a PDF, Word (.docx), text or Markdown file (up to ${DOCUMENT_LIMITS.fileBytes / MEGABYTE} MB and ${DOCUMENT_LIMITS.pages} pages; ${DOCUMENT_LIMITS.perMessage} per message, ${DOCUMENT_LIMITS.perChat} per chat) and ask about it. The file is read in the user's browser and only its text is kept with the chat (deleted with it). Answers cite the file and page.`}
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Documents per user per day
          <input
            value={documentsText}
            onChange={(e) => setDocumentsText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Documents per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${documentsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; each user keeps up to {DOCUMENT_LIMITS.stored})</span>
        </label>
      </div>
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
        <Toggle
          checked={draft.voiceEnabled}
          onChange={(voiceEnabled) => setDraft({ ...draft, voiceEnabled })}
          label="Voice"
          hint="Microphone button: speech becomes text in the message box (Groq's free Whisper, Cloudflare as backup; English and Urdu). Also “Read aloud” on answers, using the device's own voices. Recordings are not stored."
        />
        <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
          Minutes of speech per user per day
          <input
            value={speechText}
            onChange={(e) => setSpeechText(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Minutes of speech per user per day"
            className={`w-20 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${speechValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
          />
          <span>(admins unlimited; Groq's free plan allows 8 hours a day for the whole app)</span>
        </label>
        <div className="ml-12 space-y-2 border-t border-[var(--border)] pt-3">
          <Toggle
            checked={draft.studioVoiceEnabled}
            onChange={(studioVoiceEnabled) => setDraft({ ...draft, studioVoiceEnabled })}
            label="Studio voice"
            hint="A natural female voice for VESPER Agent from Cloudflare Workers AI. Each 1,000 characters use about 1,364 of the 10,000 free daily AI units, which the backup chat model, speech-to-text and the knowledge-base search also use. After the daily limit, the device's own voice is used."
          />
          <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
            Characters per day (whole app)
            <input
              value={studioCharsText}
              onChange={(e) => setStudioCharsText(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              aria-label="Studio voice characters per day (whole app)"
              className={`w-24 rounded-lg border bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] ${studioCharsValid ? "border-[var(--border)]" : "border-[var(--danger)]"}`}
            />
            <span>
              Used today: {studioCharsToday.toLocaleString()} of {saved.studioVoiceCharsPerDay.toLocaleString()} (at most{" "}
              {STUDIO_VOICE_MAX_CHARS_PER_DAY.toLocaleString()}; resets 00:00 UTC)
            </span>
          </label>
          <label className="ml-12 flex flex-wrap items-center gap-2 text-xs text-[var(--text-soft)]">
            Voice
            <select
              value={draft.studioVoiceSpeaker}
              onChange={(e) => setDraft({ ...draft, studioVoiceSpeaker: e.target.value as StudioSpeaker })}
              aria-label="Studio voice"
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
            >
              {STUDIO_SPEAKERS.map((speaker) => (
                <option key={speaker} value={speaker}>
                  {speakerLabel(speaker)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
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
          disabled={
            !dirty ||
            !limitValid ||
            !searchValid ||
            !imagesValid ||
            !speechValid ||
            !researchRunsValid ||
            !researchKeepValid ||
            !checksValid ||
            !actionsValid ||
            !tablesValid ||
            !tableRowsValid ||
            !emailsValid ||
            !eventsValid ||
            !documentsValid ||
            !studioCharsValid ||
            saving
          }
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

// ------------------------------------------------------------------ Feedback (👍/👎 on answers)

type FeedbackFilter = "down" | "up" | "all";

function FeedbackTab() {
  const [filter, setFilter] = useState<FeedbackFilter>("down");
  const [items, setItems] = useState<FeedbackItemDto[] | null>(null);
  const [summary, setSummary] = useState<FeedbackSummaryDto | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (which: FeedbackFilter) => {
    setError(null);
    setItems(null);
    try {
      const r = await api.admin.feedback(which);
      setItems(r.items);
      setSummary(r.summary);
      setHasMore(r.hasMore);
    } catch (e) {
      setItems([]);
      setError(errorText(e, "Could not load feedback."));
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const more = async () => {
    const oldest = items?.[items.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const r = await api.admin.feedback(filter, oldest.updatedAt);
      setItems((list) => [...(list ?? []), ...r.items.filter((i) => !(list ?? []).some((x) => x.messageId === i.messageId))]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError(errorText(e, "Could not load more."));
    } finally {
      setLoadingMore(false);
    }
  };

  const filters: [FeedbackFilter, string][] = [
    ["down", `Bad answers${summary ? ` (${summary.down})` : ""}`],
    ["up", `Good answers${summary ? ` (${summary.up})` : ""}`],
    ["all", "All"],
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-soft)]">
        What users (and you) said about answers with the thumbs up / thumbs down buttons. Each entry keeps its own copy of the question
        and answer, so it stays here even if the answer was regenerated afterwards.
      </p>

      {summary && summary.byModel.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] thin-scroll">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-soft)] text-xs text-[var(--text-soft)]">
              <tr>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Good</th>
                <th className="px-3 py-2 text-right font-medium">Bad</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={`${m.provider}:${m.model}`} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5">
                    {m.provider ? `${providerLabel(m.provider)} · ${m.model ?? "?"}` : <span className="text-[var(--text-soft)]">Unknown model</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{m.up}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{m.down}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Show">
        {filters.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={filter === id}
            onClick={() => setFilter(id)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === id ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load(filter)}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover)]"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      {items === null ? <p className="text-sm text-[var(--text-soft)]">Loading…</p> : null}
      {items?.length === 0 && !error ? (
        <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">
          {filter === "down" ? "No bad answers reported yet." : filter === "up" ? "No good answers marked yet." : "No feedback yet."}
        </p>
      ) : null}
      <ul className="space-y-2">
        {(items ?? []).map((item) => (
          <FeedbackRow key={item.messageId} item={item} />
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={() => void more()}
          disabled={loadingMore}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

function FeedbackRow({ item }: { item: FeedbackItemDto }) {
  const [open, setOpen] = useState(false);
  const up = item.rating === 1;
  return (
    <li className="rounded-xl border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-soft)]">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${up ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-[var(--danger)]/15 text-[var(--danger)]"}`}>
          {up ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
          {up ? "Good" : "Bad"}
        </span>
        {item.reason ? <Badge>{FEEDBACK_LABELS[item.reason]}</Badge> : null}
        <span>{item.user.name || item.user.login}</span>
        <span>· {formatDate(item.updatedAt)}</span>
        {item.provider ? (
          <span className="truncate">
            · {providerLabel(item.provider)} · {item.model}
          </span>
        ) : null}
      </div>
      {item.note ? <p className="mt-2 rounded-lg bg-[var(--bg-soft)] px-3 py-2 text-sm">“{item.note}”</p> : null}
      <p className="mt-2 text-sm font-medium">{item.question || <span className="text-[var(--text-soft)]">(no question text)</span>}</p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent)]"
      >
        {open ? "Hide answer" : "Show answer"}
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] px-3 py-2 text-sm leading-relaxed thin-scroll">
            {item.answer}
          </div>
          {item.sources.length > 0 ? (
            <ul className="space-y-0.5 text-xs">
              {item.sources.map((s, i) => (
                <li key={i} className="truncate">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span className="text-[var(--text-soft)]">
                      {s.title}
                      {s.location ? ` · ${s.location}` : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--text-soft)]">No sources were used for this answer.</p>
          )}
        </div>
      ) : null}
    </li>
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
