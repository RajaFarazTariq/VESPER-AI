import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { PublicConfigDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { createSession, deleteSession } from "../db/sessions";
import { upsertGithubUser } from "../db/users";
import { getConfig } from "../env";
import { randomToken, safeEqual } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { clearSessionCookie, getSessionToken, requireUser, setSessionCookie } from "../middleware/auth";
import { clientIp, rateLimit } from "../middleware/security";

const STATE_COOKIE = "oauth_state";
const STATE_TTL_SECONDS = 600;

const authLimiter = rateLimit("auth", 30, 10 * 60 * 1000, (c) => clientIp(c.req));

const isLocalhost = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

const callbackUrl = (c: Context) => `${new URL(c.req.url).origin}/api/auth/github/callback`;

/** Send the browser back to the app with an error code the UI can explain. */
const failRedirect = (c: Context, code: string) => c.redirect(`/?auth_error=${encodeURIComponent(code)}`, 302);

export const authRoutes = new Hono<AppEnv>()
  .get("/config", (c) => {
    const config = getConfig(c.env);
    const body: PublicConfigDto = {
      appName: config.appName,
      githubLogin: config.githubLoginEnabled,
      devLogin: config.devLogin && isLocalhost(c.req.url),
    };
    return c.json(body);
  })

  .get("/github/login", authLimiter, (c) => {
    const config = getConfig(c.env);
    if (!config.githubLoginEnabled) return failRedirect(c, "github_not_configured");
    const state = randomToken(24);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      path: "/api/auth/github",
      maxAge: STATE_TTL_SECONDS,
    });
    const url = new URL(`${config.githubOAuthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callbackUrl(c));
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    // No scopes: we only need the public profile to identify you.
    return c.redirect(url.toString(), 302);
  })

  .get("/github/callback", authLimiter, async (c) => {
    const config = getConfig(c.env);
    if (!config.githubLoginEnabled) return failRedirect(c, "github_not_configured");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/auth/github" });
    if (c.req.query("error")) return failRedirect(c, "github_denied");
    if (!code || !state || !expectedState || !safeEqual(state, expectedState)) return failRedirect(c, "invalid_state");

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
          redirect_uri: callbackUrl(c),
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

    if (!config.allowedGithubUsers.has(profile.login.toLowerCase())) {
      console.warn(JSON.stringify({ msg: "login rejected: not on allowlist", login: profile.login }));
      return failRedirect(c, "not_allowed");
    }

    const user = await upsertGithubUser(c.env.DB, {
      githubId: profile.id,
      login: profile.login,
      name: profile.name ?? null,
      avatarUrl: profile.avatar_url ?? null,
    });
    const session = await createSession(c.env.DB, user.id, config.sessionTtlMs, c.req.header("user-agent") ?? null);
    setSessionCookie(c, session.token, session.expiresAt);
    return c.redirect("/", 302);
  })

  /** Local development only: sign in as an allow-listed user without GitHub. */
  .post("/dev-login", authLimiter, async (c) => {
    const config = getConfig(c.env);
    if (!config.devLogin || !isLocalhost(c.req.url)) throw new AppError(404, "not_found", "Not found.");
    const { login } = await parseJson(c, z.object({ login: z.string().trim().min(1).max(39) }));
    if (!config.allowedGithubUsers.has(login.toLowerCase())) {
      throw new AppError(403, "not_allowed", "That username is not in ALLOWED_GITHUB_USERS.");
    }
    // Stable fake GitHub id derived from the login so repeated dev logins reuse the same user.
    let hash = 0;
    for (const ch of login.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const user = await upsertGithubUser(c.env.DB, { githubId: -1 - hash, login, name: login, avatarUrl: null });
    const session = await createSession(c.env.DB, user.id, config.sessionTtlMs, c.req.header("user-agent") ?? null);
    setSessionCookie(c, session.token, session.expiresAt);
    return c.json({ user });
  })

  .post("/logout", async (c) => {
    const token = getSessionToken(c);
    if (token) await deleteSession(c.env.DB, token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })

  .get("/me", requireUser, (c) => {
    const { settings, ...user } = c.get("user");
    return c.json({ user, settings });
  });
