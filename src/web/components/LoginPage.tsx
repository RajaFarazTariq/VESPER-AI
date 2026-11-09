import { useState } from "react";
import type { PublicConfigDto } from "../../shared/types";
import { api, ApiError } from "../api/client";

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const AUTH_ERRORS: Record<string, string> = {
  not_allowed: "That GitHub account isn't allowed to use this assistant. Ask the owner to add your username to ALLOWED_GITHUB_USERS.",
  invalid_state: "The sign-in link expired or was already used. Please try again.",
  github_denied: "GitHub sign-in was cancelled.",
  github_not_configured: "GitHub sign-in isn't configured on the server yet (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).",
  github_exchange_failed: "GitHub rejected the sign-in. Check the OAuth app's client secret and callback URL.",
  github_profile_failed: "Couldn't read your GitHub profile. Please try again.",
  github_unreachable: "Couldn't reach GitHub. Please try again in a moment.",
};

export function LoginPage({ config, onSignedIn }: { config: PublicConfigDto; onSignedIn: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");
  const [devName, setDevName] = useState("");
  const [devError, setDevError] = useState<string | null>(null);

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-8 shadow-sm">
        <img src="/favicon.svg" alt="" className="mx-auto h-12 w-12" />
        <h1 className="mt-4 text-center text-2xl font-semibold">{config.appName}</h1>
        <p className="mt-2 text-center text-sm text-[var(--text-soft)]">Your private multi-model AI assistant, running on free tiers.</p>

        {authError ? (
          <p role="alert" className="mt-5 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
            {AUTH_ERRORS[authError] ?? "Sign-in failed. Please try again."}
          </p>
        ) : null}

        {config.githubLogin ? (
          <a
            href="/api/auth/github/login"
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#24292f] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#32383f] dark:bg-white dark:text-[#24292f] dark:hover:bg-gray-200"
          >
            <GitHubMark /> Continue with GitHub
          </a>
        ) : (
          <p className="mt-6 rounded-lg bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--text-soft)]">
            GitHub sign-in isn't configured yet. Set <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code> and{" "}
            <code>ALLOWED_GITHUB_USERS</code> on the server (see the README).
          </p>
        )}

        {config.devLogin ? (
          <form
            className="mt-6 border-t border-[var(--border)] pt-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setDevError(null);
              try {
                await api.devLogin(devName.trim());
                window.history.replaceState(null, "", "/");
                onSignedIn();
              } catch (error) {
                setDevError(error instanceof ApiError ? error.message : "Login failed.");
              }
            }}
          >
            <label className="block text-xs font-medium text-[var(--text-soft)]" htmlFor="dev-login">
              Local development login (localhost only)
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="dev-login"
                value={devName}
                onChange={(e) => setDevName(e.target.value)}
                placeholder="allowed GitHub username"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <button type="submit" className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-text)]">
                Sign in
              </button>
            </div>
            {devError ? <p className="mt-2 text-xs text-[var(--danger)]">{devError}</p> : null}
          </form>
        ) : null}
      </div>
    </main>
  );
}
