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

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const AUTH_ERRORS: Record<string, string> = {
  invalid_state: "The sign-in link expired or was already used. Please try again.",
  blocked: "This account has been blocked by the administrator.",
  signups_closed: "New sign-ups are closed at the moment. Existing accounts can still sign in.",
  google_denied: "Google sign-in was cancelled.",
  google_not_configured: "Google sign-in isn't configured on the server yet.",
  google_exchange_failed: "Google rejected the sign-in. Please try again.",
  google_profile_failed: "Couldn't read your Google profile. Please try again.",
  google_email_unverified: "Your Google account's email address isn't verified, so it can't be used to sign in.",
  google_unreachable: "Couldn't reach Google. Please try again in a moment.",
  github_admin_only: "GitHub sign-in is only for the administrator. Please continue with Google.",
  github_denied: "GitHub sign-in was cancelled.",
  github_not_configured: "GitHub sign-in isn't configured on the server yet.",
  github_exchange_failed: "GitHub rejected the sign-in. Check the OAuth app's client secret and callback URL.",
  github_profile_failed: "Couldn't read your GitHub profile. Please try again.",
  github_unreachable: "Couldn't reach GitHub. Please try again in a moment.",
};


// ---------------------------------------------------------------------------
// Brand panel (wide screens only): the logo inside fine orbit lines, one headline, one line of text.
// ---------------------------------------------------------------------------

function BrandPanel() {
  return (
    <aside className="auth-showcase relative hidden flex-1 items-center justify-center overflow-hidden lg:flex">
      <div className="relative flex flex-col items-center px-12 text-center">
        <div className="relative grid h-[340px] w-[340px] place-items-center" aria-hidden="true">
          <svg viewBox="0 0 340 340" className="absolute inset-0 h-full w-full">
            <circle className="auth-orbit auth-orbit-1" cx="170" cy="170" r="80" />
            <circle className="auth-orbit auth-orbit-2" cx="170" cy="170" r="124" />
            <circle className="auth-orbit auth-orbit-3" cx="170" cy="170" r="168" />
            <circle className="auth-planet" cx="263.5" cy="90.3" r="3.5" />
            <circle className="auth-planet auth-planet-faint" cx="25.7" cy="254" r="3" />
            <circle className="auth-planet auth-planet-faint" cx="94.8" cy="142.6" r="2.5" />
          </svg>
          <div className="auth-halo absolute h-[220px] w-[220px] rounded-full" />
          <img src="/favicon.svg" alt="" className="relative h-[88px] w-[88px] rounded-[22px] shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)]" />
        </div>
        <h2 className="mt-8 font-[family-name:var(--font-display)] text-[32px] font-semibold leading-tight tracking-[-0.025em]">
          Clear answers. Trusted sources.
        </h2>
        <p className="mt-3 max-w-[400px] text-balance text-[15px] leading-relaxed text-[var(--sc-soft)]">
          Research, live information and precise calculations, all in one assistant.
        </p>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

export function LoginPage({ config, onSignedIn }: { config: PublicConfigDto; onSignedIn: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");
  const [devName, setDevName] = useState("");
  const [devError, setDevError] = useState<string | null>(null);

  return (
    <div className="flex min-h-full bg-[var(--bg)] text-[var(--text)]">
      <main className="flex min-h-full w-full flex-col px-6 py-6 sm:px-10 lg:w-[540px] lg:shrink-0 lg:border-r lg:border-[var(--border)] lg:px-14 xl:w-[600px]">
        <header className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-lg" />
          <span className="text-[15px] font-semibold tracking-tight">{config.appName}</span>
        </header>

        <div className="flex flex-1 items-center py-12">
          <div className="mx-auto w-full max-w-[380px]">
            <h1 className="font-[family-name:var(--font-display)] text-[28px] font-semibold tracking-[-0.02em]">Sign in to {config.appName}</h1>
            <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--text-soft)]">
              New here? Your account is created automatically the first time you sign in.
            </p>

            {authError ? (
              <p role="alert" className="mt-6 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3.5 py-2.5 text-sm text-[var(--danger)]">
                {AUTH_ERRORS[authError] ?? "Sign-in failed. Please try again."}
              </p>
            ) : null}

            {config.googleLogin ? (
              <a
                href="/api/auth/google/login"
                className="mt-8 flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-4 text-[14.5px] font-medium shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <GoogleMark /> Continue with Google
              </a>
            ) : null}

            {config.githubLogin ? (
              config.googleLogin ? (
                <p className="mt-4 text-center text-[13px] text-[var(--text-soft)]">
                  Administrator?{" "}
                  <a href="/api/auth/github/login" className="font-medium text-[var(--accent)] hover:underline">
                    Sign in with GitHub
                  </a>
                </p>
              ) : (
                <a
                  href="/api/auth/github/login"
                  className="mt-8 flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-4 text-[14.5px] font-medium shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <GitHubMark /> Continue with GitHub (administrators)
                </a>
              )
            ) : null}

            {!config.googleLogin && !config.githubLogin ? (
              <p className="mt-8 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-3.5 py-2.5 text-sm text-[var(--text-soft)]">
                Sign-in isn't configured yet. Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (and optionally the GitHub
                ones) on the server. See the README.
              </p>
            ) : null}

            {config.devLogin ? (
              <form
                className="mt-8 rounded-lg border border-dashed border-[var(--border-strong)] p-4"
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
                <div className="mt-2 flex gap-2">
                  <input
                    id="dev-login"
                    value={devName}
                    onChange={(e) => setDevName(e.target.value)}
                    placeholder="any username"
                    className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="submit"
                    className="h-10 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-strong)]"
                  >
                    Sign in
                  </button>
                </div>
                {devError ? <p className="mt-2 text-xs text-[var(--danger)]">{devError}</p> : null}
              </form>
            ) : null}
          </div>
        </div>

        <footer className="text-xs text-[var(--text-faint)]">
          © {new Date().getFullYear()} {config.appName}
        </footer>
      </main>

      <BrandPanel />
    </div>
  );
}
