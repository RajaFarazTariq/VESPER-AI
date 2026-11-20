/**
 * One user's GitHub access through the VESPER GitHub App (read-only, v0.12.0), and through the separate Actions app
 * for changes the user approved (v0.13.0: githubWriter, no cache, used only by the approval flow).
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
  type GithubAppKind,
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

/** The two GitHub Apps: client id, secret and public slug of each. */
export function githubAppCredentials(env: Env, kind: GithubAppKind): { clientId: string; clientSecret: string; slug: string } {
  return kind === "actions"
    ? {
        clientId: env.GITHUB_ACTIONS_APP_CLIENT_ID?.trim() ?? "",
        clientSecret: env.GITHUB_ACTIONS_APP_CLIENT_SECRET?.trim() ?? "",
        slug: env.GITHUB_ACTIONS_APP_SLUG?.trim() ?? "",
      }
    : { clientId: env.GITHUB_APP_CLIENT_ID?.trim() ?? "", clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() ?? "", slug: env.GITHUB_APP_SLUG?.trim() ?? "" };
}

/**
 * What a stored token is bound to when encrypted: the user id for reading (as in v0.12.0), "actions:<id>" for the
 * Actions app, so a token from one table can't be used as the other.
 */
export const tokenOwner = (userId: string, kind: GithubAppKind) => (kind === "actions" ? `actions:${userId}` : userId);

/** github.com page where a user picks which repos VESPER may read (reader) or change (actions). */
export const githubInstallUrl = (env: Env, kind: GithubAppKind = "reader") =>
  `https://github.com/apps/${githubAppCredentials(env, kind).slug}/installations/new`;

/** Exchange an authorization code, or renew with a refresh token. GitHub reports errors in a 200 response. */
export async function githubTokenRequest(
  env: Env,
  grant: { code: string; redirectUri: string } | { refreshToken: string },
  userAgent: string,
  now = Date.now(),
  kind: GithubAppKind = "reader",
): Promise<TokenSet> {
  const config = getConfig(env);
  const app = githubAppCredentials(env, kind);
  const body =
    "code" in grant
      ? { client_id: app.clientId, client_secret: app.clientSecret, code: grant.code, redirect_uri: grant.redirectUri }
      : { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: grant.refreshToken };
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

export const ACTIONS_RECONNECT_MESSAGE =
  "VESPER's access for GitHub changes was removed or has expired. Tell the user to reconnect \"GitHub changes\" in Settings → Connections.";

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

/**
 * The user's access token for one of the two apps, renewed shortly before it expires. Only one renewal per user and
 * app runs at a time (GitHub's refresh tokens work once); anyone else waits for the new token.
 */
function tokenSource(options: GithubAccessOptions, kind: GithubAppKind) {
  const { env, db, userId } = options;
  const key = env.GITHUB_TOKEN_KEY!.trim();
  const owner = tokenOwner(userId, kind);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const gone = kind === "actions" ? ACTIONS_RECONNECT_MESSAGE : RECONNECT_MESSAGE;
  let token: Promise<string> | null = null;

  const reconnect = async (): Promise<never> => {
    await markGithubReconnect(db, userId, kind).catch(() => {});
    throw new GithubError("reconnect", gone);
  };

  async function currentToken(): Promise<string> {
    const row = await getGithubConnection(db, userId, kind);
    if (!row || row.status !== "connected") throw new GithubError("reconnect", gone);
    if (row.access_expires_at - now() > RENEW_MARGIN_MS) return unseal(key, row.access_token, owner);
    return renew(row);
  }

  async function renew(row: GithubConnectionRow): Promise<string> {
    if (!row.refresh_token || (row.refresh_expires_at !== null && row.refresh_expires_at <= now())) return reconnect();
    if (await lockGithubRefresh(db, userId, row.access_expires_at, now(), kind)) {
      let fresh: TokenSet;
      try {
        fresh = await githubTokenRequest(env, { refreshToken: await unseal(key, row.refresh_token, owner) }, options.userAgent, now(), kind);
      } catch (error) {
        if (error instanceof GithubError && error.code === "reconnect") return reconnect();
        await unlockGithubRefresh(db, userId, kind).catch(() => {});
        throw error;
      }
      await saveRefreshedTokens(
        db,
        userId,
        {
          accessToken: await seal(key, fresh.accessToken, owner),
          accessExpiresAt: fresh.accessExpiresAt,
          refreshToken: fresh.refreshToken ? await seal(key, fresh.refreshToken, owner) : null,
          refreshExpiresAt: fresh.refreshExpiresAt,
        },
        kind,
      );
      return fresh.accessToken;
    }
    // Another request is renewing right now: wait for its new token (a few seconds at most).
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      const latest = await getGithubConnection(db, userId, kind);
      if (!latest || latest.status !== "connected") throw new GithubError("reconnect", gone);
      if (latest.access_expires_at !== row.access_expires_at) return unseal(key, latest.access_token, owner);
      if (latest.refreshing_until === null) return renew(latest); // the other renewal gave up: try ourselves
    }
    throw new GithubError("unavailable", "GitHub access is being renewed. Try again in a moment.");
  }

  return {
    reconnect,
    get(): Promise<string> {
      token ??= currentToken();
      token.catch(() => (token = null));
      return token;
    },
  };
}

