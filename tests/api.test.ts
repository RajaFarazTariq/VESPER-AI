import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseParser } from "../src/shared/sse";
import type { ChatStreamEvent } from "../src/shared/types";
import { app } from "../src/worker/app";
import { clearModelMemoryCache } from "../src/worker/llm/catalog";

const ORIGIN = "http://localhost";
type ExtraEnv = Partial<Record<string, string>>;

async function call(path: string, init: RequestInit & { cookie?: string; env?: ExtraEnv } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), { ...env, ...init.env }, ctx);
  const text = await response.text(); // read fully first: streamed bodies only finish once consumed
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function login(user = "octocat", extra: ExtraEnv = {}): Promise<string> {
  const { response } = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: user }), env: extra });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)(sid=[^;]+)/.exec(setCookie);
  expect(match).not.toBeNull();
  return match![1]!;
}

function parseEvents(text: string): ChatStreamEvent[] {
  const parser = new SseParser();
  return [...parser.feed(text), ...parser.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
}

const sseResponse = (parts: string[]) =>
  new Response(
    parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("") +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Route mocked outbound requests by URL. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

const PROVIDERS: ExtraEnv = {
  GROQ_API_KEY: "test-groq",
  GEMINI_API_KEY: "test-gemini",
  GROQ_BASE_URL: "https://groq.test/v1",
  GEMINI_BASE_URL: "https://gemini.test/v1",
};

afterEach(() => {
  vi.restoreAllMocks();
  clearModelMemoryCache();
});

describe("health and auth", () => {
  it("reports health", async () => {
    const { response, json } = await call("/api/health");
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, database: "ok" });
  });

  it("requires a session for protected endpoints", async () => {
    const { response, json } = await call("/api/auth/me");
    expect(response.status).toBe(401);
    expect(json.error.code).toBe("unauthorized");
  });

  it("dev login only works for allow-listed users, only on localhost, only when enabled", async () => {
    const denied = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: "mallory" }) });
    expect(denied.response.status).toBe(403);

    const disabled = await call("/api/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ login: "octocat" }),
      env: { DEV_LOGIN: "false" },
    });
    expect(disabled.response.status).toBe(404);

    const ctx = createExecutionContext();
    const remote = await app.fetch(
      new Request("https://my-app.example.workers.dev/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "octocat" }),
      }),
      env,
      ctx,
    );
    expect(remote.status).toBe(404);

    const cookie = await login("octocat");
    const me = await call("/api/auth/me", { cookie });
    expect(me.response.status).toBe(200);
    expect(me.json.user.login).toBe("octocat");
    expect(me.json.settings.defaultModel).toBe("auto");
  });

  it("revokes access as soon as a user is removed from the allowlist", async () => {
    const cookie = await login("octocat");
    const me = await call("/api/auth/me", { cookie, env: { ALLOWED_GITHUB_USERS: "someone-else" } });
    expect(me.response.status).toBe(401);
  });

  it("logout invalidates the session", async () => {
    const cookie = await login();
    const out = await call("/api/auth/logout", { method: "POST", body: "{}", cookie });
    expect(out.response.status).toBe(200);
    expect((await call("/api/auth/me", { cookie })).response.status).toBe(401);
  });

  it("blocks cross-origin and non-JSON state-changing requests", async () => {
    const cookie = await login();
    const evil = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ systemPrompt: "x" }),
      cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(evil.response.status).toBe(403);
    const form = await call("/api/settings", {
      method: "PUT",
      body: "systemPrompt=x",
      cookie,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.response.status).toBe(415);
  });
});

describe("GitHub OAuth", () => {
  const GH: ExtraEnv = {
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    GITHUB_OAUTH_BASE_URL: "https://gh.test",
    GITHUB_API_BASE_URL: "https://api.gh.test",
  };

  async function startLogin() {
    const { response } = await call("/api/auth/github/login", { env: GH });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://gh.test/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/github/callback");
    const state = location.searchParams.get("state")!;
    const cookie = /oauth_state=[^;]+/.exec(response.headers.get("set-cookie") ?? "")![0];
    return { state, cookie };
  }

  it("signs in an allow-listed GitHub user", async () => {
    const { state, cookie } = await startLogin();
    const fetchSpy = mockFetch((url) => {
      if (url === "https://gh.test/login/oauth/access_token") return jsonResponse({ access_token: "gho_test" });
      if (url === "https://api.gh.test/user") return jsonResponse({ id: 42, login: "OctoCat", name: "Octo", avatar_url: null });
      return new Response("unexpected", { status: 500 });
    });
    const { response } = await call(`/api/auth/github/callback?code=abc&state=${state}`, { cookie, env: GH });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const session = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
    const me = await call("/api/auth/me", { cookie: session });
    expect(me.json.user.login).toBe("OctoCat");
    const tokenCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("access_token"))!;
    expect(JSON.parse(String(tokenCall[1]?.body))).toMatchObject({ client_id: "cid", client_secret: "csecret", code: "abc" });
  });

  it("rejects a mismatched state", async () => {
    const { cookie } = await startLogin();
    const { response } = await call("/api/auth/github/callback?code=abc&state=wrong", { cookie, env: GH });
    expect(response.headers.get("location")).toBe("/?auth_error=invalid_state");
  });

  it("rejects users who are not on the allowlist", async () => {
    const { state, cookie } = await startLogin();
    mockFetch((url) =>
      url.endsWith("access_token") ? jsonResponse({ access_token: "t" }) : jsonResponse({ id: 7, login: "mallory", name: null, avatar_url: null }),
    );
    const { response } = await call(`/api/auth/github/callback?code=abc&state=${state}`, { cookie, env: GH });
    expect(response.headers.get("location")).toBe("/?auth_error=not_allowed");
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(/(?:^|,\s*)sid=/);
  });
});

