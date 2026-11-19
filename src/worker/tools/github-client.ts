/**
 * One user's GitHub access through the VESPER GitHub App (read-only, v0.12.0).
 *
 * - Tokens are stored encrypted (lib/secret-box) and never logged, sent to the browser or shown to the model.
 * - GitHub's user tokens expire after 8 hours; the refresh token renews them, and works only once. So only one
 *   renewal per user runs at a time (a short database lock); anyone else waits for the new token. If GitHub says
 *   the access is gone (removed by the user, app uninstalled, refresh token expired), the connection is marked
 *   "reconnect" and the user sees "Reconnect GitHub".
 * - Responses are cached per user for at most 15 minutes. Within 2 minutes they're reused as they are; after that
 *   GitHub is asked again with the ETag, and an unchanged answer ("304 Not Modified") doesn't use the allowance.
 * - At most 10 GitHub requests per message (Cloudflare's free plan allows 50 outbound requests per request, and the
 *   models, web search and the database need the rest).
 */
import type { Env } from "../env";
import { getConfig } from "../env";
import {
  getGithubCache,
  getGithubConnection,
  lockGithubRefresh,
  markGithubReconnect,
  putGithubCache,
  saveRefreshedTokens,
  unlockGithubRefresh,
  type GithubConnectionRow,
} from "../db/github";
import { sha256Hex } from "../lib/crypto";
import { seal, unseal } from "../lib/secret-box";
import { ToolInputError, type GithubAccess } from "./types";

export const GITHUB_CALLS_PER_MESSAGE = 10;
const FRESH_MS = 2 * 60_000;
const CACHE_MS = 15 * 60_000;
const MAX_CACHED_BODY = 200_000;
/** Renew a little before GitHub's expiry. */
const RENEW_MARGIN_MS = 60_000;

export type GithubErrorCode = "reconnect" | "not_found" | "sso" | "rate_limited" | "forbidden" | "invalid" | "call_limit" | "unavailable";

