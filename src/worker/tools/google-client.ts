/**
 * The user's Google access (v0.15.0): Calendar (events on calendars they own) and Gmail (sending only).
 *
 * VESPER asks Google for the narrowest permissions that do the job:
 * - calendar.events.owned: see, create, change and delete events on calendars the user owns (VESPER reads, and adds
 *   events only after the user approves each one).
 * - gmail.send: send email as the user (only after they approve each one). It can't read the mailbox.
 * Google's screen lets the user tick either or both; what was granted is stored and checked before each use.
 *
 * Tokens are stored encrypted (key GOOGLE_TOKEN_KEY, bound to the user). An access token lasts about an hour and is
 * renewed with the refresh token, which Google keeps the same, so two requests renewing at once is harmless. When
 * Google refuses the refresh token (it expires after 7 days while the Google app is in testing, or the user removed
 * VESPER's access), the connection is marked "reconnect".
 */
import { getGoogleConnection, markGoogleReconnect, saveGoogleAccess, type GoogleConnectionRow } from "../db/google";
import { getConfig, type Env } from "../env";
import { seal, unseal } from "../lib/secret-box";
import { ToolInputError } from "./types";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** openid + email tell VESPER which Google account was connected (it may differ from the sign-in account). */
export const GOOGLE_SCOPES = ["openid", "email", CALENDAR_SCOPE, GMAIL_SEND_SCOPE] as const;
/** Google requests for one message, or for sending one approved email or event. */
export const GOOGLE_CALLS = 12;
const RENEW_MARGIN_MS = 60_000;

/** stale (v0.19.0): the event changed since it was read (If-Match didn't match its etag). */
export type GoogleErrorCode =
  | "reconnect"
  | "scope"
  | "disabled"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "forbidden"
  | "call_limit"
  | "unavailable"
  | "stale";

export class GoogleError extends ToolInputError {
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const GOOGLE_RECONNECT_MESSAGE =
  "Google ended VESPER's access to this account (Google does this every 7 days while VESPER's Google app is in testing, or when access is removed). Tell the user to reconnect Google in Settings → Connections.";

/** The encryption binding for a user's Google tokens (a GitHub token can't be opened as a Google one, and vice versa). */
export const googleTokenOwner = (userId: string) => `google:${userId}`;

export interface GoogleTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  /** What Google granted (null when it didn't say, e.g. on a refresh). */
  scopes: string[] | null;
}

/** Exchange a sign-in code (with its PKCE verifier) or a refresh token for tokens. */
export async function googleTokenRequest(
  env: Env,
  grant: { code: string; redirectUri: string; verifier: string } | { refreshToken: string },
  now = Date.now(),
): Promise<GoogleTokens> {
  const config = getConfig(env);
  const form = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!.trim(), client_secret: env.GOOGLE_CLIENT_SECRET!.trim() });
  if ("code" in grant) {
    form.set("grant_type", "authorization_code");
    form.set("code", grant.code);
    form.set("redirect_uri", grant.redirectUri);
    form.set("code_verifier", grant.verifier);
  } else {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", grant.refreshToken);
  }
  let json: { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string };
  try {
    const response = await fetch(config.googleTokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    json = (await response.json().catch(() => ({}))) as typeof json;
  } catch {
    throw new GoogleError("unavailable", "Google couldn't be reached. Try again in a minute.");
  }
  if (!json.access_token) {
    // invalid_grant: the code or refresh token is no longer valid (expired after 7 days in testing, or access removed).
    // Anything else (e.g. invalid_client) is a set-up problem, not the user's access: don't ask them to reconnect.
    if (json.error === "invalid_grant") throw new GoogleError("reconnect", GOOGLE_RECONNECT_MESSAGE);
    throw new GoogleError("unavailable", "Google didn't accept VESPER's request right now. Try again in a minute.");
  }
  return {
    accessToken: json.access_token,
    accessExpiresAt: now + Math.max(60, json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token ?? null,
    scopes: typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : null,
  };
}

/** A Google API error, in words the model (or the card) can pass on. */
async function googleFailure(response: Response, api: "calendar" | "gmail"): Promise<never> {
  let body: { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // not JSON
  }
  const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) => String(e.reason ?? "")).join(" ");
  const status = String(body.error?.status ?? "");
  const message = String(body.error?.message ?? "").slice(0, 200);
  const service = api === "gmail" ? "Gmail" : "Google Calendar";
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${reasons} ${status} ${message}`)) {
    throw new GoogleError(
      "scope",
      `VESPER isn't allowed to use ${service} for this Google account. Tell the user to reconnect Google in Settings → Connections and tick ${api === "gmail" ? "sending email" : "Calendar"} on Google's screen.`,
    );
  }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(`${reasons} ${status} ${message}`)) {
    throw new GoogleError("disabled", `${service} isn't switched on in VESPER's Google project yet. Tell the user the administrator needs to enable the ${service} API.`);
  }
  if (response.status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reasons + status)) {
    throw new GoogleError("rate_limited", `${service} is busy (too many requests). Try again in a minute.`);
  }
  // 410: an event that was deleted (v0.19.0).
  if (response.status === 404 || response.status === 410) throw new GoogleError("not_found", `${service} couldn't find that.`);
  if (response.status === 412) throw new GoogleError("stale", `${service}: it changed since VESPER read it.`);
  if (response.status === 400) throw new GoogleError("invalid", `${service} refused the request${message ? `: ${message}` : "."}`);
  if (response.status === 403) throw new GoogleError("forbidden", `${service} refused the request${message ? `: ${message}` : "."}`);
  throw new GoogleError("unavailable", `${service} couldn't be reached right now. Try again in a minute.`);
}