describe("chat", () => {
  it("streams a reply, falls back from a rate-limited provider and persists the turn", async () => {
    const cookie = await login();
    let lastPrompt: unknown;
    const fetchSpy = mockFetch((url, init) => {
      if (url === "https://groq.test/v1/chat/completions") {
        return jsonResponse({ error: { message: "Rate limit reached for model" } }, 429, { "retry-after": "30" });
      }
      if (url === "https://gemini.test/v1/chat/completions") {
        const body = JSON.parse(String(init?.body));
        expect(body.stream).toBe(true);
        expect(body.messages[0].role).toBe("system");
        lastPrompt = body.messages.at(-1);
        return sseResponse(["2 + 2 ", "= **4**"]);
      }
      return new Response("unexpected " + url, { status: 500 });
    });

    const { response, text } = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "What is 2+2?", model: "auto" }),
      cookie,
      env: PROVIDERS,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseEvents(text);
    expect(events.map((e) => e.type)).toEqual(["conversation", "user_message", "attempt", "fallback", "attempt", "delta", "delta", "done"]);
    expect(lastPrompt).toEqual({ role: "user", content: "What is 2+2?" });
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.message).toMatchObject({ role: "assistant", content: "2 + 2 = **4**", provider: "gemini", status: "complete" });
    const conversationId = (events[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;

    const list = await call("/api/conversations", { cookie });
    expect(list.json.conversations[0]).toMatchObject({ id: conversationId, title: "What is 2+2?" });
    const detail = await call(`/api/conversations/${conversationId}`, { cookie });
    expect(detail.json.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);

    // Groq is now cooling down, so the next message goes straight to Gemini.
    fetchSpy.mockClear();
    const second = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, message: "And 3+3?", model: "auto" }),
      cookie,
      env: PROVIDERS,
    });
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(["https://gemini.test/v1/chat/completions"]);
    expect(parseEvents(second.text).at(-1)?.type).toBe("done");
    expect(lastPrompt).toEqual({ role: "user", content: "And 3+3?" });

    const models = await call("/api/models", { cookie, env: PROVIDERS });
    const groq = models.json.providers.find((p: { id: string }) => p.id === "groq");
    expect(groq.cooldownUntil).toBeGreaterThan(Date.now());
    expect(groq.today.failures).toBeGreaterThanOrEqual(1);
  });

  it("saves a failed turn as an error message and supports regenerate", async () => {
    const cookie = await login();
    let fail = true;
    mockFetch((url) => {
      if (url.startsWith("https://groq.test")) {
        return fail ? jsonResponse({ error: { message: "bad key" } }, 401) : sseResponse(["fixed"]);
      }
      return new Response("unexpected", { status: 500 });
    });
    const env1 = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" };
    const first = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hello" }), cookie, env: env1 });
    const events = parseEvents(first.text);
    const error = events.at(-1) as Extract<ChatStreamEvent, { type: "error" }>;
    expect(error.type).toBe("error");
    expect(error.code).toBe("auth");
    expect(error.assistantMessage?.status).toBe("error");
    const conversationId = (events[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;

    fail = false;
    const retry = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, regenerate: true, model: "groq:openai/gpt-oss-120b" }),
      cookie,
      env: env1,
    });
    expect(parseEvents(retry.text).at(-1)?.type).toBe("done");
    const detail = await call(`/api/conversations/${conversationId}`, { cookie });
    expect(detail.json.messages.map((m: { role: string; status: string }) => `${m.role}:${m.status}`)).toEqual([
      "user:complete",
      "assistant:complete",
    ]);
  });

  it("returns 503 and creates nothing when no provider is configured", async () => {
    const cookie = await login();
    const { response, json } = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }), cookie });
    expect(response.status).toBe(503);
    expect(json.error.code).toBe("no_providers");
    expect((await call("/api/conversations", { cookie })).json.conversations).toEqual([]);
  });

  it("refuses OpenRouter models that are not free", async () => {
    const cookie = await login();
    const { response, json } = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hi", model: "openrouter:openai/gpt-5" }),
      cookie,
      env: { OPENROUTER_API_KEY: "k" },
    });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_model");
  });

  it("validates input", async () => {
    const cookie = await login();
    const empty = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "   " }), cookie, env: PROVIDERS });
    expect(empty.response.status).toBe(400);
    const huge = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "x".repeat(40_000) }), cookie, env: PROVIDERS });
    expect(huge.response.status).toBe(400);
    const badJson = await call("/api/chat", { method: "POST", body: "{nope", cookie, env: PROVIDERS });
    expect(badJson.response.status).toBe(400);
  });

  it("rate-limits chat per user", async () => {
    const cookie = await login();
    mockFetch(() => sseResponse(["ok"]));
    const limited = { ...PROVIDERS, CHAT_RATE_LIMIT_PER_MINUTE: "1" };
    const first = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "one" }), cookie, env: limited });
    expect(first.response.status).toBe(200);
    const second = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "two" }), cookie, env: limited });
    expect(second.response.status).toBe(429);
    expect(second.response.headers.get("retry-after")).not.toBeNull();
  });

  it("stores local (Ollama) turns prepared and completed by the browser", async () => {
    const cookie = await login();
    const prepared = await call("/api/chat/local/prepare", {
      method: "POST",
      body: JSON.stringify({ message: "local hello", model: "ollama:llama3.2:3b" }),
      cookie,
    });
    expect(prepared.response.status).toBe(200);
    expect(prepared.json.messages.at(-1)).toEqual({ role: "user", content: "local hello" });
    const conversationId = prepared.json.conversation.id;
    const completed = await call("/api/chat/local/complete", {
      method: "POST",
      body: JSON.stringify({ conversationId, model: "ollama:llama3.2:3b", content: "hi from ollama", status: "complete" }),
      cookie,
    });
    expect(completed.json.message).toMatchObject({ provider: "ollama", model: "llama3.2:3b", content: "hi from ollama" });
  });
});

