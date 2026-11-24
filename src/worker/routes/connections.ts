import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppSettingsDto, ConnectionsDto, GithubConnectionDto, GithubInstallationDto, GoogleConnectionDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { deleteGithubConnection, expireGithubActions, getGithubConnection, listGithubActions, saveGithubConnection, type GithubAppKind } from "../db/github";
import { deleteGoogleConnection, expireGoogleActions, getGoogleConnection, listGoogleActions, saveGoogleConnection } from "../db/google";
import type { SessionUser } from "../db/users";
import { getConfig, type Env } from "../env";
import { randomToken, safeEqual, sha256Base64Url } from "../lib/crypto";
import { accountOf, GOOGLE_SCOPES, GoogleError, googleTokenOwner, googleTokenRequest } from "../tools/google-client";
import { seal, unseal } from "../lib/secret-box";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import {
  githubAccess,
  githubAppCredentials,
  GithubError,
  githubInstallUrl,
  githubTokenRequest,
  githubWriter,
  tokenOwner,
} from "../tools/github-client";
import { VERSION } from "../version";

/**
 * Settings → Connections. Two GitHub Apps, each connected on its own:
 * - "reader" (v0.12.0): VESPER AI Reader, read-only (Contents, Issues, Pull requests, Metadata).
 * - "actions" (v0.13.0): the separate Actions app (Issues, Pull requests, Contents: read and write). VESPER only
 *   prepares changes with it; each one is sent only after the user approves it on a card (routes/github-actions.ts).
 * GitHub asks the user which repositories each app may use.
 */
const APPS: Record<GithubAppKind, { path: string; cookie: string; connected: string }> = {
  reader: { path: "/api/connections/github", cookie: "gh_connect_state", connected: "connected" },
  actions: { path: "/api/connections/github-actions", cookie: "gh_actions_state", connected: "actions-connected" },
};
const connectLimiter = rateLimit("gh_connect", 20, 10 * 60_000, (c) => c.get("user").id);

/** The GitHub App is set up and this account may use it (admins always; users when the admin allows it). */
export const githubAllowed = (env: Env, user: Pick<SessionUser, "role">, settings: Pick<AppSettingsDto, "githubForUsers">) =>
  getConfig(env).githubAppEnabled && (user.role === "admin" || settings.githubForUsers);

/** The Actions app (changes with approval) is set up and this account may use it, likewise (v0.13.0). */
export const githubActionsAllowed = (env: Env, user: Pick<SessionUser, "role">, settings: Pick<AppSettingsDto, "githubActionsForUsers">) =>
  getConfig(env).githubActionsAppEnabled && (user.role === "admin" || settings.githubActionsForUsers);

const allowed = (kind: GithubAppKind, env: Env, user: SessionUser, settings: AppSettingsDto) =>
  kind === "actions" ? githubActionsAllowed(env, user, settings) : githubAllowed(env, user, settings);

const userAgent = (c: Context<AppEnv>) =>
  `${getConfig(c.env).appName.replace(/[^\w.-]/g, "") || "Assistant"}/${VERSION} (+${new URL(c.req.url).origin})`;
