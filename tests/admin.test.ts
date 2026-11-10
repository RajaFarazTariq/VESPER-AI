/**
 * Phase 6.0: multi-user accounts and the admin panel, over HTTP inside workerd with a real local D1.
 * Google and GitHub are simulated by mocking their token and profile endpoints.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseParser } from "../src/shared/sse";
import { DEFAULT_SETTINGS, type ChatStreamEvent } from "../src/shared/types";
import { app } from "../src/worker/app";
import { consumeDailyMessage, createUser } from "../src/worker/db/users";
import { clearModelMemoryCache } from "../src/worker/llm/catalog";
import { ALL_TOOLS } from "../src/worker/tools/registry";

const ORIGIN = "http://localhost";
type ExtraEnv = Partial<Record<string, string>>;

const GOOGLE: ExtraEnv = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  GOOGLE_OAUTH_BASE_URL: "https://accounts.google.test",
  GOOGLE_TOKEN_URL: "https://oauth2.google.test/token",
  GOOGLE_USERINFO_URL: "https://openid.google.test/userinfo",
};
const GITHUB: ExtraEnv = {
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "csecret",
  GITHUB_OAUTH_BASE_URL: "https://gh.test",
  GITHUB_API_BASE_URL: "https://api.gh.test",
};
const PROVIDERS: ExtraEnv = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" };
const ALL: ExtraEnv = { ...GOOGLE, ...GITHUB, ...PROVIDERS };

async function call(path: string, init: RequestInit & { cookie?: string; env?: ExtraEnv } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), { ...env, ...ALL, ...init.env }, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sseResponse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const sessionFrom = (response: Response) => /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let extraHandler: FetchHandler | null = null;
/** One fetch mock for everything: Google/GitHub OAuth, plus whatever the test adds (LLM replies). */
let googleProfile: Record<string, unknown> = {};
let githubProfile: Record<string, unknown> = {};
function installFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === GOOGLE.GOOGLE_TOKEN_URL) return jsonResponse({ access_token: "ya29.test", id_token: "x" });
    if (url === GOOGLE.GOOGLE_USERINFO_URL) return jsonResponse(googleProfile);
    if (url === "https://gh.test/login/oauth/access_token") return jsonResponse({ access_token: "gho_test" });
    if (url === "https://api.gh.test/user") return jsonResponse(githubProfile);
    if (extraHandler) return extraHandler(url, init);
    return new Response("unexpected " + url, { status: 500 });
  });
}

async function googleSignIn(profile: { sub: string; email: string; name?: string; email_verified?: unknown; picture?: string }) {
  googleProfile = { email_verified: true, name: profile.name ?? null, picture: "https://lh3.googleusercontent.com/a/photo", ...profile };
  installFetch();
  const start = await call("/api/auth/google/login");
  expect(start.response.status).toBe(302);
  const location = new URL(start.response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://accounts.google.test/o/oauth2/v2/auth");
  expect(location.searchParams.get("scope")).toBe("openid email profile");
  expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/google/callback");
  const state = location.searchParams.get("state")!;
  const stateCookie = /oauth_state_google=[^;]+/.exec(start.response.headers.get("set-cookie") ?? "")![0];
  const done = await call(`/api/auth/google/callback?code=c0de&state=${state}`, { cookie: stateCookie });
  return { location: done.response.headers.get("location"), session: sessionFrom(done.response) };
}

async function githubSignIn(profile: { id: number; login: string; name?: string }) {
  githubProfile = { name: null, avatar_url: "https://avatars.githubusercontent.com/u/1", ...profile };
  installFetch();
  const start = await call("/api/auth/github/login");
  const state = new URL(start.response.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = /oauth_state=[^;]+/.exec(start.response.headers.get("set-cookie") ?? "")![0];
  const done = await call(`/api/auth/github/callback?code=abc&state=${state}`, { cookie: stateCookie });
  return { location: done.response.headers.get("location"), session: sessionFrom(done.response) };
}

async function devLogin(login: string) {
  const { response, json } = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login }) });
  expect(response.status, JSON.stringify(json)).toBe(200);
  return sessionFrom(response)!;
}

const me = async (cookie: string) => call("/api/auth/me", { cookie });

