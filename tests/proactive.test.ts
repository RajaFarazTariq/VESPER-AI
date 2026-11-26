/**
 * v0.18.0 "Proactive VESPER": Web Push encryption (RFC 8291 test vector) and VAPID (RFC 8292), saving browsers and
 * settings, the reminder tools, and the every-minute run: reminders, daily briefings and meeting alerts, each sent once.
 * Push services and Google are faked: every request VESPER makes is checked (and each notification decrypted).
 */
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { app } from "../src/worker/app";
import worker from "../src/worker/index";
import { briefingDue, runProactive } from "../src/worker/jobs/proactive";
import { seal } from "../src/worker/lib/secret-box";
import { encryptPush, fromBase64Url, toBase64Url } from "../src/worker/push/encrypt";
import { vapidKeys } from "../src/worker/push/keys";
import { vapidToken } from "../src/worker/push/vapid";
import { addDays, dayLabel, validTimeZone, wallClock, zonedInstant } from "../src/worker/tools/google";
import { CALENDAR_SCOPE, googleTokenOwner } from "../src/worker/tools/google-client";
import { LIST_TOOLS } from "../src/worker/tools/lists";
import { REMINDER_TOOLS } from "../src/worker/tools/reminders";
import type { ToolContext } from "../src/worker/tools/types";

const ORIGIN = "http://localhost";
const TZ = "Asia/Karachi";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TEST_ENV = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_TOKEN_KEY: KEY };
const testEnv = () => ({ ...env, ...TEST_ENV }) as typeof env & typeof TEST_ENV;
/** Sun 6 Dec 2026, 17:00 in Karachi (UTC+5). */
const T0 = Date.parse("2026-12-06T12:00:00Z");
const enc = (text: string) => new TextEncoder().encode(text);
const bytes = (b64url: string) => fromBase64Url(b64url)!;

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), testEnv(), ctx);
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
    testEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  return { cookie, id: (await call("/api/auth/me", { cookie })).json.user.id as string };
}
const send = (method: string, path: string, body: unknown, cookie: string) => call(path, { method, body: JSON.stringify(body), cookie });

// ---------------------------------------------------------------- a browser, and reading what it receives

interface Browser {
  pair: CryptoKeyPair;
  p256dh: string;
  auth: string;
}
async function browser(): Promise<Browser> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { pair, p256dh: toBase64Url(raw), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
}
async function subscribe(cookie: string, endpoint: string, b: Browser, label = "Chrome on Windows") {
  return send("POST", "/api/notifications/devices", { endpoint, keys: { p256dh: b.p256dh, auth: b.auth }, label, timeZone: TZ }, cookie);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
/** What the browser's service worker would get: the receiving side of RFC 8291, written separately here. */
async function decrypt(body: Uint8Array, b: Browser): Promise<any> {
  const salt = body.slice(0, 16);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  const senderKey = body.slice(21, 21 + body[20]!);
  const sender = await crypto.subtle.importKey("raw", senderKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender } as SubtleCryptoDeriveKeyAlgorithm, b.pair.privateKey, 256));
  const ikm = await hkdf(bytes(b.auth), secret, new Uint8Array([...enc("WebPush: info\0"), ...bytes(b.p256dh), ...senderKey]), 32);
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, body.slice(21 + body[20]!)));
  expect(plain.at(-1)).toBe(2); // the padding delimiter of the last record
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

// ---------------------------------------------------------------- fake push services, Google and model

