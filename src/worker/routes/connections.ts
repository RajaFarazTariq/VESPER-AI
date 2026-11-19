import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppSettingsDto, GithubConnectionDto, GithubInstallationDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { deleteGithubConnection, getGithubConnection, saveGithubConnection } from "../db/github";
import type { SessionUser } from "../db/users";
import { getConfig, type Env } from "../env";
import { randomToken, safeEqual } from "../lib/crypto";
import { seal, unseal } from "../lib/secret-box";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import { githubAccess, GithubError, githubInstallUrl, githubTokenRequest } from "../tools/github-client";
import { VERSION } from "../version";

/**
 * Settings → Connections → GitHub (v0.12.0): each user connects their own GitHub through the VESPER GitHub App
 * (read-only: Contents, Issues, Pull requests, Metadata). GitHub asks the user which repositories to allow.
 */
const STATE_COOKIE = "gh_connect_state";
const STATE_PATH = "/api/connections/github";
const connectLimiter = rateLimit("gh_connect", 20, 10 * 60_000, (c) => c.get("user").id);

/** The GitHub App is set up and this account may use it (admins always; users when the admin allows it). */
export const githubAllowed = (env: Env, user: Pick<SessionUser, "role">, settings: Pick<AppSettingsDto, "githubForUsers">) =>
  getConfig(env).githubAppEnabled && (user.role === "admin" || settings.githubForUsers);

const userAgent = (c: Context<AppEnv>) =>
  `${getConfig(c.env).appName.replace(/[^\w.-]/g, "") || "Assistant"}/${VERSION} (+${new URL(c.req.url).origin})`;
const callbackUrl = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}${STATE_PATH}/callback`;
const back = (c: Context<AppEnv>, outcome: string) => c.redirect(`/?github=${encodeURIComponent(outcome)}`, 302);
const githubPage = (url: unknown) => (typeof url === "string" && /^https:\/\/github\.com\/[^\s<>"']*$/.test(url) ? url : null);

async function connectionStatus(c: Context<AppEnv>): Promise<GithubConnectionDto> {
  const user = c.get("user");
  const available = githubAllowed(c.env, user, await getAppSettings(c.env.DB, getConfig(c.env)));
  const base: GithubConnectionDto = {
    available,
    status: "none",
    login: null,
    installUrl: available ? githubInstallUrl(c.env) : null,
    installations: [],
    repos: [],
    reposTruncated: false,
    error: null,
  };
  if (!available) return base;
  const row = await getGithubConnection(c.env.DB, user.id);
  if (!row) return base;
  if (row.status === "reconnect") return { ...base, status: "reconnect", login: row.login };
  const gh = githubAccess({ env: c.env, db: c.env.DB, userId: user.id, userAgent: userAgent(c) });
  try {
    const installs = (JSON.parse((await gh.get("/user/installations?per_page=100")).body) as { installations?: Record<string, any>[] }).installations ?? [];
    const installations: GithubInstallationDto[] = installs.map((i) => ({
      account: String(i.account?.login ?? ""),
      type: i.account?.type === "Organization" ? "Organization" : "User",
      allRepos: i.repository_selection === "all",
      manageUrl: githubPage(i.html_url),
    }));
    const repos: GithubConnectionDto["repos"] = [];
    let truncated = installs.length > 5;
    for (const install of installs.slice(0, 5)) {
      const list = JSON.parse((await gh.get(`/user/installations/${Number(install.id)}/repositories?per_page=100`)).body) as {
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

export const connectionRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => c.json({ github: await connectionStatus(c) }))

  /** Opens GitHub's "Authorize VESPER" page (a normal link, not an API call). */
  .get("/github/start", connectLimiter, async (c) => {
    if (!githubAllowed(c.env, c.get("user"), await getAppSettings(c.env.DB, getConfig(c.env)))) return back(c, "not_available");
    const state = randomToken(24);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      path: STATE_PATH,
      maxAge: 600,
    });
    const url = new URL(`${getConfig(c.env).githubOAuthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", c.env.GITHUB_APP_CLIENT_ID!.trim());
    url.searchParams.set("redirect_uri", callbackUrl(c));
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  })

  .get("/github/callback", connectLimiter, async (c) => {
    const user = c.get("user");
    const state = c.req.query("state");
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: STATE_PATH });
    if (c.req.query("error")) return back(c, "denied");
    const code = c.req.query("code");
    if (!code || !state || !expected || !safeEqual(state, expected)) return back(c, "failed");
    if (!githubAllowed(c.env, user, await getAppSettings(c.env.DB, getConfig(c.env)))) return back(c, "not_available");
    const config = getConfig(c.env);
    try {
      const tokens = await githubTokenRequest(c.env, { code, redirectUri: callbackUrl(c) }, userAgent(c));
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
      await saveGithubConnection(c.env.DB, user.id, {
        githubId: profile.id,
        login: profile.login.slice(0, 39),
        accessToken: await seal(key, tokens.accessToken, user.id),
        accessExpiresAt: tokens.accessExpiresAt,
        refreshToken: tokens.refreshToken ? await seal(key, tokens.refreshToken, user.id) : null,
        refreshExpiresAt: tokens.refreshExpiresAt,
      });
    } catch (error) {
      // Never log tokens or codes: only what kind of failure it was.
      console.warn(JSON.stringify({ msg: "github connect failed", kind: error instanceof GithubError ? error.code : "error" }));
      return back(c, "failed");
    }
    return back(c, "connected");
  })

  /** Forget the connection here and ask GitHub to revoke VESPER's access (the repo choice on GitHub stays). */
  .post("/github/disconnect", async (c) => {
    const user = c.get("user");
    const row = await getGithubConnection(c.env.DB, user.id);
    if (row && getConfig(c.env).githubAppEnabled) {
      try {
        const token = await unseal(c.env.GITHUB_TOKEN_KEY!.trim(), row.access_token, user.id);
        const id = c.env.GITHUB_APP_CLIENT_ID!.trim();
        await fetch(`${getConfig(c.env).githubApiBaseUrl}/applications/${encodeURIComponent(id)}/grant`, {
          method: "DELETE",
          headers: {
            Authorization: `Basic ${btoa(`${id}:${c.env.GITHUB_APP_CLIENT_SECRET!.trim()}`)}`,
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
    await deleteGithubConnection(c.env.DB, user.id);
    return c.json({ github: await connectionStatus(c) });
  });
