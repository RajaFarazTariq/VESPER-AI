import { AlertTriangle, Check, CircleDot, ExternalLink, Globe, Loader2, MessageSquare, GitPullRequestArrow, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GithubActionDto, GithubActionFileDto, GithubActionKind, GithubActionRefDto, GithubActionStatus } from "../../shared/types";
import { api, ApiError } from "../api/client";

export const ACTION_KIND_LABEL: Record<GithubActionKind, string> = { issue: "New issue", comment: "Comment", pull_request: "Pull request" };
export const ACTION_STATUS_LABEL: Record<GithubActionStatus, string> = {
  pending: "Waiting for your approval",
  running: "Sending…",
  done: "Done",
  failed: "Couldn't be sent",
  rejected: "Rejected",
  expired: "Expired",
};
export const actionStatusTone = (status: GithubActionStatus) =>
  status === "done"
    ? "text-emerald-700 dark:text-emerald-400"
    : status === "failed"
      ? "text-[var(--danger)]"
      : status === "pending" || status === "running"
        ? "text-amber-700 dark:text-amber-300"
        : "text-[var(--text-soft)]";

const KIND_ICON: Record<GithubActionKind, typeof CircleDot> = { issue: CircleDot, comment: MessageSquare, pull_request: GitPullRequestArrow };

const timeLeft = (until: number) => {
  const minutes = Math.max(0, Math.round((until - Date.now()) / 60_000));
  return minutes >= 120 ? `${Math.round(minutes / 60)} hours` : minutes >= 60 ? "1 hour" : `${minutes} minutes`;
};

/**
 * A GitHub change VESPER prepared (v0.13.0): exactly what will be sent, with Approve / Reject. Nothing is sent before
 * Approve. The card loads the change's current state, so it is right after a reload or on another device too.
 */
export function GithubActionCard({ action: ref }: { action: GithubActionRefDto }) {
  const [action, setAction] = useState<GithubActionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const load = useCallback(() => {
    api.githubAction(ref.id).then(
      (r) => setAction(r.action),
      (e: unknown) => setError(e instanceof ApiError && e.status === 404 ? "This change is no longer available." : "Couldn't load this change."),
    );
  }, [ref.id]);
  useEffect(load, [load]);
  // Sending right now (e.g. approved in another tab): look again shortly.
  useEffect(() => {
    if (action?.status !== "running") return;
    const timer = setTimeout(load, 2_000);
    return () => clearTimeout(timer);
  }, [action, load]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      const r = decision === "approve" ? await api.approveGithubAction(ref.id) : await api.rejectGithubAction(ref.id);
      setAction(r.action);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
      load();
    } finally {
      setBusy(null);
    }
  };

  const Icon = KIND_ICON[ref.kind];
  const status = action?.status ?? null;
  return (
    <section
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm shadow-[var(--shadow-sm)]"
      aria-label={`${ACTION_KIND_LABEL[ref.kind]} in ${ref.repo}`}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] px-3.5 py-2.5">
        <Icon size={15} className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium">{ACTION_KIND_LABEL[ref.kind]}</span>
        <span className="text-[var(--text-soft)]">in {ref.repo}</span>
        {action?.publicRepo ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-soft)]" title="Anyone can see what is sent here">
            <Globe size={10} /> Public repository
          </span>
        ) : null}
        <span className={`ml-auto text-xs font-medium ${status ? actionStatusTone(status) : "text-[var(--text-soft)]"}`} aria-live="polite">
          {status ? ACTION_STATUS_LABEL[status] : "Loading…"}
        </span>
      </header>

      <div className="space-y-3 px-3.5 py-3">
        {/* Cautions matter only before deciding. */}
        {(status === "pending" ? (action?.warnings ?? []) : []).map((w) => (
          <div key={w} className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}

        {action?.preview ? <Preview action={action} /> : <p className="font-medium">{ref.title}</p>}

        {status === "done" && action?.resultUrl ? (
          <a href={action.resultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline">
            Open on GitHub <ExternalLink size={13} />
          </a>
        ) : null}
        {status === "failed" && action?.error ? <p className="text-[var(--danger)]">{action.error}</p> : null}
        {status === "rejected" ? <p className="text-[var(--text-soft)]">Nothing was sent to GitHub.</p> : null}
        {status === "expired" ? <p className="text-[var(--text-soft)]">Not approved in time, so nothing was sent. Ask VESPER to prepare it again if you still want it.</p> : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}

        {status === "pending" && action ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => decide("approve")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-60"
            >
              {busy === "approve" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve and send
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => decide("reject")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3.5 py-2 hover:bg-[var(--bg-hover)] disabled:opacity-60"
            >
              {busy === "reject" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Reject
            </button>
            <span className="text-xs text-[var(--text-soft)]">Nothing is sent until you approve · expires in {timeLeft(action.expiresAt)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Exactly what will be sent: title and text, the comment's target, or every changed line of a pull request. */
function Preview({ action }: { action: GithubActionDto }) {
  const p = action.preview!;
  return (
    <div className="space-y-2.5">
      {p.target ? (
        <p className="text-[var(--text-soft)]">
          On {p.target.kind === "pr" ? "pull request" : "issue"}{" "}
          <a href={p.target.url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
            #{p.target.number}
          </a>
          {p.target.title ? `: ${p.target.title}` : ""}
        </p>
      ) : null}
      {p.base && p.branch ? (
        <p className="text-xs text-[var(--text-soft)]">
          New branch <code className="rounded bg-[var(--bg-soft)] px-1">{p.branch}</code> from <code className="rounded bg-[var(--bg-soft)] px-1">{p.base}</code>,
          then a pull request into <code className="rounded bg-[var(--bg-soft)] px-1">{p.base}</code>. Nothing is merged.
        </p>
      ) : null}
      {p.title ? (
        <div>
          <p className="text-xs text-[var(--text-soft)]">Title</p>
          <p className="font-medium [overflow-wrap:anywhere]">{p.title}</p>
        </div>
      ) : null}
      {p.body || action.kind !== "pull_request" ? (
        <div>
          <p className="text-xs text-[var(--text-soft)]">{action.kind === "comment" ? "Comment" : "Description"}</p>
          <pre className="thin-scroll mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-soft)] px-3 py-2 font-sans text-[13px] [overflow-wrap:anywhere]">
            {p.body || "(empty)"}
          </pre>
        </div>
      ) : null}
      {p.files?.length ? (
        <div className="space-y-2">
          <p className="text-xs text-[var(--text-soft)]">
            {p.files.length} file{p.files.length === 1 ? "" : "s"} changed · every changed line is shown
          </p>
          {p.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const lineTone = (line: string) =>
  line.startsWith("@@")
    ? "text-[var(--text-faint)]"
    : line.startsWith("+")
      ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
      : line.startsWith("-")
        ? "bg-red-500/10 text-red-800 dark:text-red-300"
        : "text-[var(--text-soft)]";

function FileDiff({ file }: { file: GithubActionFileDto }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-soft)] px-3 py-1.5 text-xs">
        <code className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.path}
        </code>
        {file.status === "added" ? <span className="text-[var(--text-soft)]">new file</span> : null}
        <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
        <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
      </div>
      <pre className="thin-scroll max-h-80 overflow-auto py-1 font-mono text-[12px] leading-[1.55]">
        {file.diff.split("\n").map((line, i) => (
          <div key={i} className={`whitespace-pre px-3 ${lineTone(line)}`}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