const callbackUrl = (c: Context<AppEnv>, kind: GithubAppKind) => `${new URL(c.req.url).origin}${APPS[kind].path}/callback`;
const back = (c: Context<AppEnv>, outcome: string) => c.redirect(`/?github=${encodeURIComponent(outcome)}`, 302);
const githubPage = (url: unknown) => (typeof url === "string" && /^https:\/\/github\.com\/[^\s<>"']*$/.test(url) ? url : null);

async function connectionStatus(c: Context<AppEnv>, kind: GithubAppKind, settings: AppSettingsDto): Promise<GithubConnectionDto> {
  const user = c.get("user");
  const available = allowed(kind, c.env, user, settings);
  const base: GithubConnectionDto = {
    available,
    status: "none",
    login: null,
    installUrl: available ? githubInstallUrl(c.env, kind) : null,
    installations: [],
    repos: [],
    reposTruncated: false,
    error: null,
  };
  if (!available) return base;
  const row = await getGithubConnection(c.env.DB, user.id, kind);
  if (!row) return base;
  if (row.status === "reconnect") return { ...base, status: "reconnect", login: row.login };
  const options = { env: c.env, db: c.env.DB, userId: user.id, userAgent: userAgent(c) };
  let get: (path: string) => Promise<string>;
  if (kind === "actions") {
    const writer = githubWriter(options);
    get = async (path) => JSON.stringify(await writer.request("GET", path));
  } else {
    const gh = githubAccess(options);
    get = async (path) => (await gh.get(path)).body;
  }
  try {
    const installs = (JSON.parse(await get("/user/installations?per_page=100")) as { installations?: Record<string, any>[] }).installations ?? [];
    const installations: GithubInstallationDto[] = installs.map((i) => ({
      account: String(i.account?.login ?? ""),
      type: i.account?.type === "Organization" ? "Organization" : "User",
      allRepos: i.repository_selection === "all",
      manageUrl: githubPage(i.html_url),
    }));
    const repos: GithubConnectionDto["repos"] = [];
    let truncated = installs.length > 5;
    for (const install of installs.slice(0, 5)) {
      const list = JSON.parse(await get(`/user/installations/${Number(install.id)}/repositories?per_page=100`)) as {
        total_count?: number;
        repositories?: Record<string, any>[];
      };
      for (const r of list.repositories ?? []) repos.push({ fullName: String(r.full_name), private: r.private === true });
      if ((list.total_count ?? 0) > (list.repositories?.length ?? 0)) truncated = true;
    }
    return { ...base, status: "connected", login: row.login, installations, repos: repos.slice(0, 100), reposTruncated: truncated || repos.length > 100 };
  } catch (error) {
    if (error instanceof GithubError && error.code === "reconnect") return { ...base, status: "reconnect", login: row.login };
    return { ...base, status: "connected", login: row.login, error: error instanceof GithubError ? error.message : "GitHub couldn't be reached." };
  }
}

async function connections(c: Context<AppEnv>): Promise<ConnectionsDto> {
  const settings = await getAppSettings(c.env.DB, getConfig(c.env));
  const user = c.get("user");
  const [github, githubActions, recentActions, google, recentGoogleActions] = await Promise.all([
    connectionStatus(c, "reader", settings),
    connectionStatus(c, "actions", settings),
    listGithubActions(c.env.DB, user.id),
    googleStatus(c, settings),
    googleAllowed(c.env, user, settings) ? listGoogleActions(c.env.DB, user.id) : Promise.resolve([]),
  ]);
  return { github, githubActions, recentActions, google, recentGoogleActions };
}

// ---------------------------------------------------------------- Google Calendar and Gmail (v0.15.0)

/** Google is set up (sign-in client + GOOGLE_TOKEN_KEY) and this account may use it (admins always; users when allowed). */
export const googleAllowed = (env: Env, user: Pick<SessionUser, "role">, settings: Pick<AppSettingsDto, "googleForUsers">) =>
  getConfig(env).googleConnectEnabled && (user.role === "admin" || settings.googleForUsers);

const GOOGLE_PATH = "/api/connections/google";
const GOOGLE_COOKIE = "google_connect";
const googleBack = (c: Context<AppEnv>, outcome: string) => c.redirect(`/?google=${encodeURIComponent(outcome)}`, 302);
const googleCallbackUrl = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}${GOOGLE_PATH}/callback`;

async function googleStatus(c: Context<AppEnv>, settings: AppSettingsDto): Promise<GoogleConnectionDto> {
  const available = googleAllowed(c.env, c.get("user"), settings);
  const base: GoogleConnectionDto = { available, status: "none", email: null, calendar: false, gmailSend: false };
  if (!available) return base;
  const row = await getGoogleConnection(c.env.DB, c.get("user").id);
  if (!row) return base;
  const account = accountOf(row);
  return { available, status: row.status, email: row.email, calendar: account.calendar, gmailSend: account.gmailSend };
}

/**
 * Opens Google's consent screen (a normal link). It asks for Calendar events and sending email; Google shows a tick
 * box for each, so the user can allow one or both. access_type=offline + prompt=consent: Google gives a refresh token
 * every time. PKCE (S256) and a state cookie protect the round trip.
 */
async function googleStart(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!googleAllowed(c.env, user, await getAppSettings(c.env.DB, getConfig(c.env)))) return googleBack(c, "not_available");
  const state = randomToken(24);
  const verifier = randomToken(48);
  setCookie(c, GOOGLE_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: GOOGLE_PATH,
    maxAge: 600,
  });
  const url = new URL(`${getConfig(c.env).googleOAuthBaseUrl}/o/oauth2/v2/auth`);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", googleCallbackUrl(c));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (user.email) url.searchParams.set("login_hint", user.email);
  return c.redirect(url.toString(), 302);
}

async function googleCallback(c: Context<AppEnv>) {
  const user = c.get("user");
  const [expected, verifier] = (getCookie(c, GOOGLE_COOKIE) ?? "").split(".");
  deleteCookie(c, GOOGLE_COOKIE, { path: GOOGLE_PATH });
  if (c.req.query("error")) return googleBack(c, "denied");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || !expected || !verifier || !safeEqual(state, expected)) return googleBack(c, "failed");
  if (!googleAllowed(c.env, user, await getAppSettings(c.env.DB, getConfig(c.env)))) return googleBack(c, "not_available");
  const config = getConfig(c.env);
  const key = c.env.GOOGLE_TOKEN_KEY!.trim();
  try {
    const tokens = await googleTokenRequest(c.env, { code, redirectUri: googleCallbackUrl(c), verifier });
    const granted = tokens.scopes ?? [];
    const account = accountOf({ email: "", scopes: granted.join(" ") });
    if (!account.calendar && !account.gmailSend) {
      // Both boxes left unticked: nothing to connect; give the access back.
      await revokeGoogle(c.env, tokens.refreshToken ?? tokens.accessToken);
      return googleBack(c, "none-allowed");
    }
    if (!tokens.refreshToken) return googleBack(c, "failed");
    const response = await fetch(config.googleUserinfoUrl, { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" } });
    if (!response.ok) return googleBack(c, "failed");
    const info = (await response.json()) as { sub?: unknown; email?: unknown };
    if (typeof info.sub !== "string" || typeof info.email !== "string" || !info.email.includes("@")) return googleBack(c, "failed");
    const owner = googleTokenOwner(user.id);
    await saveGoogleConnection(c.env.DB, user.id, {
      sub: info.sub,
      email: info.email.trim().toLowerCase().slice(0, 254),
      scopes: granted,
      accessToken: await seal(key, tokens.accessToken, owner),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshToken: await seal(key, tokens.refreshToken, owner),
    });
  } catch (error) {
    // Never log tokens or codes: only what kind of failure it was.
    console.warn(JSON.stringify({ msg: "google connect failed", kind: error instanceof GoogleError ? error.code : "error" }));
    return googleBack(c, "failed");
  }
  return googleBack(c, "connected");
}

/** Ask Google to remove VESPER's access (best effort: the stored access is deleted either way). */
async function revokeGoogle(env: Env, token: string): Promise<void> {
  try {
    await fetch(getConfig(env).googleRevokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // ignore
  }
}

/** Forget the connection, ask Google to revoke it, and cancel the emails and events still waiting for approval. */
async function googleDisconnect(c: Context<AppEnv>) {
  const user = c.get("user");
  const row = await getGoogleConnection(c.env.DB, user.id);
  if (row && getConfig(c.env).googleConnectEnabled) {
    try {
      await revokeGoogle(c.env, await unseal(c.env.GOOGLE_TOKEN_KEY!.trim(), row.refresh_token, googleTokenOwner(user.id)));
    } catch {
      // A token that can't be opened can't be revoked; it is deleted below.
    }
  }
  await deleteGoogleConnection(c.env.DB, user.id);
  await expireGoogleActions(c.env.DB, user.id, { all: true });
  return c.json(await connections(c));
}

/** Opens GitHub's "Authorize" page for one of the two apps (a normal link, not an API call). */
async function start(c: Context<AppEnv>, kind: GithubAppKind) {
  if (!allowed(kind, c.env, c.get("user"), await getAppSettings(c.env.DB, getConfig(c.env)))) return back(c, "not_available");
  const state = randomToken(24);
  setCookie(c, APPS[kind].cookie, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: APPS[kind].path,
    maxAge: 600,
  });
  const url = new URL(`${getConfig(c.env).githubOAuthBaseUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", githubAppCredentials(c.env, kind).clientId);
  url.searchParams.set("redirect_uri", callbackUrl(c, kind));
  url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
}

async function callback(c: Context<AppEnv>, kind: GithubAppKind) {
  const user = c.get("user");
  const state = c.req.query("state");
  const expected = getCookie(c, APPS[kind].cookie);
  deleteCookie(c, APPS[kind].cookie, { path: APPS[kind].path });
  if (c.req.query("error")) return back(c, "denied");
  const code = c.req.query("code");
  if (!code || !state || !expected || !safeEqual(state, expected)) return back(c, "failed");
  if (!allowed(kind, c.env, user, await getAppSettings(c.env.DB, getConfig(c.env)))) return back(c, "not_available");
  const config = getConfig(c.env);
  try {
    const tokens = await githubTokenRequest(c.env, { code, redirectUri: callbackUrl(c, kind) }, userAgent(c), Date.now(), kind);
    const profileResponse = await fetch(`${config.githubApiBaseUrl}/user`, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent(c),
      },
    });
    if (!profileResponse.ok) return back(c, "failed");
    const profile = (await profileResponse.json()) as { id?: unknown; login?: unknown };
    if (typeof profile.id !== "number" || typeof profile.login !== "string") return back(c, "failed");
    const key = c.env.GITHUB_TOKEN_KEY!.trim();
    const owner = tokenOwner(user.id, kind);
    await saveGithubConnection(
      c.env.DB,
      user.id,
      {
        githubId: profile.id,
        login: profile.login.slice(0, 39),
        accessToken: await seal(key, tokens.accessToken, owner),
        accessExpiresAt: tokens.accessExpiresAt,
        refreshToken: tokens.refreshToken ? await seal(key, tokens.refreshToken, owner) : null,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
      kind,
    );
  } catch (error) {
    // Never log tokens or codes: only what kind of failure it was.
    console.warn(JSON.stringify({ msg: "github connect failed", app: kind, kind: error instanceof GithubError ? error.code : "error" }));
    return back(c, "failed");
  }
  return back(c, APPS[kind].connected);
}