export interface GoogleAccessOptions {
  env: Env;
  db: D1Database;
  userId: string;
  signal?: AbortSignal;
  maxCalls?: number;
  now?: () => number;
}

export interface GoogleAccount {
  email: string;
  calendar: boolean;
  gmailSend: boolean;
}

/** The user's Google access: plain API calls (never cached: the calendar must be read as it is now). */
export interface GoogleAccess {
  account(): Promise<GoogleAccount>;
  request<T = unknown>(
    api: "calendar" | "gmail",
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    /** headers: e.g. If-Match with an event's etag, so a change applies only to the version shown (v0.19.0). */
    options?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> },
  ): Promise<T>;
}

export const accountOf = (row: Pick<GoogleConnectionRow, "email" | "scopes">): GoogleAccount => {
  const scopes = new Set(row.scopes.split(/\s+/));
  return { email: row.email, calendar: scopes.has(CALENDAR_SCOPE), gmailSend: scopes.has(GMAIL_SEND_SCOPE) };
};

export function googleAccess(options: GoogleAccessOptions): GoogleAccess {
  const { env, db, userId } = options;
  const config = getConfig(env);
  const key = env.GOOGLE_TOKEN_KEY!.trim();
  const owner = googleTokenOwner(userId);
  const now = options.now ?? Date.now;
  const maxCalls = options.maxCalls ?? GOOGLE_CALLS;
  let calls = 0;
  let row: Promise<GoogleConnectionRow> | null = null;
  let token: Promise<string> | null = null;

  const reconnect = async (): Promise<never> => {
    await markGoogleReconnect(db, userId).catch(() => {});
    throw new GoogleError("reconnect", GOOGLE_RECONNECT_MESSAGE);
  };

  const connection = () => {
    row ??= getGoogleConnection(db, userId).then((r) => {
      if (!r || r.status !== "connected") throw new GoogleError("reconnect", GOOGLE_RECONNECT_MESSAGE);
      return r;
    });
    row.catch(() => (row = null));
    return row;
  };

  async function renew(current: GoogleConnectionRow): Promise<string> {
    let fresh: GoogleTokens;
    try {
      fresh = await googleTokenRequest(env, { refreshToken: await unseal(key, current.refresh_token, owner) }, now());
    } catch (error) {
      if (error instanceof GoogleError && error.code === "reconnect") return reconnect();
      throw error;
    }
    await saveGoogleAccess(db, userId, await seal(key, fresh.accessToken, owner), fresh.accessExpiresAt, now());
    return fresh.accessToken;
  }

  const accessToken = (force = false) => {
    if (force) token = null;
    token ??= connection().then(async (current) =>
      !force && current.access_expires_at - now() > RENEW_MARGIN_MS ? unseal(key, current.access_token, owner) : renew(current),
    );
    token.catch(() => (token = null));
    return token;
  };

  return {
    account: async () => accountOf(await connection()),

    async request<T>(
      api: "calendar" | "gmail",
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<T> {
      const url = new URL(`${api === "gmail" ? config.googleGmailApiUrl : config.googleCalendarApiUrl}${path}`);
      for (const [name, value] of Object.entries(opts.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
      const send = async (force: boolean) => {
        if (calls >= maxCalls) throw new GoogleError("call_limit", `This step already used its ${maxCalls} Google requests.`);
        calls++;
        const headers: Record<string, string> = { ...opts.headers, Authorization: `Bearer ${await accessToken(force)}`, Accept: "application/json" };
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        try {
          return await fetch(url.toString(), {
            method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } catch {
          throw new GoogleError("unavailable", `${api === "gmail" ? "Gmail" : "Google Calendar"} couldn't be reached. Try again in a minute.`);
        }
      };
      let response = await send(false);
      // An access token can be revoked before it expires: renew once; if Google refuses that too, the access is gone.
      if (response.status === 401) response = await send(true);
      if (response.status === 401) return reconnect();
      if (!response.ok) return googleFailure(response, api);
      const text = await response.text();
      try {
        return (text ? JSON.parse(text) : null) as T;
      } catch {
        throw new GoogleError("unavailable", "Google sent an answer VESPER couldn't read. Try again in a minute.");
      }
    },
  };
}

/** Whether the user has a working connection, and what it allows (no Google request is made). */
export async function googleConnection(db: D1Database, userId: string): Promise<GoogleAccount | null> {
  const row = await getGoogleConnection(db, userId);
  return row?.status === "connected" ? accountOf(row) : null;
}
