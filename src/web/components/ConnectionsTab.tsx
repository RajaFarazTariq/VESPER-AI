import { AlertTriangle, ExternalLink, FolderGit2, Lock, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import type { GithubConnectionDto } from "../../shared/types";
import { api, ApiError } from "../api/client";

/** Settings → Connections (v0.12.0): the user's own GitHub, read-only. */
export function ConnectionsTab() {
  const [github, setGithub] = useState<GithubConnectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.connections().then(
      (r) => setGithub(r.github),
      (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't load your connections."),
    );
  }, []);

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!github) return <p className="text-sm text-[var(--text-soft)]">Loading…</p>;
  if (!github.available) return <p className="text-sm text-[var(--text-soft)]">GitHub isn't available for your account.</p>;

  const connect = (
    <a
      href="/api/connections/github/start"
      className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)]"
    >
      <FolderGit2 size={15} /> {github.status === "reconnect" ? "Reconnect GitHub" : "Connect GitHub"}
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
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3">
        <FolderGit2 size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="font-medium">GitHub</p>
          <p className="mt-0.5 text-[var(--text-soft)]">
            Ask about your own repositories in chat: explain code, find files, read issues and pull requests, review changes.{" "}
            <strong className="font-medium text-[var(--text)]">Read-only</strong>: VESPER can't change anything on GitHub.
          </p>
        </div>
      </div>

      {github.status === "none" ? (
        <div className="space-y-3">
          <p className="text-[var(--text-soft)]">GitHub asks you which repositories to allow (all, or only the ones you pick). You can change that or disconnect at any time.</p>
          {connect}
        </div>
      ) : null}

      {github.status === "reconnect" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>GitHub access{github.login ? ` for @${github.login}` : ""} was removed or has expired. Reconnect to keep using GitHub in chat.</span>
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
              <span>VESPER can't read any of your repositories yet: choose them on GitHub.</span>
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
                Repositories VESPER can read{github.reposTruncated ? " (first 100)" : ""}:
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
              onClick={async () => {
                setBusy(true);
                try {
                  setGithub((await api.disconnectGithub()).github);
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : "Couldn't disconnect.");
                } finally {
                  setBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--danger)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              <Unplug size={14} /> Disconnect
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg bg-[var(--bg-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
        <p className="font-medium text-[var(--text)]">Privacy</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>Your GitHub access is stored encrypted and is never shown to the AI model or anyone else.</li>
          <li>Code VESPER reads appears in your chat. Files are kept on the server for at most 15 minutes to save GitHub requests, then deleted.</li>
          <li>If you rate an answer 👍/👎, a copy of the question and answer goes to the administrator's feedback list.</li>
          <li>Disconnecting removes VESPER's access. To also remove the app from GitHub: GitHub → Settings → Applications.</li>
        </ul>
      </div>
    </div>
  );
}
