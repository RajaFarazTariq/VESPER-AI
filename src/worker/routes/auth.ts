import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { PublicConfigDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { createSession, deleteSession } from "../db/sessions";
import {
  createUser,
  findGithubOnlyUsers,
  findGoogleOnlyUsers,
  findUnlinkedByEmail,
  findUserByGithubId,
  findUserByGoogleSub,
  roleOf,
  toUserDto,
  updateUser,
  type UserRow,
} from "../db/users";
import { getConfig, type AppConfig } from "../env";
import { randomToken, safeEqual } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { clearSessionCookie, getSessionToken, requireUser, setSessionCookie } from "../middleware/auth";
import { clientIp, rateLimit } from "../middleware/security";

type Provider = "github" | "google";

const STATE_COOKIE: Record<Provider, string> = { github: "oauth_state", google: "oauth_state_google" };
const STATE_TTL_SECONDS = 600;

const authLimiter = rateLimit("auth", 30, 10 * 60 * 1000, (c) => clientIp(c.req));

const isLocalhost = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

const callbackUrl = (c: Context, provider: Provider) => `${new URL(c.req.url).origin}/api/auth/${provider}/callback`;

/** Send the browser back to the app with an error code the UI can explain. */
const failRedirect = (c: Context, code: string) => c.redirect(`/?auth_error=${encodeURIComponent(code)}`, 302);

const httpsUrlOrNull = (value: unknown) => (typeof value === "string" && value.startsWith("https://") && value.length <= 1000 ? value : null);

/** Random state in a short-lived cookie scoped to the provider's callback path (CSRF protection). */
function issueState(c: Context, provider: Provider): string {
  const state = randomToken(24);
  setCookie(c, STATE_COOKIE[provider], state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: `/api/auth/${provider}`,
    maxAge: STATE_TTL_SECONDS,
  });
  return state;
}

function checkState(c: Context, provider: Provider): boolean {
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE[provider]);
  deleteCookie(c, STATE_COOKIE[provider], { path: `/api/auth/${provider}` });
  return Boolean(state && expected && safeEqual(state, expected));
}