/** A GitHub problem, in words the model can pass on to the user. */
export class GithubError extends ToolInputError {
  constructor(
    readonly code: GithubErrorCode,
    message: string,
    readonly resource: string | null = null,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export const RECONNECT_MESSAGE =
  "GitHub access for VESPER was removed or has expired. Tell the user to reconnect GitHub in Settings → Connections.";

export interface TokenSet {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

/** github.com page where a user picks which repos VESPER may read. */
export const githubInstallUrl = (env: Env) => `https://github.com/apps/${env.GITHUB_APP_SLUG?.trim()}/installations/new`;

/** Exchange an authorization code, or renew with a refresh token. GitHub reports errors in a 200 response. */
export async function githubTokenRequest(
  env: Env,
  grant: { code: string; redirectUri: string } | { refreshToken: string },
  userAgent: string,
  now = Date.now(),
): Promise<TokenSet> {
  const config = getConfig(env);
  const body =
    "code" in grant
      ? { client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code: grant.code, redirect_uri: grant.redirectUri }
      : { client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: grant.refreshToken };
  let json: { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
  try {
    const response = await fetch(`${config.githubOAuthBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify(body),
    });
    json = (await response.json()) as typeof json;
    if (!response.ok && !json.error) json.error = `http_${response.status}`;
  } catch {
    throw new GithubError("unavailable", "GitHub couldn't be reached. Try again in a minute.");
  }
  if (json.error || !json.access_token) {
    // bad_refresh_token / bad_verification_code / unauthorized: the access is gone.
    throw new GithubError(json.error === "incorrect_client_credentials" ? "unavailable" : "reconnect", RECONNECT_MESSAGE);
  }
  return {
    accessToken: json.access_token,
    // Tokens without an expiry (when expiry is switched off in the app) are treated as valid for a year.
    accessExpiresAt: now + (json.expires_in ? json.expires_in * 1000 : 365 * 86_400_000),
    refreshToken: json.refresh_token ?? null,
    refreshExpiresAt: json.refresh_token_expires_in ? now + json.refresh_token_expires_in * 1000 : null,
  };
}

const validGithubUrl = (url: unknown): url is string => typeof url === "string" && /^https:\/\/github\.com\/[^\s<>"']*$/.test(url);

export interface GithubAccessOptions {
  env: Env;
  db: D1Database;
  userId: string;
  userAgent: string;
  signal?: AbortSignal;
  maxCalls?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The user's GitHub access for one message (nothing is read until a tool needs it). */
export function githubAccess(options: GithubAccessOptions): GithubAccess {
  const { env, db, userId } = options;
  const config = getConfig(env);
  const key = env.GITHUB_TOKEN_KEY!.trim();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxCalls = options.maxCalls ?? GITHUB_CALLS_PER_MESSAGE;
  const memos = new Map<string, Promise<unknown>>();
  let calls = 0;
  let token: Promise<string> | null = null;

  const reconnect = async (): Promise<never> => {
    await markGithubReconnect(db, userId).catch(() => {});
    throw new GithubError("reconnect", RECONNECT_MESSAGE);
  };

  async function currentToken(): Promise<string> {
    const row = await getGithubConnection(db, userId);
    if (!row || row.status !== "connected") throw new GithubError("reconnect", RECONNECT_MESSAGE);
    if (row.access_expires_at - now() > RENEW_MARGIN_MS) return unseal(key, row.access_token, userId);
    return renew(row);
  }

  async function renew(row: GithubConnectionRow): Promise<string> {
    if (!row.refresh_token || (row.refresh_expires_at !== null && row.refresh_expires_at <= now())) return reconnect();
    if (await lockGithubRefresh(db, userId, row.access_expires_at, now())) {
      let fresh: TokenSet;
      try {
        fresh = await githubTokenRequest(env, { refreshToken: await unseal(key, row.refresh_token, userId) }, options.userAgent, now());
      } catch (error) {
        if (error instanceof GithubError && error.code === "reconnect") return reconnect();
        await unlockGithubRefresh(db, userId).catch(() => {});
        throw error;
      }
      await saveRefreshedTokens(db, userId, {
        accessToken: await seal(key, fresh.accessToken, userId),
        accessExpiresAt: fresh.accessExpiresAt,
        refreshToken: fresh.refreshToken ? await seal(key, fresh.refreshToken, userId) : null,
        refreshExpiresAt: fresh.refreshExpiresAt,
      });
      return fresh.accessToken;
    }
    // Another request is renewing right now: wait for its new token (a few seconds at most).
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      const latest = await getGithubConnection(db, userId);
      if (!latest || latest.status !== "connected") throw new GithubError("reconnect", RECONNECT_MESSAGE);
      if (latest.access_expires_at !== row.access_expires_at) return unseal(key, latest.access_token, userId);
      if (latest.refreshing_until === null) return renew(latest); // the other renewal gave up: try ourselves
    }
    throw new GithubError("unavailable", "GitHub access is being renewed. Try again in a moment.");
  }

  async function failure(response: Response): Promise<never> {
    const sso = response.headers.get("x-github-sso");
    if (sso) {
      const url = /url=(\S+)/.exec(sso)?.[1];
      throw new GithubError(
        "sso",
        "This organisation uses single sign-on (SSO): the user must allow VESPER for it on GitHub" +
          (validGithubUrl(url) ? ` (${url})` : "") +
          ", then ask again.",
      );
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resource = response.headers.get("x-ratelimit-resource");
    let message = "";
    try {
      message = String(((await response.json()) as { message?: unknown }).message ?? "");
    } catch {
      message = "";
    }
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || /rate limit/i.test(message)))) {
      throw new GithubError(
        "rate_limited",
        resource === "code_search" ? "GitHub's code search limit (10 a minute) is used up for now." : "GitHub's request limit is used up for now. Try again in a few minutes.",
        resource,
      );
    }
    if (response.status === 403) throw new GithubError("forbidden", "GitHub refused access: VESPER can only read the repositories the user chose.");
    if (response.status === 404) throw new GithubError("not_found", "Not found on GitHub.");
    if (response.status === 422) throw new GithubError("invalid", message ? `GitHub couldn't do that: ${message.slice(0, 200)}` : "GitHub couldn't do that.");
    throw new GithubError("unavailable", `GitHub answered with an error (${response.status}). Try again in a minute.`);
  }

  const access: GithubAccess = {
    installUrl: githubInstallUrl(env),

    memo<T>(memoKey: string, load: () => Promise<T>): Promise<T> {
      let value = memos.get(memoKey) as Promise<T> | undefined;
      if (!value) {
        value = load();
        memos.set(memoKey, value);
        value.catch(() => memos.delete(memoKey));
      }
      return value;
    },

    async get(path, opts = {}) {
      const accept = opts.accept ?? "application/vnd.github+json";
      const cacheKey = await sha256Hex(`${accept} ${path}`);
      const t = now();
      const cached = await getGithubCache(db, userId, cacheKey, t);
      if (cached && cached.fresh_until > t) return { body: cached.body, headers: null };
      if (calls >= maxCalls) {
        throw new GithubError("call_limit", `This answer already used its ${maxCalls} GitHub look-ups. Answer with what you have, or tell the user to ask a follow-up.`);
      }
      calls++;
      token ??= currentToken();
      token.catch(() => (token = null));
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": options.userAgent,
      };
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      let response: Response;
      try {
        response = await fetch(`${config.githubApiBaseUrl}${path}`, { headers, ...(options.signal ? { signal: options.signal } : {}) });
      } catch {
        throw new GithubError("unavailable", "GitHub couldn't be reached. Try again in a minute.");
      }
      if (response.status === 304 && cached) {
        await putGithubCache(db, userId, cacheKey, { ...cached, fresh_until: t + (opts.fresh ?? FRESH_MS) }, t).catch(() => {});
        return { body: cached.body, headers: response.headers };
      }
      if (response.status === 401) return reconnect();
      if (!response.ok) return failure(response);
      const body = await response.text();
      if (body.length <= MAX_CACHED_BODY) {
        await putGithubCache(
          db,
          userId,
          cacheKey,
          { etag: response.headers.get("etag"), body, fresh_until: t + (opts.fresh ?? FRESH_MS), expires_at: t + CACHE_MS },
          t,
        ).catch(() => {});
      }
      return { body, headers: response.headers };
    },

    async explainNoAccess(repo) {
      const owner = repo.split("/")[0] ?? repo;
      let installations: { account?: { login?: string }; repository_selection?: string; html_url?: string }[] = [];
      try {
        installations = (JSON.parse((await access.get("/user/installations?per_page=100")).body) as { installations?: typeof installations }).installations ?? [];
      } catch (error) {
        if (error instanceof GithubError && error.code === "reconnect") throw error;
        return `${repo} couldn't be opened on GitHub. Check the owner/name, or the repositories the user chose for VESPER (${access.installUrl}).`;
      }
      const match = installations.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
      if (!match) {
        return (
          `VESPER hasn't been given access to ${owner}'s repositories. If ${owner} is an organisation, an owner of the ` +
          `organisation must approve VESPER: the user chooses ${owner} on ${access.installUrl} and GitHub sends the ` +
          `organisation's owners a request; it works once they approve. If ${owner} is the user's own account, they can ` +
          `add the repository on that page.`
        );
      }
      if (match.repository_selection === "selected") {
        return `${repo} isn't one of the repositories the user chose for VESPER. They can add it on GitHub: ${validGithubUrl(match.html_url) ? match.html_url : access.installUrl}`;
      }
      return `${repo} wasn't found on GitHub. Check the owner/name spelling.`;
    },
  };
  return access;
}

/** Whether the user has a working connection (no GitHub request is made). */
export async function githubConnected(db: D1Database, userId: string): Promise<boolean> {
  const row = await getGithubConnection(db, userId);
  return row?.status === "connected";
}