/** A GitHub error response, in words the model (or the approval card) can pass on. */
async function githubFailure(response: Response, kind: GithubAppKind): Promise<never> {
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
  if (response.status === 403) {
    throw new GithubError(
      "forbidden",
      kind === "actions"
        ? "GitHub refused: VESPER can only change the repositories the user chose for changes, and only what their own GitHub account may change."
        : "GitHub refused access: VESPER can only read the repositories the user chose.",
    );
  }
  if (response.status === 404) throw new GithubError("not_found", "Not found on GitHub.");
  if (response.status === 409) throw new GithubError("invalid", "GitHub says this conflicts with the current state of the repository (something changed).");
  if (response.status === 422) throw new GithubError("invalid", message ? `GitHub couldn't do that: ${message.slice(0, 200)}` : "GitHub couldn't do that.");
  throw new GithubError("unavailable", `GitHub answered with an error (${response.status}). Try again in a minute.`);
}

/** Why a repo can't be used (no installation for its owner, not one of the chosen repos, or misspelt), in plain words. */
async function explainNoAccessVia(
  get: (path: string) => Promise<string>,
  installUrl: string,
  repo: string,
  verb: "read" | "change",
): Promise<string> {
  const owner = repo.split("/")[0] ?? repo;
  const what = verb === "read" ? "the repositories the user chose for VESPER" : "the repositories the user chose for GitHub changes";
  let installations: { account?: { login?: string }; repository_selection?: string; html_url?: string }[] = [];
  try {
    installations = (JSON.parse(await get("/user/installations?per_page=100")) as { installations?: typeof installations }).installations ?? [];
  } catch (error) {
    if (error instanceof GithubError && error.code === "reconnect") throw error;
    return `${repo} couldn't be opened on GitHub. Check the owner/name, or ${what} (${installUrl}).`;
  }
  const match = installations.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
  if (!match) {
    return (
      `VESPER hasn't been given access to ${verb === "read" ? "read" : "make changes in"} ${owner}'s repositories. If ${owner} is an organisation, an owner of the ` +
      `organisation must approve VESPER: the user chooses ${owner} on ${installUrl} and GitHub sends the ` +
      `organisation's owners a request; it works once they approve. If ${owner} is the user's own account, they can ` +
      `add the repository on that page.`
    );
  }
  if (match.repository_selection === "selected") {
    return `${repo} isn't one of ${what}. They can add it on GitHub: ${validGithubUrl(match.html_url) ? match.html_url : installUrl}`;
  }
  return `${repo} wasn't found on GitHub. Check the owner/name spelling.`;
}

/** The user's GitHub access for one message (nothing is read until a tool needs it). */
export function githubAccess(options: GithubAccessOptions): GithubAccess {
  const { env, db, userId } = options;
  const config = getConfig(env);
  const now = options.now ?? Date.now;
  const maxCalls = options.maxCalls ?? GITHUB_CALLS_PER_MESSAGE;
  const memos = new Map<string, Promise<unknown>>();
  const tokens = tokenSource(options, "reader");
  let calls = 0;

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
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await tokens.get()}`,
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
      if (response.status === 401) return tokens.reconnect();
      if (!response.ok) return githubFailure(response, "reader");
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

    explainNoAccess: (repo) => explainNoAccessVia(async (path) => (await access.get(path)).body, access.installUrl, repo, "read"),
  };
  return access;
}

/** Whether the user has a working connection (no GitHub request is made). */
export async function githubConnected(db: D1Database, userId: string, kind: GithubAppKind = "reader"): Promise<boolean> {
  const row = await getGithubConnection(db, userId, kind);
  return row?.status === "connected";
}

// ---------------------------------------------------------------- GitHub changes (Actions app, v0.13.0)

/** GitHub requests for preparing one change, and for sending one approved change (both well under Cloudflare's 50). */
export const GITHUB_WRITER_CALLS = 20;

export type GithubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The user's Actions-app access: plain API calls, never cached (changes must see GitHub as it is now). */
export interface GithubWriter {
  request<T = unknown>(method: GithubMethod, path: string, body?: unknown): Promise<T>;
  /** github.com page where the user picks which repos VESPER may change. */
  installUrl: string;
  explainNoAccess(repo: string): Promise<string>;
}

export function githubWriter(options: GithubAccessOptions): GithubWriter {
  const config = getConfig(options.env);
  const maxCalls = options.maxCalls ?? GITHUB_WRITER_CALLS;
  const tokens = tokenSource(options, "actions");
  let calls = 0;

  const writer: GithubWriter = {
    installUrl: githubInstallUrl(options.env, "actions"),

    async request<T>(method: GithubMethod, path: string, body?: unknown): Promise<T> {
      if (calls >= maxCalls) throw new GithubError("call_limit", `This change already used its ${maxCalls} GitHub requests.`);
      calls++;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await tokens.get()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": options.userAgent,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        response = await fetch(`${config.githubApiBaseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch {
        throw new GithubError("unavailable", "GitHub couldn't be reached. Try again in a minute.");
      }
      if (response.status === 401) return tokens.reconnect();
      if (!response.ok) return githubFailure(response, "actions");
      if (response.status === 204) return null as T;
      const text = await response.text();
      try {
        return (text ? JSON.parse(text) : null) as T;
      } catch {
        throw new GithubError("unavailable", "GitHub sent an answer VESPER couldn't read. Try again in a minute.");
      }
    },

    explainNoAccess: (repo) =>
      explainNoAccessVia(async (path) => JSON.stringify(await writer.request("GET", path)), writer.installUrl, repo, "change"),
  };
  return writer;
}