describe("conversations and settings", () => {
  it("isolates conversations between users, and supports rename and delete", async () => {
    const owner = await login("octocat");
    mockFetch(() => sseResponse(["hi"]));
    const chat = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "secret plans" }), cookie: owner, env: PROVIDERS });
    const id = (parseEvents(chat.text)[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;

    const intruder = await login("second-user");
    expect((await call(`/api/conversations/${id}`, { cookie: intruder })).response.status).toBe(404);
    expect((await call(`/api/conversations/${id}`, { method: "DELETE", cookie: intruder })).response.status).toBe(404);
    expect((await call("/api/conversations", { cookie: intruder })).json.conversations).toEqual([]);

    const renamed = await call(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: "Renamed" }), cookie: owner });
    expect(renamed.json.conversation.title).toBe("Renamed");
    expect((await call(`/api/conversations/${id}`, { method: "DELETE", cookie: owner })).response.status).toBe(200);
    expect((await call(`/api/conversations/${id}`, { cookie: owner })).response.status).toBe(404);
    expect((await call("/api/conversations/not-a-uuid", { cookie: owner })).response.status).toBe(404);
  });

  it("updates settings partially and validates them", async () => {
    const cookie = await login();
    const ok = await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ systemPrompt: "Answer in British English.", defaultModel: "groq:openai/gpt-oss-20b" }),
      cookie,
    });
    expect(ok.json.settings).toMatchObject({ systemPrompt: "Answer in British English.", defaultModel: "groq:openai/gpt-oss-20b", fallback: true });
    const bad = await call("/api/settings", { method: "PUT", body: JSON.stringify({ ollamaUrl: "file:///etc/passwd" }), cookie });
    expect(bad.response.status).toBe(400);
    const me = await call("/api/auth/me", { cookie });
    expect(me.json.settings.systemPrompt).toBe("Answer in British English.");
  });

  it("lists live models, filtering out non-chat models", async () => {
    const cookie = await login();
    mockFetch((url) => {
      if (url === "https://groq.test/v1/models") {
        return jsonResponse({
          data: [
            { id: "openai/gpt-oss-120b", context_window: 131072 },
            { id: "whisper-large-v3" },
            { id: "meta-llama/llama-guard-4-12b" },
          ],
        });
      }
      return jsonResponse({ data: [] });
    });
    const { json } = await call("/api/models?refresh=1", { cookie, env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" } });
    const groq = json.providers.find((p: { id: string }) => p.id === "groq");
    expect(groq.configured).toBe(true);
    expect(groq.models).toEqual([{ id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b", contextLength: 131072 }]);
    const gemini = json.providers.find((p: { id: string }) => p.id === "gemini");
    expect(gemini.configured).toBe(false);
  });
});

describe("phase 5: tools and memory over HTTP", () => {
  const toolCallResponse = (name: string, args: object) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );

  it("streams tool activity, saves it with the reply, and offers only enabled tools", async () => {
    const cookie = await login();
    const bodies: any[] = [];
    mockFetch((url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return bodies.length === 1 ? toolCallResponse("calculator", { expression: "17 * 23" }) : sseResponse(["17 × 23 = ", "**391**"]);
    });
    const { text } = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "What is 17*23?" }),
      cookie,
      env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" },
    });
    const events = parseEvents(text);
    const toolEvents = events.filter((e) => e.type === "tool") as Extract<ChatStreamEvent, { type: "tool" }>[];
    expect(toolEvents.map((e) => e.tool.status)).toEqual(["running", "done"]);
    expect(toolEvents[1]!.tool.summary).toBe("17 * 23 = 391");
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.message.content).toBe("17 × 23 = **391**");
    expect(done.message.tools?.[0]).toMatchObject({ name: "calculator", status: "done" });

    // The tool result went back to the model, and the system prompt mentions the tools.
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(["calculator", "current_datetime", "remember", "forget"]);
    expect(bodies[0].messages[0].content).toContain("Tools available");
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });

    // Tool activity is persisted and reloads with the conversation.
    const conversationId = (events[0] as Extract<ChatStreamEvent, { type: "conversation" }>).conversation.id;
    const detail = await call(`/api/conversations/${conversationId}`, { cookie });
    expect(detail.json.messages[1].tools[0]).toMatchObject({ name: "calculator", summary: "17 * 23 = 391" });
    // Later turns only replay the final text, not the tool transcript.
    bodies.length = 0;
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse(["ok"]);
    });
    await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, message: "thanks" }),
      cookie,
      env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" },
    });
    expect(bodies[0].messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);

    // With tools switched off, none are offered.
    await call("/api/settings", { method: "PUT", body: JSON.stringify({ toolsEnabled: false }), cookie });
    bodies.length = 0;
    await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      cookie,
      env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" },
    });
    expect(bodies[0].tools).toBeUndefined();
  });

  it("manages memories through the API and injects them into prompts", async () => {
    const cookie = await login();
    const added = await call("/api/memories", { method: "POST", body: JSON.stringify({ content: "  Works in   PKT (UTC+5). " }), cookie });
    expect(added.response.status).toBe(201);
    expect(added.json.memory).toMatchObject({ content: "Works in PKT (UTC+5).", source: "user" });
    expect((await call("/api/memories", { cookie })).json.memories).toHaveLength(1);

    let system = "";
    mockFetch((_url, init) => {
      system = JSON.parse(String(init?.body)).messages[0].content;
      return sseResponse(["ok"]);
    });
    await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "What timezone am I in?" }),
      cookie,
      env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" },
    });
    expect(system).toContain("Works in PKT (UTC+5).");

    // Memory off: not injected.
    await call("/api/settings", { method: "PUT", body: JSON.stringify({ memoryEnabled: false }), cookie });
    await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "And now?" }),
      cookie,
      env: { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" },
    });
    expect(system).not.toContain("Works in PKT");

    // Another user can't see or delete it.
    const other = await login("second-user");
    expect((await call("/api/memories", { cookie: other })).json.memories).toEqual([]);
    expect((await call(`/api/memories/${added.json.memory.id}`, { method: "DELETE", cookie: other })).response.status).toBe(404);

    expect((await call(`/api/memories/${added.json.memory.id}`, { method: "DELETE", cookie })).response.status).toBe(200);
    expect((await call("/api/memories", { method: "POST", body: JSON.stringify({ content: "" }), cookie })).response.status).toBe(400);
    await call("/api/memories", { method: "POST", body: JSON.stringify({ content: "a" }), cookie });
    expect((await call("/api/memories", { method: "DELETE", cookie })).json.deleted).toBe(1);
  });

  it("lists tools and validates tool settings", async () => {
    const cookie = await login();
    const { json } = await call("/api/tools", { cookie });
    expect(json.tools.map((t: any) => [t.name, t.risk])).toEqual([
      ["calculator", "read"],
      ["current_datetime", "read"],
      ["remember", "write"],
      ["forget", "write"],
    ]);
    const bad = await call("/api/settings", { method: "PUT", body: JSON.stringify({ disabledTools: "calculator" }), cookie });
    expect(bad.response.status).toBe(400);
    const ok = await call("/api/settings", { method: "PUT", body: JSON.stringify({ disabledTools: ["calculator"] }), cookie });
    expect(ok.json.settings.disabledTools).toEqual(["calculator"]);
  });
});
