import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-env";
import { getSessionUser } from "../db/sessions";
import { getConfig } from "../env";
import { unauthorized } from "../lib/errors";

const SECURE_COOKIE = "__Host-sid";
const LOCAL_COOKIE = "sid";

const isHttps = (c: Context) => new URL(c.req.url).protocol === "https:";

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SECURE_COOKIE) ?? getCookie(c, LOCAL_COOKIE);
}

/** Session cookie: HttpOnly, SameSite=Lax, and `__Host-` + Secure whenever served over HTTPS. */
export function setSessionCookie(c: Context, token: string, expiresAt: number): void {
  const secure = isHttps(c);
  setCookie(c, secure ? SECURE_COOKIE : LOCAL_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SECURE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, LOCAL_COOKIE, { path: "/" });
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getSessionToken(c);
  if (!token) throw unauthorized();
  const config = getConfig(c.env);
  const session = await getSessionUser(c.env.DB, token, config.sessionTtlMs);
  if (!session) {
    clearSessionCookie(c);
    throw unauthorized();
  }
  // Re-check the allowlist on every request so removing a username revokes access immediately.
  if (!config.allowedGithubUsers.has(session.user.login.toLowerCase())) {
    clearSessionCookie(c);
    throw unauthorized();
  }
  if (session.refreshedExpiry) setSessionCookie(c, token, session.refreshedExpiry);
  c.set("user", session.user);
  await next();
};