async function chat(cookie: string, message: string, body: Record<string, unknown> = {}) {
  extraHandler = () => sseResponse("ok");
  installFetch();
  return call("/api/chat", { method: "POST", body: JSON.stringify({ message, ...body }), cookie });
}

const conversationCount = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?1").bind(userId).first<{ n: number }>())?.n ?? 0;

afterEach(() => {
  vi.restoreAllMocks();
  clearModelMemoryCache();
  extraHandler = null;
});

describe("Google sign-in", () => {
  it("lets anyone create an account (regular user) and sign in again to the same account", async () => {
    const first = await googleSignIn({ sub: "g-1", email: "Tester@Gmail.com", name: "Test Er" });
    expect(first.location).toBe("/");
    expect(first.session).not.toBeNull();
    const profile = await me(first.session!);
    expect(profile.json.user).toMatchObject({
      login: "tester@gmail.com",
      email: "tester@gmail.com",
      name: "Test Er",
      role: "user",
      avatarUrl: "https://lh3.googleusercontent.com/a/photo",
    });
    const again = await googleSignIn({ sub: "g-1", email: "tester@gmail.com", name: "Test Er" });
    expect((await me(again.session!)).json.user.id).toBe(profile.json.user.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n).toBe(1);
  });

  it("refuses unverified emails and bad state, and never creates an account for them", async () => {
    const unverified = await googleSignIn({ sub: "g-2", email: "x@gmail.com", email_verified: false });
    expect(unverified.location).toBe("/?auth_error=google_email_unverified");
    expect(unverified.session).toBeNull();
    installFetch();
    const forged = await call("/api/auth/google/callback?code=c&state=forged", { cookie: "oauth_state_google=other" });
    expect(forged.response.headers.get("location")).toBe("/?auth_error=invalid_state");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n).toBe(0);
  });

  it("reports Google as available only when configured", async () => {
    expect((await call("/api/auth/config")).json).toMatchObject({ googleLogin: true, githubLogin: true });
    const off = await call("/api/auth/config", { env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" } });
    expect(off.json.googleLogin).toBe(false);
    const redirect = await call("/api/auth/google/login", { env: { GOOGLE_CLIENT_ID: "" } });
    expect(redirect.response.headers.get("location")).toBe("/?auth_error=google_not_configured");
  });
});

describe("admin account: Google and GitHub open the same account", () => {
  it("links the admin's Google sign-in to the existing GitHub admin account (GitHub first)", async () => {
    const gh = await githubSignIn({ id: 4242, login: "OctoCat", name: "Owner" });
    expect(gh.location).toBe("/");
    const adminId = (await me(gh.session!)).json.user.id;
    await chat(gh.session!, "keep this chat");
    expect(await conversationCount(adminId)).toBe(1);

    const google = await googleSignIn({ sub: "g-admin", email: "boss@example.com", name: "Owner G" });
    const viaGoogle = await me(google.session!);
    expect(viaGoogle.json.user).toMatchObject({ id: adminId, role: "admin", email: "boss@example.com", login: "OctoCat" });
    const chats = await call("/api/conversations", { cookie: google.session! });
    expect(chats.json.conversations).toHaveLength(1);

    // And GitHub still opens the same account afterwards.
    const ghAgain = await githubSignIn({ id: 4242, login: "OctoCat" });
    expect((await me(ghAgain.session!)).json.user.id).toBe(adminId);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n).toBe(1);
  });

  it("links the admin's GitHub sign-in to the existing Google admin account (Google first)", async () => {
    const google = await googleSignIn({ sub: "g-admin", email: "boss@example.com" });
    const adminId = (await me(google.session!)).json.user.id;
    expect((await me(google.session!)).json.user.role).toBe("admin");
    const gh = await githubSignIn({ id: 4242, login: "octocat" });
    expect((await me(gh.session!)).json.user).toMatchObject({ id: adminId, role: "admin" });
  });

  it("never links a regular user's Google account to the admin's GitHub account", async () => {
    const gh = await githubSignIn({ id: 4242, login: "octocat" });
    const adminId = (await me(gh.session!)).json.user.id;
    const tester = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    const testerMe = await me(tester.session!);
    expect(testerMe.json.user.id).not.toBe(adminId);
    expect(testerMe.json.user.role).toBe("user");
  });

  it("refuses GitHub sign-in for non-admins", async () => {
    const result = await githubSignIn({ id: 77, login: "mallory" });
    expect(result.location).toBe("/?auth_error=github_admin_only");
    expect(result.session).toBeNull();
  });
});