interface Pushed {
  url: string;
  headers: Headers;
  body: Uint8Array;
}
let pushed: Pushed[];
let pushStatus: (url: string) => number;
let calendarReads: URL[];
let model: (body: any) => Response;
const CALENDAR = [
  {
    id: "ev1",
    summary: "  Team standup\n",
    start: { dateTime: "2026-12-07T10:00:00+05:00" },
    end: { dateTime: "2026-12-07T10:30:00+05:00" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  },
  { id: "ev2", summary: "Client call", start: { dateTime: "2026-12-07T14:00:00+05:00" }, end: { dateTime: "2026-12-07T15:00:00+05:00" } },
  {
    id: "ev3",
    summary: "Declined",
    start: { dateTime: "2026-12-07T16:00:00+05:00" },
    end: { dateTime: "2026-12-07T17:00:00+05:00" },
    attendees: [{ email: "owner@gmail.com", self: true, responseStatus: "declined" }],
  },
];
const answer = (t: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

beforeEach(() => {
  pushed = [];
  calendarReads = [];
  pushStatus = () => 201;
  model = () => answer("ok");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/calendar/v3/calendars/primary/events") {
      calendarReads.push(url);
      const from = Date.parse(url.searchParams.get("timeMin")!);
      const to = Date.parse(url.searchParams.get("timeMax")!);
      const items = CALENDAR.filter((e) => Date.parse(e.end.dateTime) > from && Date.parse(e.start.dateTime) < to);
      return new Response(JSON.stringify({ timeZone: TZ, items }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "fcm.googleapis.com" || url.hostname.endsWith("mozilla.com")) {
      pushed.push({ url: url.href, headers: new Headers(init?.headers), body: new Uint8Array(init!.body as Uint8Array) });
      return new Response(null, { status: pushStatus(url.href) });
    }
    if (url.href === "https://groq.test/v1/chat/completions") return model(JSON.parse(String(init?.body)));
    return new Response(`unexpected ${url.href}`, { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

/** A working Google connection with Calendar allowed (tokens sealed as the connect flow stores them). */
async function connectGoogle(userId: string) {
  const owner = googleTokenOwner(userId);
  await env.DB.prepare(
    `INSERT INTO google_connections (user_id, google_sub, email, scopes, access_token, access_expires_at, refresh_token, status, created_at, updated_at)
     VALUES (?1, 'g-1', 'owner@gmail.com', ?2, ?3, ?4, ?5, 'connected', ?6, ?6)`,
  )
    .bind(userId, `openid ${CALENDAR_SCOPE}`, await seal(KEY, "access-1", owner), Date.now() + 3_600_000, await seal(KEY, "refresh-1", owner), Date.now())
    .run();
}

const tool = (name: string) => [...REMINDER_TOOLS, ...LIST_TOOLS].find((t) => t.name === name)!;
const ctxFor = (userId: string, now = T0): ToolContext => ({ db: env.DB, userId, settings: DEFAULT_SETTINGS, now: new Date(now), timeZone: TZ });
const run = async (name: string, args: object, ctx: ToolContext) => JSON.parse((await tool(name).run(tool(name).schema.parse(args), ctx)).content);

// ---------------------------------------------------------------- encryption and signing

describe("Web Push encryption and VAPID", () => {
  // RFC 8291 section 5 and Appendix A, copied from the RFC text.
  const RFC = {
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
    receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
  };

  it("reproduces the RFC 8291 example byte for byte", async () => {
    const senderPublic = bytes(RFC.senderPublic);
    const jwk = { kty: "EC", crv: "P-256", d: RFC.senderPrivate, x: toBase64Url(senderPublic.slice(1, 33)), y: toBase64Url(senderPublic.slice(33)) };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const body = await encryptPush(bytes(RFC.plaintext), { p256dh: bytes(RFC.receiverPublic), auth: bytes(RFC.authSecret) }, { salt: bytes(RFC.salt), sender: { privateKey, publicKey: senderPublic } });
    expect(new TextDecoder().decode(bytes(RFC.plaintext))).toBe("When I grow up, I want to be a watermelon");
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("keeps one key pair and signs tokens that verify with its public key", async () => {
    const keys = await vapidKeys(env.DB, "https://vesper.example");
    expect((await vapidKeys(env.DB)).publicKey).toBe(keys.publicKey);
    expect(bytes(keys.publicKey)).toHaveLength(65);
    const jwt = await vapidToken(keys, "https://fcm.googleapis.com", T0);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(bytes(header)))).toEqual({ typ: "JWT", alg: "ES256" });
    const body = JSON.parse(new TextDecoder().decode(bytes(claims)));
    expect(body).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://vesper.example" });
    expect(body.exp - T0 / 1000).toBeGreaterThan(12 * 3600);
    expect(body.exp - T0 / 1000).toBeLessThanOrEqual(24 * 3600);
    const publicKey = await crypto.subtle.importKey("raw", bytes(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes(signature), enc(`${header}.${claims}`))).toBe(true);
    // Reused for the same push service.
    expect(await vapidToken(keys, "https://fcm.googleapis.com", T0 + 60_000)).toBe(jwt);
  });
});

// ---------------------------------------------------------------- browsers and settings

describe("notification settings", () => {
  it("saves only browsers on known push services, updates by endpoint, deletes own only, at most 10", async () => {
    const owner = await login("octocat");
    const b = await browser();
    for (const endpoint of ["https://evil.example/push/1", "http://fcm.googleapis.com/fcm/send/1", "https://fcm.googleapis.com:8443/fcm/send/1", "https://notify.windows.com.evil.test/w/1"]) {
      expect((await subscribe(owner.cookie, endpoint, b)).status, endpoint).toBe(400);
    }
    expect((await send("POST", "/api/notifications/devices", { endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: "abc", auth: b.auth } }, owner.cookie)).status).toBe(400);
    const first = await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/1", b);
    expect(first.status).toBe(200);
    expect(first.json.device).toMatchObject({ label: "Chrome on Windows", lastOkAt: null });
    const again = await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/1", b, "Opera on Windows");
    expect(again.json.device).toMatchObject({ id: first.json.device.id, label: "Opera on Windows" });
    const listed = await call("/api/notifications", { cookie: owner.cookie });
    expect(listed.json.devices).toHaveLength(1);
    expect(bytes(listed.json.publicKey)).toHaveLength(65);
    expect(listed.json.prefs).toEqual({ timeZone: TZ, briefingEnabled: true, briefingTime: "22:00", meetingAlerts: true, meetingMinutes: 10 });
    expect(listed.json.reminders).toEqual([]);

    const ann = await login("ann");
    expect((await call(`/api/notifications/devices/${first.json.device.id}`, { method: "DELETE", cookie: ann.cookie })).status).toBe(404);
    expect((await call(`/api/notifications/devices/${first.json.device.id}`, { method: "DELETE", cookie: owner.cookie })).json).toEqual({ ok: true });

    for (let i = 0; i < 10; i++) expect((await subscribe(owner.cookie, `https://updates.push.services.mozilla.com/wpush/v2/${i}`, b)).status).toBe(200);
    const full = await subscribe(owner.cookie, "https://web.push.apple.com/QGx", b);
    expect(full.status).toBe(409);
    expect(full.json.error.message).toMatch(/up to 10 devices/);
  });

  it("checks the briefing and meeting alert settings", async () => {
    const owner = await login("octocat");
    for (const bad of [{ briefingTime: "25:00" }, { briefingTime: "9pm" }, { meetingMinutes: 7 }, { timeZone: "Mars/Base" }, { briefingEnabled: "yes" }]) {
      expect((await send("PUT", "/api/notifications/prefs", bad, owner.cookie)).status, JSON.stringify(bad)).toBe(400);
    }
    const saved = await send("PUT", "/api/notifications/prefs", { timeZone: TZ, briefingTime: "21:30", meetingMinutes: 15, briefingEnabled: false }, owner.cookie);
    expect(saved.json.prefs).toEqual({ timeZone: TZ, briefingEnabled: false, briefingTime: "21:30", meetingAlerts: true, meetingMinutes: 15 });
    expect((await send("PUT", "/api/notifications/prefs", { meetingAlerts: false }, owner.cookie)).json.prefs).toMatchObject({ briefingTime: "21:30", meetingAlerts: false });
  });
});

// ---------------------------------------------------------------- reminder tools

describe("reminder tools", () => {
  it("sets reminders in the user's time zone, refuses past or far times, lists and cancels them", async () => {
    const owner = await login("octocat");
    const soon = await run("set_reminder", { text: "Call\nAli", when: "in 20 minutes" }, ctxFor(owner.id));
    expect(soon).toMatchObject({ saved: true, text: "Call Ali", when: "today at 17:20", time_zone: TZ, notifications_on: false });
    expect(soon.note).toMatch(/Settings → Notifications/);
    const later = await run("set_reminder", { text: "Send the report", when: "tomorrow 09:00" }, ctxFor(owner.id));
    expect(later).toMatchObject({ when: "tomorrow at 09:00", local_time: "Mon 7 Dec 2026, 09:00" });
    expect((await run("set_reminder", { text: "Pay bills", when: "2026-12-08 18:30" }, ctxFor(owner.id))).when).toBe("Tue 8 Dec 2026 at 18:30");
    const rows = await env.DB.prepare("SELECT text, due_at FROM reminders ORDER BY due_at").all<{ text: string; due_at: number }>();
    expect(rows.results.map((r) => [r.text, new Date(r.due_at).toISOString()])).toEqual([
      ["Call Ali", "2026-12-06T12:20:00.000Z"],
      ["Send the report", "2026-12-07T04:00:00.000Z"],
      ["Pay bills", "2026-12-08T13:30:00.000Z"],
    ]);
    await expect(run("set_reminder", { text: "x", when: "2026-12-06 16:00" }, ctxFor(owner.id))).rejects.toThrow(/already passed: it's 17:00/);
    await expect(run("set_reminder", { text: "x", when: "2028-01-01 10:00" }, ctxFor(owner.id))).rejects.toThrow(/at most a year/);
    await expect(run("set_reminder", { text: "x", when: "sometime next week" }, ctxFor(owner.id))).rejects.toThrow(/Write "when"/);

    const all = await run("list_reminders", {}, ctxFor(owner.id));
    expect(all.reminders.map((r: { text: string; when: string }) => [r.text, r.when])).toEqual([
      ["Call Ali", "today at 17:20"],
      ["Send the report", "tomorrow at 09:00"],
      ["Pay bills", "Tue 8 Dec 2026 at 18:30"],
    ]);
    expect((await run("list_reminders", { day: "tomorrow" }, ctxFor(owner.id))).reminders).toHaveLength(1);
    expect(await run("cancel_reminder", { reminder_id: later.id }, ctxFor(owner.id))).toMatchObject({ cancelled: true, text: "Send the report" });
    await expect(run("cancel_reminder", { reminder_id: later.id }, ctxFor(owner.id))).rejects.toThrow(/No waiting reminder/);

    // The app: pending ones, soonest first; cancelling is for the owner only.
    expect((await call("/api/notifications", { cookie: owner.cookie })).json.reminders.map((r: { text: string }) => r.text)).toEqual(["Call Ali", "Pay bills"]);
    const ann = await login("ann");
    await expect(run("cancel_reminder", { reminder_id: soon.id }, ctxFor(ann.id))).rejects.toThrow(/No waiting reminder/);
    expect((await call(`/api/reminders/${soon.id}`, { method: "DELETE", cookie: ann.cookie })).status).toBe(404);
    expect((await call(`/api/reminders/${soon.id}`, { method: "DELETE", cookie: owner.cookie })).json).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------- the every-minute run

describe("the every-minute run", () => {
  it("sends a due reminder once to every device, encrypted and signed; a gone device is removed", async () => {
    const owner = await login("octocat");
    const chrome = await browser();
    const firefox = await browser();
    await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/chrome", chrome);
    await subscribe(owner.cookie, "https://updates.push.services.mozilla.com/wpush/v2/firefox", firefox, "Firefox on Windows");
    await send("PUT", "/api/notifications/prefs", { briefingEnabled: false, meetingAlerts: false }, owner.cookie);
    const { publicKey } = (await call("/api/notifications", { cookie: owner.cookie })).json;
    const set = await run("set_reminder", { text: "Call Ali", when: "in 20 minutes" }, ctxFor(owner.id));
    expect(set.notifications_on).toBe(true);
    pushStatus = (url) => (url.includes("mozilla") ? 410 : 201);

    // Not due yet; then two runs at once (the scheduled handler and a direct run): sent once.
    expect((await runProactive(testEnv(), T0 + 19 * 60_000)).reminders).toBe(0);
    const ctx = createExecutionContext();
    await Promise.all([
      worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: T0 + 20 * 60_000 }), testEnv(), ctx).then(() => waitOnExecutionContext(ctx)),
      runProactive(testEnv(), T0 + 20 * 60_000),
    ]);
    expect(pushed.map((p) => p.url).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/chrome", "https://updates.push.services.mozilla.com/wpush/v2/firefox"]);
    const toChrome = pushed.find((p) => p.url.includes("chrome"))!;
    expect(Object.fromEntries(["content-encoding", "ttl", "urgency", "content-type"].map((h) => [h, toChrome.headers.get(h)]))).toEqual({
      "content-encoding": "aes128gcm",
      ttl: "3600",
      urgency: "high",
      "content-type": "application/octet-stream",
    });
    const auth = /^vapid t=([\w-]+\.([\w-]+)\.[\w-]+), k=([\w-]+)$/.exec(toChrome.headers.get("authorization")!)!;
    expect(auth[3]).toBe(publicKey);
    expect(JSON.parse(new TextDecoder().decode(bytes(auth[2]!)))).toMatchObject({ aud: "https://fcm.googleapis.com", sub: ORIGIN });
    expect(await decrypt(toChrome.body, chrome)).toEqual({ title: "Reminder", body: "Call Ali · 17:20", url: "/", tag: `reminder-${set.id}`, kind: "reminder" });
    expect((await decrypt(pushed.find((p) => p.url.includes("mozilla"))!.body, firefox)).title).toBe("Reminder");

    // The device the push service said is gone was removed; the other one is marked delivered.
    const devices = (await call("/api/notifications", { cookie: owner.cookie })).json.devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ label: "Chrome on Windows", lastOkAt: T0 + 20 * 60_000 });
    expect((await runProactive(testEnv(), T0 + 21 * 60_000)).reminders).toBe(0);
    expect(pushed).toHaveLength(2);
  });

  it("sends the 22:00 briefing about tomorrow once a day, with the calendar and the reminders", async () => {
    const owner = await login("octocat");
    const chrome = await browser();
    await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/chrome", chrome);
    await send("PUT", "/api/notifications/prefs", { meetingAlerts: false }, owner.cookie);
    await connectGoogle(owner.id);
    await run("set_reminder", { text: "Send the report", when: "2026-12-07 09:00" }, ctxFor(owner.id));
    // Open to-dos (v0.19.0): the To-do list only, done items and other lists left out.
    await run("lists", { action: "add", items: ["Call Ali", "Pay rent", "Book flights"] }, ctxFor(owner.id));
    await run("lists", { action: "done", items: ["pay rent"] }, ctxFor(owner.id));
    await run("lists", { action: "add", list: "Shopping", items: ["Milk"] }, ctxFor(owner.id));
    // Someone without Google gets the reminders part only.
    const ann = await login("ann");
    const annBrowser = await browser();
    await subscribe(ann.cookie, "https://fcm.googleapis.com/fcm/send/ann", annBrowser);
    await send("PUT", "/api/notifications/prefs", { meetingAlerts: false }, ann.cookie);

    expect((await runProactive(testEnv(), Date.parse("2026-12-06T16:59:00Z"))).briefings).toBe(0);
    const at22 = Date.parse("2026-12-06T17:00:00Z"); // 22:00 in Karachi
    expect((await runProactive(testEnv(), at22)).briefings).toBe(2);
    // Tomorrow, 00:00 to 24:00 in Karachi.
    expect(calendarReads.map((u) => [u.searchParams.get("timeMin"), u.searchParams.get("timeMax")])).toEqual([["2026-12-06T19:00:00.000Z", "2026-12-07T19:00:00.000Z"]]);
    const mine = pushed.find((p) => p.url.endsWith("/chrome"))!;
    expect(mine.headers.get("ttl")).toBe("7200");
    expect(mine.headers.get("urgency")).toBe("normal");
    expect(await decrypt(mine.body, chrome)).toEqual({
      title: "Your briefing for tomorrow",
      body: "2 events, first at 10:00 (Team standup) · 1 reminder · 2 open to-dos. Tap to hear it.",
      url: "/?agent=briefing&day=2026-12-07",
      tag: "briefing",
      kind: "briefing",
    });
    expect((await decrypt(pushed.find((p) => p.url.endsWith("/ann"))!.body, annBrowser)).body).toBe("Tap to hear it.");

    // Once a day: not again that evening; the next evening's is about Tuesday (nothing in the calendar).
    expect((await runProactive(testEnv(), at22 + 5 * 60_000)).briefings).toBe(0);
    expect((await runProactive(testEnv(), at22 + 31 * 60_000)).briefings).toBe(0);
    await send("PUT", "/api/notifications/prefs", { briefingEnabled: false }, ann.cookie);
    pushed = [];
    // (The 09:00 reminder, overdue by then, goes out in the same run.)
    expect(await runProactive(testEnv(), at22 + 86_400_000)).toMatchObject({ briefings: 1, reminders: 1 });
    const received = await Promise.all(pushed.map((p) => decrypt(p.body, chrome)));
    expect(received.find((n) => n.kind === "briefing").body).toBe("No events · 2 open to-dos. Tap to hear it.");
  });

  it("alerts once, 10 minutes before each meeting, with plain text from the calendar", async () => {
    const owner = await login("octocat");
    const chrome = await browser();
    await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/chrome", chrome);
    await send("PUT", "/api/notifications/prefs", { briefingEnabled: false }, owner.cookie);
    await connectGoogle(owner.id);
    const at = (hhmm: string) => Date.parse(`2026-12-07T${hhmm}:00Z`); // standup at 05:00 UTC (10:00 in Karachi)

    // 04:47: the alert is due at 04:50, before the next regular look, so the calendar is read again right then.
    await runProactive(testEnv(), at("04:47"));
    await runProactive(testEnv(), at("04:48"));
    expect(calendarReads).toHaveLength(1);
    expect(pushed).toHaveLength(0);
    expect((await runProactive(testEnv(), at("04:50"))).meetings).toBe(1);
    expect(await decrypt(pushed[0]!.body, chrome)).toEqual({
      title: "In 10 minutes: Team standup",
      body: "10:00–10:30 · Google Meet",
      url: "/",
      tag: expect.stringMatching(/^meeting-ev1@/),
      kind: "meeting",
    });
    // Looking again later doesn't repeat it.
    await runProactive(testEnv(), at("04:51"));
    expect((await runProactive(testEnv(), at("04:56"))).meetings).toBe(0);
    expect(calendarReads).toHaveLength(3);
    expect(pushed).toHaveLength(1);
  });

  it("tries a reminder or briefing again when no device took it (at most 2 more times for a reminder)", async () => {
    const owner = await login("octocat");
    const chrome = await browser();
    await subscribe(owner.cookie, "https://fcm.googleapis.com/fcm/send/chrome", chrome);
    await send("PUT", "/api/notifications/prefs", { briefingEnabled: false, meetingAlerts: false }, owner.cookie);
    const set = await run("set_reminder", { text: "Call Ali", when: "in 20 minutes" }, ctxFor(owner.id));
    pushStatus = () => 503;
    const due = T0 + 20 * 60_000;
    for (let i = 0; i < 4; i++) await runProactive(testEnv(), due + i * 60_000);
    expect(pushed).toHaveLength(3); // the first send and 2 more tries, then it gives up
    expect(await env.DB.prepare("SELECT status, attempts FROM reminders WHERE id = ?1").bind(set.id).first()).toEqual({ status: "sent", attempts: 2 });
    // Too late to try again (more than 15 minutes after its time).
    const late = await run("set_reminder", { text: "Late", when: "in 30 minutes" }, ctxFor(owner.id));
    pushed = [];
    await runProactive(testEnv(), T0 + 46 * 60_000);
    expect(pushed).toHaveLength(1);
    expect(await env.DB.prepare("SELECT status FROM reminders WHERE id = ?1").bind(late.id).first()).toEqual({ status: "sent" });

    // The briefing: the day is given back, and the next minute's run delivers it. (The 4 failures so far would drop
    // the device at the 5th, so they are cleared here.)
    await env.DB.prepare("UPDATE push_subscriptions SET failures = 0").run();
    await send("PUT", "/api/notifications/prefs", { briefingEnabled: true }, owner.cookie);
    pushed = [];
    const at22 = Date.parse("2026-12-06T17:00:00Z");
    expect((await runProactive(testEnv(), at22)).briefings).toBe(1);
    pushStatus = () => 201;
    expect((await runProactive(testEnv(), at22 + 60_000)).briefings).toBe(1);
    expect((await runProactive(testEnv(), at22 + 120_000)).briefings).toBe(0);
    expect(pushed).toHaveLength(2);
  });

  it("works out briefing times in real time across daylight saving, and checks each zone's clock once", () => {
    // New York jumps from 02:00 to 03:00 on 8 Mar 2026: a 02:15 briefing moves to 03:15 (07:15 UTC) instead of being skipped.
    const ny = "America/New_York";
    expect(briefingDue(Date.parse("2026-03-08T07:25:00Z"), ny, 2 * 60 + 15)).toEqual({ about: "2026-03-08", day: "today", late: 10 * 60_000 });
    expect(briefingDue(Date.parse("2026-03-08T07:46:00Z"), ny, 2 * 60 + 15)).toBeNull();
    // On 1 Nov 2026 01:30 happens twice: only the first one counts.
    expect(briefingDue(Date.parse("2026-11-01T05:35:00Z"), ny, 90)).toMatchObject({ late: 5 * 60_000 });
    expect(briefingDue(Date.parse("2026-11-01T06:35:00Z"), ny, 90)).toBeNull();
    expect(briefingDue(Date.parse("2026-12-06T17:00:00Z"), TZ, 22 * 60)).toEqual({ about: "2026-12-07", day: "tomorrow", late: 0 });

    // Making a date formatter is costly: once a zone is known, checking it again doesn't make another one.
    validTimeZone(TZ);
    validTimeZone("Mars/Base");
    wallClock(T0, TZ);
    const made = vi.spyOn(Intl, "DateTimeFormat");
    for (let i = 0; i < 200; i++) {
      expect(validTimeZone(TZ)).toBe(TZ);
      expect(validTimeZone("Mars/Base")).toBeNull();
      briefingDue(T0 + i * 60_000, TZ, 22 * 60);
      zonedInstant("2026-12-07", "09:00", TZ);
    }
    expect(made).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- the spoken briefing in VESPER Agent

describe("the briefing in VESPER Agent", () => {
  it("adds the briefing rules for today or tomorrow, only with agent", async () => {
    const owner = await login("octocat");
    const refused = await send("POST", "/api/chat", { message: "Brief me for tomorrow.", briefing: true, timeZone: TZ }, owner.cookie);
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toMatch(/only available in VESPER Agent/);

    let system = "";
    model = (body) => {
      system = body.messages[0].content;
      return answer("Here's your briefing.");
    };
    await send("POST", "/api/chat", { message: "Brief me for tomorrow.", briefing: true, agent: true, timeZone: TZ }, owner.cookie);
    const local = wallClock(Date.now(), TZ);
    const computed = local.time >= "15:00" ? { day: "tomorrow", date: addDays(local.date, 1) } : { day: "today", date: local.date };
    expect(system).toContain(`Give a spoken briefing about ${computed.day}, ${dayLabel(computed.date)}, in 4–6`);
    expect(system).toMatch(/call list_reminders with day "\d{4}-\d{2}-\d{2}"/);
    expect(system).toContain("Anything you want me to prepare?");
    // The reminder rule is there whenever set_reminder is offered; the briefing rules only when asked for.
    expect(system).toContain("call set_reminder and confirm the exact local time");
    await send("POST", "/api/chat", { message: "Hello", agent: true, timeZone: TZ }, owner.cookie);
    expect(system).not.toContain("spoken briefing");

    // The day from the notification's link wins when it is yesterday, today or tomorrow; another day is ignored.
    const brief = (briefingDay: string) => send("POST", "/api/chat", { message: "Brief me.", briefing: true, briefingDay, agent: true, timeZone: TZ }, owner.cookie);
    await brief(local.date);
    expect(system).toContain(`Give a spoken briefing about today, ${dayLabel(local.date)},`);
    await brief(addDays(local.date, -1));
    expect(system).toContain(`Give a spoken briefing about yesterday, ${dayLabel(addDays(local.date, -1))},`);
    await brief(addDays(local.date, 5));
    expect(system).toContain(`Give a spoken briefing about ${computed.day}, ${dayLabel(computed.date)},`);
    expect((await send("POST", "/api/chat", { message: "Hi", briefingDay: local.date, agent: true }, owner.cookie)).status).toBe(400);
  });
});