/**
 * Forget the connection here and ask GitHub to revoke VESPER's access (the repo choice on GitHub stays). Disconnecting
 * GitHub changes also cancels the changes still waiting for approval.
 */
async function disconnect(c: Context<AppEnv>, kind: GithubAppKind) {
  const user = c.get("user");
  const config = getConfig(c.env);
  const row = await getGithubConnection(c.env.DB, user.id, kind);
  if (row && (kind === "actions" ? config.githubActionsAppEnabled : config.githubAppEnabled)) {
    try {
      const token = await unseal(c.env.GITHUB_TOKEN_KEY!.trim(), row.access_token, tokenOwner(user.id, kind));
      const app = githubAppCredentials(c.env, kind);
      await fetch(`${config.githubApiBaseUrl}/applications/${encodeURIComponent(app.clientId)}/grant`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent(c),
        },
        body: JSON.stringify({ access_token: token }),
      });
    } catch {
      // Best effort: the stored access is deleted below either way.
    }
  }
  await deleteGithubConnection(c.env.DB, user.id, kind);
  if (kind === "actions") await expireGithubActions(c.env.DB, user.id, { all: true });
  return c.json(await connections(c));
}

export const connectionRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => c.json(await connections(c)))
  .get("/github/start", connectLimiter, (c) => start(c, "reader"))
  .get("/github/callback", connectLimiter, (c) => callback(c, "reader"))
  .post("/github/disconnect", (c) => disconnect(c, "reader"))
  // GitHub changes with approval (v0.13.0): the separate Actions app.
  .get("/github-actions/start", connectLimiter, (c) => start(c, "actions"))
  .get("/github-actions/callback", connectLimiter, (c) => callback(c, "actions"))
  .post("/github-actions/disconnect", (c) => disconnect(c, "actions"))
  // Google Calendar and Gmail with approval (v0.15.0).
  .get("/google/start", connectLimiter, (c) => googleStart(c))
  .get("/google/callback", connectLimiter, (c) => googleCallback(c))
  .post("/google/disconnect", (c) => googleDisconnect(c));