describe("admin panel permissions", () => {
  it("only the admin can use /api/admin, and regular users don't see provider errors", async () => {
    const admin = await devLogin("octocat");
    const user = await devLogin("tester");
    expect((await call("/api/admin/users", { cookie: user })).response.status).toBe(403);
    expect((await call("/api/admin/settings", { cookie: user })).response.status).toBe(403);
    expect((await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ signupsOpen: false }), cookie: user })).response.status).toBe(403);
    expect((await call("/api/admin/users")).response.status).toBe(401);

    const list = await call("/api/admin/users", { cookie: admin });
    expect(list.response.status).toBe(200);
    expect(list.json.users.map((u: any) => [u.login, u.role]).sort()).toEqual([
      ["octocat", "admin"],
      ["tester", "user"],
    ]);

    await env.DB.prepare("INSERT INTO provider_state (provider, cooldown_until, last_error, updated_at) VALUES ('groq', ?1, 'secret detail', 1)")
      .bind(Date.now() + 60_000)
      .run();
    extraHandler = () => jsonResponse({ data: [] });
    installFetch();
    const asUser = await call("/api/models", { cookie: user });
    const asAdmin = await call("/api/models", { cookie: admin });
    expect(asUser.json.providers.find((p: any) => p.id === "groq").lastError).toBeNull();
    expect(asAdmin.json.providers.find((p: any) => p.id === "groq").lastError).toBe("secret detail");
  });
});

describe("blocking users", () => {
  it("blocks at once (sessions ended, sign-in refused), unblocks, and never blocks an admin", async () => {
    const admin = await devLogin("octocat");
    const tester = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    const testerId = (await me(tester.session!)).json.user.id;
    const adminId = (await me(admin)).json.user.id;

    const blocked = await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({ status: "blocked" }), cookie: admin });
    expect(blocked.json.user).toMatchObject({ id: testerId, status: "blocked" });
    expect((await me(tester.session!)).response.status).toBe(401);
    const again = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    expect(again.location).toBe("/?auth_error=blocked");
    expect(again.session).toBeNull();

    await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }), cookie: admin });
    const back = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    expect((await me(back.session!)).response.status).toBe(200);

    const selfBlock = await call(`/api/admin/users/${adminId}`, { method: "PATCH", body: JSON.stringify({ status: "blocked" }), cookie: admin });
    expect(selfBlock.response.status).toBe(400);
    expect((await me(admin)).response.status).toBe(200);
    expect((await call(`/api/admin/users/${adminId}`, { method: "DELETE", cookie: admin })).response.status).toBe(400);
    expect((await call("/api/admin/users/not-a-user", { method: "PATCH", body: JSON.stringify({ status: "blocked" }), cookie: admin })).response.status).toBe(404);
    expect((await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({}), cookie: admin })).response.status).toBe(400);
  });

  it("deleting a user removes their chats too", async () => {
    const admin = await devLogin("octocat");
    const tester = await devLogin("tester");
    const testerId = (await me(tester)).json.user.id;
    await chat(tester, "hello");
    expect(await conversationCount(testerId)).toBe(1);
    expect((await call(`/api/admin/users/${testerId}`, { method: "DELETE", cookie: admin })).json).toEqual({ ok: true });
    expect(await conversationCount(testerId)).toBe(0);
    expect((await me(tester)).response.status).toBe(401);
  });
});

