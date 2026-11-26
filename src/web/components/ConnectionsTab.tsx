import { AlertTriangle, CalendarDays, Check, ExternalLink, FolderGit2, GitPullRequestArrow, Lock, Minus, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ConnectionsDto, GithubActionDto, GithubConnectionDto, GoogleActionDto, GoogleConnectionDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { ACTION_KIND_LABEL, ACTION_STATUS_LABEL, actionStatusTone } from "./GithubActionCard";
import { googleKindLabel, googleStatusLabel, googleStatusTone } from "./GoogleActionCard";

type Kind = "reader" | "actions";

const TEXT: Record<
  Kind,
  { title: string; intro: ReactNode; start: string; connect: string; reconnect: string; none: string; repos: string; lost: string }
> = {
  reader: {
    title: "GitHub",
    intro: (
      <>
        Ask about your own repositories in chat: explain code, find files, read issues and pull requests, review changes.{" "}
        <strong className="font-medium text-[var(--text)]">Read-only</strong>: this connection can't change anything on GitHub.
      </>
    ),
    start: "/api/connections/github/start",
    connect: "Connect GitHub",
    reconnect: "Reconnect GitHub",
    none: "VESPER can't read any of your repositories yet: choose them on GitHub.",
    repos: "Repositories VESPER can read",
    lost: "Reconnect to keep using GitHub in chat.",
  },
  actions: {
    title: "GitHub changes (with your approval)",
    intro: (
      <>
        Let VESPER prepare issues, comments and pull requests in the repositories you choose. Each change appears in the chat on a card with the exact
        text or every changed line, and <strong className="font-medium text-[var(--text)]">nothing is sent until you press Approve</strong>. Pull
        requests always go on a new branch; VESPER never merges or deletes anything.
      </>
    ),
    start: "/api/connections/github-actions/start",
    connect: "Connect GitHub changes",
    reconnect: "Reconnect GitHub changes",
    none: "VESPER can't change any of your repositories yet: choose them on GitHub.",
    repos: "Repositories VESPER may change (after your approval)",
    lost: "Reconnect to keep preparing changes.",
  },
};

const formatDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Settings → Connections: the user's own GitHub, read-only (v0.12.0), and changes with approval (v0.13.0). */
export function ConnectionsTab() {
  const [data, setData] = useState<ConnectionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.connections().then(setData, (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't load your connections."));
  }, []);

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!data) return <p className="text-sm text-[var(--text-soft)]">Loading…</p>;
  if (!data.github.available && !data.githubActions.available && !data.google.available) {
    return <p className="text-sm text-[var(--text-soft)]">No connections are available for your account.</p>;
  }

  const disconnect = async (kind: Kind | "google") => {
    setBusy(true);
    try {
      setData(kind === "google" ? await api.disconnectGoogle() : kind === "actions" ? await api.disconnectGithubActions() : await api.disconnectGithub());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't disconnect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 text-sm">
      {data.github.available ? <GithubSection kind="reader" connection={data.github} busy={busy} onDisconnect={() => disconnect("reader")} /> : null}
      {data.githubActions.available ? (
        <div className={data.github.available ? "border-t border-[var(--border)] pt-5" : undefined}>
          <GithubSection kind="actions" connection={data.githubActions} busy={busy} onDisconnect={() => disconnect("actions")} />
          {data.recentActions.length ? <RecentChanges actions={data.recentActions} /> : null}
        </div>
      ) : null}
      {data.google.available ? (
        <div className={data.github.available || data.githubActions.available ? "border-t border-[var(--border)] pt-5" : undefined}>
          <GoogleSection google={data.google} busy={busy} onDisconnect={() => disconnect("google")} />
          {data.recentGoogleActions.length ? <RecentGoogle actions={data.recentGoogleActions} /> : null}
        </div>
      ) : null}

      <div className="rounded-lg bg-[var(--bg-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
        <p className="font-medium text-[var(--text)]">Privacy</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>Your GitHub{data.google.available ? " and Google" : ""} access is stored encrypted and is never shown to the AI model or anyone else.</li>
          <li>Code VESPER reads appears in your chat. Files are kept on the server for at most 15 minutes to save GitHub requests, then deleted.</li>
          {data.google.available ? (
            <li>
              Calendar events VESPER reads, and emails it prepares, go to the AI service that writes the answer (free services may use what they receive to
              improve their models). VESPER doesn't keep your calendar. A prepared email or event is kept only until you approve or reject it, at most 24
              hours; afterwards only a log line stays for 90 days: the subject or title, who or when, and the outcome.
            </li>
          ) : null}
          {data.githubActions.available ? (
            <li>
              A prepared change (its text and changed lines) is kept only until you approve or reject it, at most 24 hours. Afterwards only a log line
              stays for 90 days: what, where, the outcome and the link.
            </li>
          ) : null}
          <li>If you rate an answer 👍/👎, a copy of the question and answer goes to the administrator's feedback list.</li>
          <li>Disconnecting removes VESPER's access. To also remove the app from GitHub: GitHub → Settings → Applications.</li>
          {data.google.available ? <li>Disconnecting Google also asks Google to remove VESPER's access (you can check at myaccount.google.com → Security).</li> : null}
        </ul>
      </div>
    </div>
  );
}

function GithubSection({ kind, connection: github, busy, onDisconnect }: { kind: Kind; connection: GithubConnectionDto; busy: boolean; onDisconnect: () => void }) {
  const text = TEXT[kind];
  const Icon = kind === "actions" ? GitPullRequestArrow : FolderGit2;
  const connect = (
    <a
      href={text.start}
      className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)]"
    >
      <Icon size={15} /> {github.status === "reconnect" ? text.reconnect : text.connect}
    </a>
  );
  const chooseRepos = github.installUrl ? (
    <a
      href={github.installUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
    >
      Choose repositories on GitHub <ExternalLink size={13} />
    </a>
  ) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Icon size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="font-medium">{text.title}</p>
          <p className="mt-0.5 text-[var(--text-soft)]">{text.intro}</p>
        </div>
      </div>

      {github.status === "none" ? (
        <div className="space-y-3">
          <p className="text-[var(--text-soft)]">
            GitHub asks you which repositories to allow (all, or only the ones you pick). You can change that or disconnect at any time.
            {kind === "actions" ? " You can allow fewer repositories here than for reading." : ""}
          </p>
          {connect}
        </div>
      ) : null}

      {github.status === "reconnect" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              Access{github.login ? ` for @${github.login}` : ""} was removed or has expired. {text.lost}
            </span>
          </div>
          {connect}
        </div>
      ) : null}

      {github.status === "connected" ? (
        <div className="space-y-3">
          <p>
            Connected as <strong className="font-medium">@{github.login}</strong>
          </p>
          {github.error ? <p className="text-amber-700 dark:text-amber-300">{github.error}</p> : null}
          {github.installations.length === 0 && !github.error ? (
            <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{text.none}</span>
            </div>
          ) : null}
          {github.installations.length ? (
            <ul className="space-y-1">
              {github.installations.map((i) => (
                <li key={i.account} className="flex flex-wrap items-center gap-x-2 text-[var(--text-soft)]">
                  <span className="font-medium text-[var(--text)]">{i.account}</span>
                  <span>
                    {i.type === "Organization" ? "organisation" : "your account"} · {i.allRepos ? "all repositories" : "chosen repositories"}
                  </span>
                  {i.manageUrl ? (
                    <a href={i.manageUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">
                      change
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {github.repos.length ? (
            <div>
              <p className="mb-1 text-xs text-[var(--text-soft)]">
                {text.repos}
                {github.reposTruncated ? " (first 100)" : ""}:
              </p>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto thin-scroll">
                {github.repos.map((r) => (
                  <span key={r.fullName} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
                    {r.private ? <Lock size={10} aria-label="private" /> : null}
                    {r.fullName}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-xs text-[var(--text-soft)]">
            An organisation's repositories need approval from one of its owners: pick the organisation on GitHub and they get a request.
          </p>
          <div className="flex flex-wrap gap-2">
            {chooseRepos}
            <button
              type="button"
              disabled={busy}
              onClick={onDisconnect}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--danger)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              <Unplug size={14} /> Disconnect
            </button>
          </div>
          {kind === "actions" ? <p className="text-xs text-[var(--text-soft)]">Disconnecting also cancels changes still waiting for your approval.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The user's latest GitHub changes and what happened to each (newest first). */
function RecentChanges({ actions }: { actions: GithubActionDto[] }) {
  return (
    <div className="mt-5">
      <p className="mb-1.5 text-xs font-medium text-[var(--text-soft)]">Recent changes</p>
      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {actions.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
            <span className={`font-medium ${actionStatusTone(a.status)}`}>{ACTION_STATUS_LABEL[a.status]}</span>
            <span className="text-[var(--text-soft)]">{ACTION_KIND_LABEL[a.kind]}</span>
            <span className="min-w-0 flex-1 truncate" title={a.title}>
              {a.title}
            </span>
            <span className="text-[var(--text-soft)]">{a.repo}</span>
            <span className="text-[var(--text-faint)]">{formatDate(a.createdAt)}</span>
            {a.resultUrl ? (
              <a href={a.resultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--accent)]">
                open <ExternalLink size={11} />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Google Calendar and Gmail (v0.15.0): one connection; Google's screen lets the user allow Calendar, sending email, or both. */
function GoogleSection({ google, busy, onDisconnect }: { google: GoogleConnectionDto; busy: boolean; onDisconnect: () => void }) {
  const connect = (
    <a
      href="/api/connections/google/start"
      className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)]"
    >
      <CalendarDays size={15} /> {google.status === "reconnect" ? "Reconnect Google" : "Connect Google"}
    </a>
  );
  const allowed = (on: boolean, label: string, detail: string) => (
    <li className="flex items-start gap-2">
      {on ? <Check size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <Minus size={15} className="mt-0.5 shrink-0 text-[var(--text-faint)]" />}
      <span>
        <span className={on ? "font-medium" : "text-[var(--text-soft)]"}>{label}</span>
        <span className="text-[var(--text-soft)]"> · {on ? detail : "not allowed"}</span>
      </span>
    </li>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CalendarDays size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="font-medium">Google Calendar and Gmail (with your approval)</p>
          <p className="mt-0.5 text-[var(--text-soft)]">
            Ask about your calendar and when you're free, and let VESPER prepare calendar events and emails. Each one appears in the chat on a card with
            exactly what will happen, and <strong className="font-medium text-[var(--text)]">nothing is added or sent until you press Approve</strong>.
            VESPER can't read your inbox.
          </p>
        </div>
      </div>

      {google.status === "none" ? (
        <div className="space-y-3">
          <p className="text-[var(--text-soft)]">
            Google asks which Google account to use and lets you tick what to allow: your calendar's events, sending email, or both. You can disconnect at any
            time.
          </p>
          {connect}
        </div>
      ) : null}

      {google.status === "reconnect" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              Google ended VESPER's access{google.email ? ` for ${google.email}` : ""}. While VESPER's Google app is in testing, Google does this every 7 days.
              Reconnect to keep using your calendar and email in chat.
            </span>
          </div>
          {connect}
        </div>
      ) : null}

      {google.status === "connected" ? (
        <div className="space-y-3">
          <p>
            Connected as <strong className="font-medium">{google.email}</strong>
          </p>
          <ul className="space-y-1">
            {allowed(google.calendar, "Calendar", "read your events and add the ones you approve")}
            {allowed(google.gmailSend, "Gmail", "send the emails you approve (VESPER can't read your inbox)")}
          </ul>
          <p className="text-xs text-[var(--text-soft)]">While VESPER's Google app is in testing, Google asks you to reconnect every 7 days.</p>
          <div className="flex flex-wrap gap-2">
            {!google.calendar || !google.gmailSend ? (
              <a
                href="/api/connections/google/start"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
              >
                Allow more on Google
              </a>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={onDisconnect}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--danger)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              <Unplug size={14} /> Disconnect
            </button>
          </div>
          <p className="text-xs text-[var(--text-soft)]">Disconnecting also cancels emails and events still waiting for your approval.</p>
        </div>
      ) : null}
    </div>
  );
}

/** The user's latest emails and events and what happened to each (newest first). */
function RecentGoogle({ actions }: { actions: GoogleActionDto[] }) {
  return (
    <div className="mt-5">
      <p className="mb-1.5 text-xs font-medium text-[var(--text-soft)]">Recent emails and events</p>
      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {actions.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
            <span className={`font-medium ${googleStatusTone(a.status)}`}>{googleStatusLabel(a.kind, a.status, a.op)}</span>
            <span className="text-[var(--text-soft)]">{googleKindLabel(a.kind, a.op)}</span>
            <span className="min-w-0 flex-1 truncate" title={a.title}>
              {a.title}
            </span>
            <span className="max-w-[14rem] truncate text-[var(--text-soft)]" title={a.target}>
              {a.target}
            </span>
            <span className="text-[var(--text-faint)]">{formatDate(a.createdAt)}</span>
            {a.resultUrl ? (
              <a href={a.resultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--accent)]">
                open <ExternalLink size={11} />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