async function startSession(c: Context<AppEnv>, user: UserRow) {
  const config = getConfig(c.env);
  const session = await createSession(c.env.DB, user.id, config.sessionTtlMs, c.req.header("user-agent") ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
}

type SignIn = { ok: true; user: UserRow } | { ok: false; code: string };

const blockedCheck = (config: AppConfig, user: UserRow): SignIn =>
  user.status === "blocked" && roleOf(config, user) !== "admin" ? { ok: false, code: "blocked" } : { ok: true, user };

/**
 * GitHub sign-in (admins only). Links to the admin's existing Google account when there is
 * exactly one Google-only admin account, so both sign-in methods open the same account.
 */
async function signInGithub(
  db: D1Database,
  config: AppConfig,
  profile: { id: number; login: string; name: string | null; avatarUrl: string | null },
): Promise<SignIn> {
  if (!config.adminGithubUsers.has(profile.login.toLowerCase())) return { ok: false, code: "github_admin_only" };
  const now = Date.now();
  const existing = await findUserByGithubId(db, profile.id);
  if (existing) {
    const updated = await updateUser(db, existing.id, {
      github_login: profile.login,
      login: profile.login,
      name: profile.name ?? existing.name,
      avatar_url: profile.avatarUrl ?? existing.avatar_url,
      last_login_at: now,
    });
    return blockedCheck(config, updated ?? existing);
  }
  const adminGoogleAccounts = (await findGoogleOnlyUsers(db)).filter((u) => roleOf(config, u) === "admin");
  if (adminGoogleAccounts.length === 1) {
    const target = adminGoogleAccounts[0]!;
    const linked = await updateUser(db, target.id, {
      github_id: profile.id,
      github_login: profile.login,
      login: profile.login,
      name: target.name ?? profile.name,
      avatar_url: profile.avatarUrl ?? target.avatar_url,
      last_login_at: now,
    });
    return { ok: true, user: linked ?? target };
  }
  const created = await createUser(db, {
    githubId: profile.id,
    githubLogin: profile.login,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  });
  return { ok: true, user: created };
}

/**
 * Google sign-in (everyone). Order: same Google account → an unlinked account with the same
 * verified email → (admin email only) the admin's existing GitHub account → a new account.
 */
async function signInGoogle(
  db: D1Database,
  config: AppConfig,
  profile: { sub: string; email: string; name: string | null; avatarUrl: string | null },
): Promise<SignIn> {
  const now = Date.now();
  const isAdminEmail = config.adminEmails.has(profile.email);
  const existing = await findUserByGoogleSub(db, profile.sub);
  if (existing) {
    const hasGithub = existing.github_login !== null;
    const updated = await updateUser(db, existing.id, {
      email: profile.email,
      ...(hasGithub ? {} : { login: profile.email }),
      name: hasGithub ? (existing.name ?? profile.name) : (profile.name ?? existing.name),
      avatar_url: hasGithub ? (existing.avatar_url ?? profile.avatarUrl) : (profile.avatarUrl ?? existing.avatar_url),
      last_login_at: now,
    });
    return blockedCheck(config, updated ?? existing);
  }

  let target: UserRow | null = null;
  const sameEmail = await findUnlinkedByEmail(db, profile.email);
  if (sameEmail.length === 1) target = sameEmail[0]!;
  else if (sameEmail.length === 0 && isAdminEmail) {
    const adminGithubAccounts = (await findGithubOnlyUsers(db)).filter((u) => roleOf(config, u) === "admin");
    if (adminGithubAccounts.length === 1) target = adminGithubAccounts[0]!;
  }
  if (target) {
    const linked = await updateUser(db, target.id, {
      google_sub: profile.sub,
      email: profile.email,
      name: target.name ?? profile.name,
      avatar_url: target.avatar_url ?? profile.avatarUrl,
      last_login_at: now,
    });
    return blockedCheck(config, linked ?? target);
  }

  if (!isAdminEmail && !(await getAppSettings(db, config)).signupsOpen) return { ok: false, code: "signups_closed" };
  const created = await createUser(db, {
    googleSub: profile.sub,
    email: profile.email,
    login: profile.email,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  });
  return { ok: true, user: created };
}

export const authRoutes = new Hono<AppEnv>()
  .get("/config", (c) => {
    const config = getConfig(c.env);
    const body: PublicConfigDto = {
      appName: config.appName,
      githubLogin: config.githubLoginEnabled,
      googleLogin: config.googleLoginEnabled,
      devLogin: config.devLogin && isLocalhost(c.req.url),
    };
    return c.json(body);
  })

  // ---------------------------------------------------------------- Google (everyone)
  .get("/google/login", authLimiter, (c) => {
    const config = getConfig(c.env);
    if (!config.googleLoginEnabled) return failRedirect(c, "google_not_configured");
    const url = new URL(`${config.googleOAuthBaseUrl}/o/oauth2/v2/auth`);
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callbackUrl(c, "google"));
    url.searchParams.set("response_type", "code");
    // Only basic sign-in scopes: your Google id, name, photo and verified email.
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", issueState(c, "google"));
    url.searchParams.set("prompt", "select_account");
    return c.redirect(url.toString(), 302);
  })

  .get("/google/callback", authLimiter, async (c) => {
    const config = getConfig(c.env);
    if (!config.googleLoginEnabled) return failRedirect(c, "google_not_configured");
    const validState = checkState(c, "google");
    if (c.req.query("error")) return failRedirect(c, "google_denied");
    const code = c.req.query("code");
    if (!code || !validState) return failRedirect(c, "invalid_state");

    let accessToken: string;
    try {
      const tokenResponse = await fetch(config.googleTokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: c.env.GOOGLE_CLIENT_ID!,
          client_secret: c.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl(c, "google"),
          grant_type: "authorization_code",
        }).toString(),
      });
      const tokenJson = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!tokenResponse.ok || !tokenJson.access_token) {
        console.warn(JSON.stringify({ msg: "google token exchange failed", status: tokenResponse.status, error: tokenJson.error }));
        return failRedirect(c, "google_exchange_failed");
      }
      accessToken = tokenJson.access_token;
    } catch (error) {
      console.error(JSON.stringify({ msg: "google token exchange error", error: String(error) }));
      return failRedirect(c, "google_unreachable");
    }

    let info: { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown };
    try {
      const response = await fetch(config.googleUserinfoUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      if (!response.ok) return failRedirect(c, "google_profile_failed");
      info = (await response.json()) as typeof info;
    } catch {
      return failRedirect(c, "google_unreachable");
    }
    if (typeof info.sub !== "string" || !info.sub || typeof info.email !== "string" || !info.email.includes("@")) {
      return failRedirect(c, "google_profile_failed");
    }
    if (info.email_verified !== true && info.email_verified !== "true") return failRedirect(c, "google_email_unverified");

    const result = await signInGoogle(c.env.DB, config, {
      sub: info.sub,
      email: info.email.trim().toLowerCase(),
      name: typeof info.name === "string" && info.name.trim() ? info.name.trim().slice(0, 200) : null,
      avatarUrl: httpsUrlOrNull(info.picture),
    });
    if (!result.ok) {
      console.warn(JSON.stringify({ msg: "google sign-in rejected", code: result.code }));
      return failRedirect(c, result.code);
    }
    await startSession(c, result.user);
    return c.redirect("/", 302);
  })

  // ---------------------------------------------------------------- GitHub (admins only)
  .get("/github/login", authLimiter, (c) => {
    const config = getConfig(c.env);
    if (!config.githubLoginEnabled) return failRedirect(c, "github_not_configured");
    const url = new URL(`${config.githubOAuthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callbackUrl(c, "github"));
    url.searchParams.set("state", issueState(c, "github"));
    url.searchParams.set("allow_signup", "false");
    // No scopes: the public profile is enough to identify the administrator.
    return c.redirect(url.toString(), 302);
  })

  .get("/github/callback", authLimiter, async (c) => {
    const config = getConfig(c.env);
    if (!config.githubLoginEnabled) return failRedirect(c, "github_not_configured");
    const validState = checkState(c, "github");
    if (c.req.query("error")) return failRedirect(c, "github_denied");
    const code = c.req.query("code");
    if (!code || !validState) return failRedirect(c, "invalid_state");

    const userAgent = `${config.appName.replace(/[^\w.-]/g, "") || "assistant"}-oauth`;
    let accessToken: string;
    try {
      const tokenResponse = await fetch(`${config.githubOAuthBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl(c, "github"),
        }),
      });
      const tokenJson = (await tokenResponse.json()) as { access_token?: string; error?: string };
      if (!tokenResponse.ok || !tokenJson.access_token) {
        console.warn(JSON.stringify({ msg: "github token exchange failed", status: tokenResponse.status, error: tokenJson.error }));
        return failRedirect(c, "github_exchange_failed");
      }
      accessToken = tokenJson.access_token;
    } catch (error) {
      console.error(JSON.stringify({ msg: "github token exchange error", error: String(error) }));
      return failRedirect(c, "github_unreachable");
    }

    let profile: { id: number; login: string; name: string | null; avatar_url: string | null };
    try {
      const userResponse = await fetch(`${config.githubApiBaseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
      });
      if (!userResponse.ok) return failRedirect(c, "github_profile_failed");
      profile = (await userResponse.json()) as typeof profile;
    } catch {
      return failRedirect(c, "github_unreachable");
    }
    if (typeof profile.id !== "number" || typeof profile.login !== "string") return failRedirect(c, "github_profile_failed");

    const result = await signInGithub(c.env.DB, config, {
      id: profile.id,
      login: profile.login,
      name: profile.name ?? null,
      avatarUrl: httpsUrlOrNull(profile.avatar_url),
    });
    if (!result.ok) {
      console.warn(JSON.stringify({ msg: "github sign-in rejected", code: result.code, login: profile.login }));
      return failRedirect(c, result.code);
    }
    await startSession(c, result.user);
    return c.redirect("/", 302);
  })

  /**
   * Local development only: sign in with just a username (no Google/GitHub). Usernames listed in
   * ADMIN_GITHUB_USERS become admins; any other name is a regular user (subject to sign-ups).
   */
  .post("/dev-login", authLimiter, async (c) => {
    const config = getConfig(c.env);
    if (!config.devLogin || !isLocalhost(c.req.url)) throw new AppError(404, "not_found", "Not found.");
    const { login } = await parseJson(c, z.object({ login: z.string().trim().min(1).max(39).regex(/^[\w.-]+$/, "Letters, digits, . _ - only") }));
    // Stable fake GitHub id in [-2^32, -1], derived from the login so repeated dev logins reuse the same user.
    let hash = 0;
    for (const ch of login.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const devId = -1 - hash;
    let user = await findUserByGithubId(c.env.DB, devId);
    if (user) {
      const blocked = blockedCheck(config, user);
      if (!blocked.ok) throw new AppError(403, "blocked", "This account has been blocked by the administrator.");
      user = (await updateUser(c.env.DB, user.id, { last_login_at: Date.now() })) ?? user;
    } else {
      const isAdmin = config.adminGithubUsers.has(login.toLowerCase());
      if (!isAdmin && !(await getAppSettings(c.env.DB, config)).signupsOpen) {
        throw new AppError(403, "signups_closed", "Sign-ups are closed.");
      }
      user = await createUser(c.env.DB, { githubId: devId, githubLogin: login, login, name: login, avatarUrl: null });
    }
    await startSession(c, user);
    return c.json({ user: toUserDto(user, config) });
  })

  .post("/logout", async (c) => {
    const token = getSessionToken(c);
    if (token) await deleteSession(c.env.DB, token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })

  .get("/me", requireUser, (c) => {
    const { settings, status: _status, dailyLimit: _limit, ...user } = c.get("user");
    return c.json({ user, settings });
  });