describe("sign-ups open/closed", () => {
  it("closing sign-ups stops new accounts but lets existing users (and the admin) in", async () => {
    const admin = await devLogin("octocat");
    const existing = await googleSignIn({ sub: "g-old", email: "old@gmail.com" });
    expect(existing.session).not.toBeNull();

    const closed = await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ signupsOpen: false }), cookie: admin });
    expect(closed.json.settings.signupsOpen).toBe(false);

    const newcomer = await googleSignIn({ sub: "g-new", email: "new@gmail.com" });
    expect(newcomer.location).toBe("/?auth_error=signups_closed");
    expect(newcomer.session).toBeNull();
    const devNewcomer = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: "newbie" }) });
    expect(devNewcomer.response.status).toBe(403);

    const returning = await googleSignIn({ sub: "g-old", email: "old@gmail.com" });
    expect(returning.location).toBe("/");
    expect((await me(returning.session!)).response.status).toBe(200);
    // An admin email can still create its account while sign-ups are closed.
    const adminByEmail = await googleSignIn({ sub: "g-boss", email: "boss@example.com" });
    expect(adminByEmail.location).toBe("/");

    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ signupsOpen: true }), cookie: admin });
    expect((await googleSignIn({ sub: "g-new", email: "new@gmail.com" })).location).toBe("/");
  });
});

describe("daily message limit", () => {
  it("defaults to 30 per user per day", async () => {
    const admin = await devLogin("octocat");
    expect((await call("/api/admin/settings", { cookie: admin })).json.settings.defaultDailyLimit).toBe(30);
  });

  it("stops a tester at the limit (creating nothing), never limits the admin, and honours personal limits", async () => {
    const admin = await devLogin("octocat");
    const tester = await devLogin("tester");
    const testerId = (await me(tester)).json.user.id;
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ defaultDailyLimit: 2 }), cookie: admin });

    expect((await chat(tester, "one")).response.status).toBe(200);
    expect((await chat(tester, "two")).response.status).toBe(200);
    const third = await chat(tester, "three");
    expect(third.response.status).toBe(429);
    expect(third.json.error.code).toBe("daily_limit");
    expect(third.json.error.message).toMatch(/all 2 messages for today/);
    expect(await conversationCount(testerId)).toBe(2);

    for (const n of [1, 2, 3, 4]) expect((await chat(admin, `admin ${n}`)).response.status).toBe(200);

    const users = (await call("/api/admin/users", { cookie: admin })).json.users;
    expect(users.find((u: any) => u.id === testerId)).toMatchObject({ todayMessages: 2, dailyLimit: null });
    // The admin's messages are counted for the usage view, but never limited (4 > limit of 2).
    expect(users.find((u: any) => u.role === "admin")).toMatchObject({ todayMessages: 4 });

    await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({ dailyLimit: 3 }), cookie: admin });
    expect((await chat(tester, "three again")).response.status).toBe(200);
    expect((await chat(tester, "four")).response.status).toBe(429);

    await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({ dailyLimit: 0 }), cookie: admin });
    const paused = await chat(tester, "paused?");
    expect(paused.json.error.message).toMatch(/paused/);

    const bad = await call(`/api/admin/users/${testerId}`, { method: "PATCH", body: JSON.stringify({ dailyLimit: -1 }), cookie: admin });
    expect(bad.response.status).toBe(400);
  });

  it("counts atomically and never goes past the limit", async () => {
    const user = await createUser(env.DB, { googleSub: "g-x", email: "x@y.z", login: "x@y.z", name: null, avatarUrl: null });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await consumeDailyMessage(env.DB, user.id, 3));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await consumeDailyMessage(env.DB, user.id, 0)).toBe(false);
    const row = await env.DB.prepare("SELECT messages FROM user_usage_daily WHERE user_id = ?1").bind(user.id).first<{ messages: number }>();
    expect(row?.messages).toBe(3);
  });
});

describe("app settings from the admin", () => {
  it("adds the admin's instructions to every user's prompt and removes tools for everyone", async () => {
    const admin = await devLogin("octocat");
    const tester = await devLogin("tester");
    const bad = await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ defaultDailyLimit: "lots" }), cookie: admin });
    expect(bad.response.status).toBe(400);
    const saved = await call("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ botInstructions: "Always answer in simple English.", disabledTools: ["calculator"] }),
      cookie: admin,
    });
    expect(saved.json.settings).toMatchObject({ botInstructions: "Always answer in simple English.", disabledTools: ["calculator"], signupsOpen: true });

    let sent: any = null;
    extraHandler = (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return sseResponse("ok");
    };
    installFetch();
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }), cookie: tester });
    expect(sent.messages[0].content).toContain("Always answer in simple English.");
    expect(sent.tools.map((t: any) => t.function.name)).not.toContain("calculator");
    expect(sent.tools.map((t: any) => t.function.name)).toContain("current_datetime");

    const toolList = await call("/api/tools", { cookie: tester });
    expect(toolList.json.tools.map((t: any) => t.name)).not.toContain("calculator");
    // The admin still sees every tool in the admin panel, to switch it back on.
    const adminView = await call("/api/admin/settings", { cookie: admin });
    expect(adminView.json.tools.map((t: any) => t.name)).toContain("calculator");
  });
});

