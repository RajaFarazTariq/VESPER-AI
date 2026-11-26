/**
 * v0.19.0 "More tasks": lists and notes (VESPER's own data: the tools and Settings → Lists & notes, the user's own
 * only, with limits; notes refuse sensitive data like memory) and the Open button for websites (well-known names, or
 * addresses the user typed; never private hosts).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseParser } from "../src/shared/sse";
import { DEFAULT_SETTINGS, type ChatStreamEvent } from "../src/shared/types";
import { app } from "../src/worker/app";
import { MAX_ITEMS, MAX_LISTS, MAX_NOTES } from "../src/worker/db/lists";
import { clearModelMemoryCache } from "../src/worker/llm/catalog";
import { planPrefetch } from "../src/worker/llm/prefetch";
import { LIST_TOOLS } from "../src/worker/tools/lists";
import { OPEN_WEBSITE_TOOLS, websiteFor } from "../src/worker/tools/open-website";
import type { ToolContext } from "../src/worker/tools/types";

const ORIGIN = "http://localhost";
const TEST_ENV = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1" };

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), { ...env, ...TEST_ENV }, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}
async function login(name: string) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`${ORIGIN}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ login: name }), headers: { "content-type": "application/json" } }),
    { ...env, ...TEST_ENV },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  return { cookie, id: (await call("/api/auth/me", { cookie })).json.user.id as string };
}
const send = (method: string, path: string, body: unknown, cookie: string) =>
  call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cookie });

const ctxFor = (userId: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  db: env.DB,
  userId,
  settings: DEFAULT_SETTINGS,
  now: new Date("2026-12-06T12:00:00Z"),
  timeZone: "Asia/Karachi",
  ...extra,
});
const run = async (name: string, args: object, ctx: ToolContext) => {
  const t = [...LIST_TOOLS, ...OPEN_WEBSITE_TOOLS].find((x) => x.name === name)!;
  const out = await t.run(t.schema.parse(args), ctx);
  return { ...out, result: JSON.parse(out.content) };
};

afterEach(() => {
  vi.restoreAllMocks();
  clearModelMemoryCache();
});

describe("lists", () => {
  it("adds, shows, marks done, removes, clears and renames, by the names people use", async () => {
    const owner = await login("octocat");
    const ctx = ctxFor(owner.id);
    // "my shopping list" is the Shopping list; an item already open on it isn't added twice.
    const added = await run("lists", { action: "add", list: "my shopping list", items: ["Milk", "Eggs", "milk"] }, ctx);
    expect(added.result).toMatchObject({ list: "Shopping", added: ["Milk", "Eggs"], already_on_the_list: ["milk"], open: ["Milk", "Eggs"] });
    // Without a name: the To-do list; "show" also names the other lists.
    await run("lists", { action: "add", items: ["Call Ali", "Pay rent"] }, ctx);
    expect((await run("lists", { action: "show" }, ctx)).result).toEqual({ list: "To-do", open: ["Call Ali", "Pay rent"], other_lists: [{ name: "Shopping", open: 2 }] });
    // "mark 'call Ali' done": by its text in any case; a few words of it are enough when only one item has them.
    const done = await run("lists", { action: "done", list: "todo", items: ["'call ali'"] }, ctx);
    expect(done.result).toMatchObject({ marked_done: ["Call Ali"], open: ["Pay rent"], done: ["Call Ali"] });
    expect((await run("lists", { action: "undo", items: ["call ali"] }, ctx)).result.open).toEqual(["Call Ali", "Pay rent"]);
    await run("lists", { action: "done", items: ["rent"] }, ctx);
    expect((await run("lists", { action: "remove", list: "Shopping", items: ["milk"] }, ctx)).result).toMatchObject({ removed: ["Milk"], open: ["Eggs"] });
    expect((await run("lists", { action: "clear_done" }, ctx)).result).toMatchObject({ removed_done_items: 1, open: ["Call Ali"] });
    await expect(run("lists", { action: "done", items: ["bread"] }, ctx)).rejects.toThrow(/"bread" isn't on the list\. The To-do list has: "Call Ali"/);
    await run("lists", { action: "add", items: ["Call mum"] }, ctx);
    await expect(run("lists", { action: "done", items: ["call"] }, ctx)).rejects.toThrow(/matches several items/);
    expect((await run("lists", { action: "rename", list: "Shopping", new_name: "Groceries" }, ctx)).result).toMatchObject({ from: "Shopping", to: "Groceries" });
    await expect(run("lists", { action: "rename", list: "Groceries", new_name: "to do" }, ctx)).rejects.toThrow(/already a list called "To-do"/);
    expect((await run("lists", { action: "show", list: "Packing" }, ctx)).result).toMatchObject({ exists: false });
    expect((await run("lists", { action: "delete_list", list: "Groceries" }, ctx)).result).toEqual({ deleted_list: "Groceries", items_deleted: 1 });
    await expect(run("lists", { action: "remove", list: "Groceries", items: ["Eggs"] }, ctx)).rejects.toThrow(/There is no "Groceries" list/);
  });

  it("matches items safely, takes a blank list as To-do, keeps the order and refuses sensitive items", async () => {
    const owner = await login("octocat");
    const ctx = ctxFor(owner.id);
    // A blank list name (a filled-in optional field) is the To-do list; two adds at the same moment keep their order.
    await run("lists", { action: "add", list: "", items: ["Milk", "Bread"] }, ctx);
    expect((await run("lists", { action: "add", list: " ", items: ["Eggs"] }, ctx)).result).toMatchObject({ list: "To-do", open: ["Milk", "Bread", "Eggs"] });
    // "oat milk" isn't "Milk"; a bare number, quotes only or one or two letters match nothing.
    for (const wanted of ["oat milk", "2", "''", "mi"]) {
      await expect(run("lists", { action: "remove", items: [wanted] }, ctx), wanted).rejects.toThrow(/isn't on the list|say the item's words/);
    }
    expect((await run("lists", { action: "show", list: "" }, ctx)).result.open).toEqual(["Milk", "Bread", "Eggs"]);
    // Like memory and notes, in the chat and in Settings.
    await expect(run("lists", { action: "add", items: ["Call Ali 0300 1234567"] }, ctx)).rejects.toThrow(/^Not saved: it looks like a phone number/);
    const list = (await call("/api/lists", { cookie: owner.cookie })).json.lists[0];
    const edited = await send("PATCH", `/api/lists/${list.id}/items/${list.items[0].id}`, { text: "PIN 4421" }, owner.cookie);
    expect(edited.status).toBe(400);
    expect(edited.json.error.message).toMatch(/^Not saved: it looks like a password, PIN or other secret/);
  });

  it("doesn't search the web first for list, note or open requests, but still for questions like 'Open source…'", () => {
    const offered = new Set(["web_search", "lists", "notes", "open_website"]);
    for (const q of ["What's on my to-do list today?", "Note that the latest gate code is on the green card", "Open YouTube now", "go to github.com/octocat"]) {
      expect(planPrefetch(q, offered), q).toBeNull();
    }
    expect(planPrefetch("Open source vs closed source databases: latest trends in 2026?", offered)?.name).toBe("web_search");
    expect(planPrefetch("Go to market strategy news this week", offered)?.name).toBe("web_search");
  });

  it("keeps the limits: 20 lists, 200 items a list, 200 characters an item, 40 a name", async () => {
    const owner = await login("octocat");
    const ctx = ctxFor(owner.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
       INSERT INTO lists (id, user_id, name, name_key, created_at, updated_at) SELECT 'l' || i, ?1, 'List ' || i, 'list ' || i, i, i FROM n`,
    )
      .bind(owner.id, MAX_LISTS)
      .run();
    await expect(run("lists", { action: "add", list: "One more", items: ["x"] }, ctx)).rejects.toThrow(/already has 20 lists/);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
       INSERT INTO list_items (id, list_id, user_id, text, done, created_at) SELECT 'i' || i, 'l0', ?1, 'Item ' || i, 0, i FROM n`,
    )
      .bind(owner.id, MAX_ITEMS)
      .run();
    const full = await run("lists", { action: "add", list: "List 0", items: ["Last one", "Too many"] }, ctx);
    expect(full.result).toMatchObject({ added: ["Last one"], not_added_list_full: ["Too many"] });
    await expect(run("lists", { action: "add", list: "List 1", items: ["x".repeat(201)] }, ctx)).rejects.toThrow(/under 200 characters/);
    await expect(run("lists", { action: "add", list: "y".repeat(41), items: ["x"] }, ctx)).rejects.toThrow(/under 40 characters/);
  });

  it("Settings → Lists & notes: shows, ticks, edits, renames and deletes the user's own only", async () => {
    const owner = await login("octocat");
    const eve = await login("eve");
    await run("lists", { action: "add", list: "Shopping", items: ["Milk", "Eggs"] }, ctxFor(owner.id));
    await run("notes", { action: "add", text: "The gate code is on the green card." }, ctxFor(owner.id));
    const all = (await call("/api/lists", { cookie: owner.cookie })).json;
    expect(all.lists.map((l: any) => [l.name, l.items.map((i: any) => [i.text, i.done])])).toEqual([["Shopping", [["Milk", false], ["Eggs", false]]]]);
    expect(all.notes.map((n: any) => n.text)).toEqual(["The gate code is on the green card."]);
    const list = all.lists[0];
    const milk = list.items[0];
    const note = all.notes[0];

    // Someone else sees nothing and can change nothing.
    expect((await call("/api/lists", { cookie: eve.cookie })).json).toEqual({ lists: [], notes: [] });
    const attempts: [string, string, unknown][] = [
      ["PATCH", `/api/lists/${list.id}`, { name: "Mine" }],
      ["PATCH", `/api/lists/${list.id}/items/${milk.id}`, { done: true }],
      ["DELETE", `/api/lists/${list.id}/items/${milk.id}`, undefined],
      ["DELETE", `/api/lists/${list.id}`, undefined],
      ["PATCH", `/api/notes/${note.id}`, { text: "Mine now" }],
      ["DELETE", `/api/notes/${note.id}`, undefined],
    ];
    for (const [method, path, body] of attempts) expect((await send(method, path, body, eve.cookie)).status, `${method} ${path}`).toBe(404);

    const ticked = await send("PATCH", `/api/lists/${list.id}/items/${milk.id}`, { done: true }, owner.cookie);
    expect(ticked.json.list.items[0]).toMatchObject({ text: "Milk", done: true });
    const edited = await send("PATCH", `/api/lists/${list.id}/items/${milk.id}`, { text: "  Oat   milk " }, owner.cookie);
    expect(edited.json.list.items[0]).toMatchObject({ text: "Oat milk", done: true });
    expect((await send("DELETE", `/api/lists/${list.id}/items/${milk.id}`, undefined, owner.cookie)).json.list.items.map((i: any) => i.text)).toEqual(["Eggs"]);
    expect((await send("PATCH", `/api/lists/${list.id}`, { name: "groceries list" }, owner.cookie)).json.list).toMatchObject({ name: "Groceries" });
    // Notes edited in Settings are checked like memories.
    const refused = await send("PATCH", `/api/notes/${note.id}`, { text: "Card 4111 1111 1111 1111" }, owner.cookie);
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toMatch(/^Not saved: it looks like a card number/);
    expect((await send("PATCH", `/api/notes/${note.id}`, { text: "Gate code: on the green card" }, owner.cookie)).json.note).toMatchObject({ text: "Gate code: on the green card" });
    expect((await send("DELETE", `/api/lists/${list.id}`, undefined, owner.cookie)).json).toEqual({ ok: true });
    expect((await send("DELETE", `/api/notes/${note.id}`, undefined, owner.cookie)).json).toEqual({ ok: true });
    expect((await call("/api/lists", { cookie: owner.cookie })).json).toEqual({ lists: [], notes: [] });
  });
});

describe("notes", () => {
  it("saves, finds and deletes notes, refuses sensitive ones like memory, and keeps at most 500", async () => {
    const owner = await login("octocat");
    const ctx = ctxFor(owner.id);
    const gate = await run("notes", { action: "add", text: "The gate code is on the green card." }, ctx);
    expect(gate.result).toMatchObject({ saved: true });
    await run("notes", { action: "add", text: "Parking is on level 3." }, ctx);
    const found = await run("notes", { action: "search", query: "what did I note about the gates?" }, ctx);
    expect(found.result.notes).toEqual([{ id: gate.result.id, saved: "Sun 6 Dec 2026", text: "The gate code is on the green card." }]);
    expect((await run("notes", { action: "search", query: "passport" }, ctx)).result.notes).toEqual([]);
    expect((await run("notes", { action: "show_recent" }, ctx)).result.notes.map((n: any) => n.text)).toEqual(["Parking is on level 3.", "The gate code is on the green card."]);
    expect((await run("notes", { action: "delete", id: gate.result.id }, ctx)).result).toMatchObject({ deleted: true });
    await expect(run("notes", { action: "delete", id: gate.result.id }, ctx)).rejects.toThrow(/No note with id/);

    // Exactly like memory: never kept, with the same plain message.
    await expect(run("notes", { action: "add", text: "My bank PIN is 4421" }, ctx)).rejects.toThrow(/^Not saved: it looks like a password, PIN or other secret\. Passwords, card or bank numbers/);
    await expect(run("notes", { action: "add", text: "Ali's number is 0300 1234567" }, ctx)).rejects.toThrow(/it looks like a phone number/);
    await expect(run("notes", { action: "add", text: "x".repeat(2_001) }, ctx)).rejects.toThrow(/at most 2,000 characters/);

    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO notes (id, user_id, text, created_at, updated_at) SELECT 'n' || i, ?1, 'Note ' || i, i, i FROM n`,
    )
      .bind(owner.id, MAX_NOTES)
      .run();
    await expect(run("notes", { action: "add", text: "One more" }, ctx)).rejects.toThrow(/has 500 notes/);
    // Settings gets the newest 200.
    expect((await call("/api/lists", { cookie: owner.cookie })).json.notes).toHaveLength(200);
  });
});

describe("open a website", () => {
  it("maps well-known names, and other addresses only when the user typed them; never private hosts", () => {
    expect(websiteFor("YouTube", "")).toEqual({ url: "https://www.youtube.com", title: "YouTube" });
    expect(websiteFor("WhatsApp Web", "").url).toBe("https://web.whatsapp.com");
    expect(websiteFor("X/Twitter", "").url).toBe("https://x.com");
    expect(websiteFor("the Daraz website", "").url).toBe("https://www.daraz.pk");
    expect(websiteFor("Google Drive", "").url).toBe("https://drive.google.com");
    expect(websiteFor("github.com/octocat", "go to github.com/octocat please")).toEqual({ url: "https://github.com/octocat", title: "github.com" });
    expect(websiteFor("https://www.example.org/a?b=1", "open www.example.org/a?b=1").url).toBe("https://www.example.org/a?b=1");
    // Put together by the model or taken from a page: refused, also when only part of it was typed.
    expect(() => websiteFor("https://example.org/?q=secret", "open example.org")).toThrow(/Only addresses the user typed/);
    expect(() => websiteFor("evil.com", "open notevil.com")).toThrow(/Only addresses the user typed/);
    expect(() => websiteFor("example.com", "open example.com.evil.net")).toThrow(/Only addresses the user typed/);
    for (const site of ["http://localhost:8787", "http://192.168.1.1", "http://router.local", "http://8.8.8.8", "http://[::1]/", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(() => websiteFor(site, `open ${site}`), site).toThrow();
    }
    expect(() => websiteFor("my bank", "open my bank")).toThrow(/isn't a site VESPER knows by name/);
  });

  it("puts an Open button on the reply (for every user), never one for an address the user didn't type", async () => {
    const ann = await login("ann");
    let step = 0;
    const requests: any[] = [];
    const site = { value: "YouTube" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://groq.test/v1/chat/completions") return new Response(`unexpected ${url}`, { status: 500 });
      requests.push(JSON.parse(String(init?.body)));
      const chunk = (step++ % 2 === 0
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_o1", type: "function", function: { name: "open_website", arguments: JSON.stringify({ site: site.value }) } }] } }] }
        : { choices: [{ delta: { content: "Tap Open to go there." } }] });
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const chat = async (message: string) => {
      const res = await send("POST", "/api/chat", { message }, ann.cookie);
      const p = new SseParser();
      const events = [...p.feed(res.text), ...p.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
      return (events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>).message;
    };
    const opened = await chat("Open YouTube");
    expect(requests[0].messages[0].content).toContain("open_website: only sites the user asked for.");
    // The tool result tells the model what to say.
    expect(requests[1].messages.at(-1).content).toContain('Say \\"Tap Open to go there.\\"');
    expect(opened.tools![0]).toMatchObject({ name: "open_website", status: "done", link: { url: "https://www.youtube.com", title: "YouTube" } });
    // An address that isn't in what the user typed: no button.
    site.value = "https://example.org/?data=secret";
    const refused = await chat("Open example.org");
    expect(refused.tools![0]).toMatchObject({ name: "open_website", status: "error" });
    expect(refused.tools![0]!.link).toBeUndefined();
  });
});