describe("memories per user", () => {
  it("saves a memory and brings it back in a new chat, only for that user", async () => {
    const tester = await devLogin("tester");
    const other = await devLogin("other");
    await call("/api/memories", { method: "POST", body: JSON.stringify({ content: "My cat is called Miso." }), cookie: tester });
    const systems: string[] = [];
    extraHandler = (_url, init) => {
      systems.push(JSON.parse(String(init?.body)).messages[0].content);
      return sseResponse("ok");
    };
    installFetch();
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "new chat: what's my cat called?" }), cookie: tester });
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "and mine?" }), cookie: other });
    expect(systems[0]).toContain("My cat is called Miso.");
    expect(systems[1]).not.toContain("Miso");
  });
});

describe("chat history survives sign-out", () => {
  it("keeps the conversation after logging out and back in", async () => {
    const first = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    const sent = await chat(first.session!, "remember this conversation");
    const parser = new SseParser();
    const events = [...parser.feed(sent.text), ...parser.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
    const id = (events[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;
    await call("/api/auth/logout", { method: "POST", body: "{}", cookie: first.session! });
    expect((await me(first.session!)).response.status).toBe(401);

    const second = await googleSignIn({ sub: "g-t", email: "tester@gmail.com" });
    const detail = await call(`/api/conversations/${id}`, { cookie: second.session! });
    expect(detail.json.messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "remember this conversation"],
      ["assistant", "ok"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 6.1: clean replies for users, the user's time zone, and the admin-picked model list.
// ---------------------------------------------------------------------------------------------

const parseStream = (text: string): ChatStreamEvent[] => {
  const parser = new SseParser();
  return [...parser.feed(text), ...parser.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
};

/** A streamed model turn that "thinks" and then calls the date tool. */
const thinkingToolCall = () =>
  new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            reasoning: "Let me check the clock.",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "current_datetime", arguments: '{"timezone":"Asia/Karachi"}' } }],
          },
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const GEMINI: ExtraEnv = { GEMINI_API_KEY: "k", GEMINI_BASE_URL: "https://gemini.test/v1" };

describe("6.1 clean replies for users", () => {
  async function askTheTime(cookie: string) {
    await env.DB.prepare("DELETE FROM provider_state").run(); // fresh: Groq fails first every time
    let geminiCalls = 0;
    extraHandler = (url) => {
      if (url.startsWith("https://groq.test")) return jsonResponse({ error: { message: "Rate limit reached for model" } }, 429);
      geminiCalls++;
      return geminiCalls === 1 ? thinkingToolCall() : sseResponse("It is just after 4 AM.");
    };
    installFetch();
    const { text } = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "What time is it?" }), cookie, env: GEMINI });
    return parseStream(text);
  }

  it("users get no thinking notes, tool details, provider switching or model names; the admin gets everything", async () => {
    const admin = await devLogin("octocat");
    const tester = await devLogin("tester");

    const userEvents = await askTheTime(tester);
    const userTypes = userEvents.map((e) => e.type);
    expect(userTypes).not.toContain("attempt");
    expect(userTypes).not.toContain("fallback");
    expect(userTypes).not.toContain("reasoning");
    const userTools = userEvents.filter((e) => e.type === "tool") as Extract<ChatStreamEvent, { type: "tool" }>[];
    expect(userTools.length).toBeGreaterThan(0);
    for (const t of userTools) expect(t.tool).toMatchObject({ name: "current_datetime", args: {}, summary: null });
    const userDone = userEvents.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(userDone.type).toBe("done");
    expect(userDone.message).toMatchObject({ content: "It is just after 4 AM.", reasoning: null, provider: null, model: null });
    expect(userDone.message.tools?.[0]).toMatchObject({ args: {}, summary: null });

    const adminEvents = await askTheTime(admin);
    const adminTypes = adminEvents.map((e) => e.type);
    expect(adminTypes).toContain("attempt");
    expect(adminTypes).toContain("fallback");
    expect(adminTypes).toContain("reasoning");
    const adminDone = adminEvents.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(adminDone.message).toMatchObject({ reasoning: "Let me check the clock.", provider: "gemini" });
    expect(adminDone.message.tools?.[0]?.args).toEqual({ timezone: "Asia/Karachi" });
    expect(adminDone.message.tools?.[0]?.summary).toContain("Asia/Karachi");

    // Reopening the chat later is just as clean for the user (the full reply is still stored).
    const userConvId = (userEvents[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;
    const reopened = await call(`/api/conversations/${userConvId}`, { cookie: tester });
    expect(reopened.json.messages[1]).toMatchObject({ reasoning: null, provider: null, model: null });
    expect(reopened.json.messages[1].tools[0]).toMatchObject({ args: {}, summary: null });
    const stored = await env.DB.prepare("SELECT reasoning, provider FROM messages WHERE conversation_id = ?1 AND role = 'assistant'")
      .bind(userConvId)
      .first<{ reasoning: string; provider: string }>();
    expect(stored).toEqual({ reasoning: "Let me check the clock.", provider: "gemini" });

    // The admin can switch thinking notes on for users; tool details and model names stay hidden.
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ showReasoningToUsers: true }), cookie: admin });
    const withNotes = await call(`/api/conversations/${userConvId}`, { cookie: tester });
    expect(withNotes.json.messages[1]).toMatchObject({ reasoning: "Let me check the clock.", provider: null });
    expect(withNotes.json.messages[1].tools[0].args).toEqual({});
  });
});

describe("6.1 the user's own time zone", () => {
  it("tells the assistant the user's local date and time, and ignores unknown zones", async () => {
    const tester = await devLogin("tester");
    const systems: string[] = [];
    extraHandler = (_url, init) => {
      systems.push(JSON.parse(String(init?.body)).messages[0].content);
      return sseResponse("ok");
    };
    installFetch();
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi", timeZone: "Asia/Karachi" }), cookie: tester });
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi", timeZone: "Mars/Olympus_Mons" }), cookie: tester });
    expect(systems[0]).toContain("The user's current local date and time:");
    expect(systems[0]).toContain("(Asia/Karachi, GMT+05:00)");
    expect(systems[1]).toMatch(/Current date: \d{4}-\d{2}-\d{2} \(UTC\)/);
    const tooLong = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi", timeZone: "x".repeat(65) }), cookie: tester });
    expect(tooLong.response.status).toBe(400);
  });

  it("the date tool defaults to the user's time zone (late evening UTC is already tomorrow in Pakistan)", async () => {
    const tool = ALL_TOOLS.find((t) => t.name === "current_datetime")!;
    const now = new Date("2026-11-10T23:03:00Z");
    const base = { db: env.DB, userId: "u", settings: DEFAULT_SETTINGS, now };
    const local = await tool.run({}, { ...base, timeZone: "Asia/Karachi" });
    expect(local.summary).toContain("Wednesday, 11 November 2026");
    expect(local.summary).toContain("Asia/Karachi");
    const utc = await tool.run({}, base);
    expect(utc.summary).toContain("Tuesday, 10 November 2026");
    expect(utc.summary).toContain("UTC");
  });
});

describe("6.1 admin-picked model list for users", () => {
  const groqModels = () =>
    jsonResponse({ data: [{ id: "openai/gpt-oss-120b", context_window: 131072 }, { id: "llama-3.3-70b-versatile" }] });
  const post = (cookie: string, body: Record<string, unknown>) => call("/api/chat", { method: "POST", body: JSON.stringify(body), cookie });

  it("users see and may use only Auto plus the admin's picks; the admin keeps every model", async () => {
    const admin = await devLogin("octocat");
    const tester = await devLogin("tester");
    extraHandler = (url) => (url.endsWith("/models") ? groqModels() : sseResponse("ok"));
    installFetch();

    // Nothing picked yet: users only have Auto.
    const before = await call("/api/models?refresh=1", { cookie: tester });
    expect(before.json.userModels).toEqual([]);
    expect(before.json.providers.find((p: any) => p.id === "groq").models).toEqual([]);
    const adminList = await call("/api/models?refresh=1", { cookie: admin });
    expect(adminList.json.userModels).toBeNull();
    // (The app sorts model lists, so compare without caring about order.)
    expect(adminList.json.providers.find((p: any) => p.id === "groq").models.map((m: any) => m.id).sort()).toEqual([
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
    ]);
    const refused = await post(tester, { message: "hi", model: "groq:openai/gpt-oss-120b" });
    expect(refused.response.status).toBe(403);
    expect(refused.json.error.code).toBe("model_not_allowed");
    expect(await conversationCount((await me(tester)).json.user.id)).toBe(0);
    expect((await post(tester, { message: "hi", model: "auto" })).response.status).toBe(200);
    expect((await post(admin, { message: "hi", model: "groq:llama-3.3-70b-versatile" })).response.status).toBe(200);

    // Bad lists are rejected.
    for (const bad of [
      [{ value: "openrouter", label: "x" }],
      [{ value: "groq:openai/gpt-oss-120b", label: "" }],
      [
        { value: "groq:a", label: "A" },
        { value: "groq:a", label: "B" },
      ],
      [{ value: "ollama:llama3", label: "Local" }],
    ]) {
      const r = await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ userModels: bad }), cookie: admin });
      expect(r.response.status, JSON.stringify(bad)).toBe(400);
    }

    // The admin picks one model and names it "Smart".
    const saved = await call("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ userModels: [{ value: "groq:openai/gpt-oss-120b", label: "Smart" }] }),
      cookie: admin,
    });
    expect(saved.json.settings.userModels).toEqual([{ value: "groq:openai/gpt-oss-120b", label: "Smart" }]);
    const after = await call("/api/models", { cookie: tester });
    expect(after.json.userModels).toEqual([{ value: "groq:openai/gpt-oss-120b", label: "Smart" }]);
    expect(after.json.providers.find((p: any) => p.id === "groq").models.map((m: any) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    expect((await post(tester, { message: "hi", model: "groq:openai/gpt-oss-120b" })).response.status).toBe(200);
    expect((await post(tester, { message: "hi", model: "groq:llama-3.3-70b-versatile" })).response.status).toBe(403);

    // Default model in Settings: only allowed choices.
    const badDefault = await call("/api/settings", { method: "PUT", body: JSON.stringify({ defaultModel: "groq:llama-3.3-70b-versatile" }), cookie: tester });
    expect(badDefault.response.status).toBe(400);
    const okDefault = await call("/api/settings", { method: "PUT", body: JSON.stringify({ defaultModel: "groq:openai/gpt-oss-120b" }), cookie: tester });
    expect(okDefault.json.settings.defaultModel).toBe("groq:openai/gpt-oss-120b");

    // The admin removes it: the user's saved default quietly becomes Auto; they can still chat and save settings.
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ userModels: [] }), cookie: admin });
    expect((await me(tester)).json.settings.defaultModel).toBe("auto");
    expect((await post(tester, { message: "still works" })).response.status).toBe(200);
    const otherSetting = await call("/api/settings", { method: "PUT", body: JSON.stringify({ systemPrompt: "Be brief." }), cookie: tester });
    expect(otherSetting.response.status).toBe(200);
    expect(otherSetting.json.settings).toMatchObject({ systemPrompt: "Be brief.", defaultModel: "auto" });
  });

  it("saving App settings never touches the model list, and vice versa", async () => {
    const admin = await devLogin("octocat");
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ userModels: [{ value: "groq:m", label: "M" }] }), cookie: admin });
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ signupsOpen: false, showReasoningToUsers: true }), cookie: admin });
    const s = (await call("/api/admin/settings", { cookie: admin })).json.settings;
    expect(s).toMatchObject({ signupsOpen: false, showReasoningToUsers: true, userModels: [{ value: "groq:m", label: "M" }] });
  });
});
