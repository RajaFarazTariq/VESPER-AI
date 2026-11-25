#!/usr/bin/env node
/**
 * Offline mock of OpenAI-compatible LLM APIs, for developing and testing without API keys.
 *
 *   npm run mock:llm                  # listens on http://127.0.0.1:8790
 *   MOCK_FAIL=groq npm run mock:llm   # make "groq" answer 429 to exercise automatic fallback
 *
 * Point a provider at it with e.g. GROQ_BASE_URL=http://127.0.0.1:8790/groq and GROQ_API_KEY=mock.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8790);
const failing = new Set((process.env.MOCK_FAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

/** The notes the app adds under a message with attachments ("[The user attached "report.pdf" with this message …]"). */
const ATTACHED_NOTE = /\[The user attached [^\]]*\]/g;

/**
 * Documents in chat (v0.16.0): what a document tool returned, as a citation for the answer. `content` is the tool
 * result (wrapped as untrusted: { notice, data }) from search_documents or read_document; null when it isn't one.
 */
function documentCitation(content) {
  let data;
  try {
    data = JSON.parse(content)?.data;
  } catch {
    return null;
  }
  // Only the chat's documents have D refs (knowledge-base results keep the generic reply).
  const hit = Array.isArray(data?.results) ? data.results[0] : null;
  if (hit?.document_ref) return { name: hit.document, location: hit.location, text: String(hit.text ?? "") };
  if (data?.document_ref && typeof data.text === "string") {
    const location = /^\[([^\]\n]+)\]\n/.exec(data.text)?.[1];
    return { name: data.document, location, text: data.text.replace(/^\[[^\]\n]+\]\n/, "") };
  }
  return null;
}

/** A short answer that quotes the start of the passage and cites it as (file name, page N). */
function documentAnswer(cited) {
  const words = cited.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 30).join(" ");
  return `**Mock reply** from the documents: "${words}…" (${cited.name}${cited.location ? `, ${cited.location}` : ""}).`;
}

function pickTool(text, names, system = "") {
  // Documents (v0.16.0): a summary (or a message with only documents) reads the newest one; a question that mentions
  // a document, PDF, file, report or page searches them.
  const asked = text.replace(ATTACHED_NOTE, "").trim();
  if (names.includes("read_document") && (!asked || /\b(?:summari[sz]e|summary|overview|key points|main points|tl;?dr)\b/i.test(asked))) {
    return { name: "read_document", args: {} };
  }
  if (names.includes("search_documents") && /\b(?:documents?|pdfs?|files?|reports?|pages?)\b/i.test(asked) && asked.length >= 2) {
    return { name: "search_documents", args: { query: asked.slice(0, 300) } };
  }
  // Google (v0.15.0): free time, an event tomorrow at 14:30 (clashes with the fake "Client call"), an email.
  const address = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0];
  if (names.includes("calendar_free_time") && /\bfree\b/i.test(text)) return { name: "calendar_free_time", args: { minutes: 60 } };
  if (names.includes("calendar_create_event") && /\b(?:add|schedule|book)\b/i.test(text) && /\b(?:meeting|event)\b/i.test(text)) {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return { name: "calendar_create_event", args: { title: "Project review", start: `${tomorrow}T14:30`, minutes: 60, ...(address ? { attendees: [address] } : {}), meet: true } };
  }
  if (names.includes("gmail_send") && /\bemail\b/i.test(text) && address) {
    return { name: "gmail_send", args: { to: [address], subject: "Project review tomorrow", body: "Hi Sara,\n\nCan we meet tomorrow at 14:30 to review the project?\n\nThanks" } };
  }
  if (names.includes("calendar_events") && /\bcalendar\b/i.test(text)) return { name: "calendar_events", args: {} };
  // Spreadsheets (v0.14.0): "total …" sums the first number column by the first text column of the chat's first table.
  // v0.14.1: "… by month" groups by the first date column's month ("by month and <text column>": one line per value);
  // "list …" lists rows (up to 200) for the download.
  if (names.includes("query_table") && /\b(?:total|sum|average|how many|by|list)\b/i.test(text)) {
    const number = /- "([^"]+)": number/.exec(system)?.[1];
    const label = /- "([^"]+)": text/.exec(system)?.[1];
    const date = /- "([^"]+)": date/.exec(system)?.[1];
    if (/^list\b/i.test(text.trim())) return { name: "query_table", args: { limit: 200 } };
    if (number) {
      const op = /\baverage\b/i.test(text) ? "avg" : "sum";
      const groups = [];
      if (date && /\bmonth\b/i.test(text)) groups.push({ column: date, by: "month" });
      if (label && (groups.length === 0 || text.toLowerCase().includes(label.toLowerCase()))) groups.push({ column: label });
      return { name: "query_table", args: { ...(groups.length ? { group_by: groups } : {}), metrics: [{ op, column: number }, ...(/\bcount\b/i.test(text) ? ["count"] : [])] } };
    }
  }
  // Reminders (v0.18.0): "remind me in 2 minutes to stretch", "remind me at 17:00 to call Ali", "remind me tomorrow at
  // 09:00 to …" (no time given: in 2 minutes).
  const remind = /\bremind me\b(.*)$/i.exec(text);
  if (remind && names.includes("set_reminder")) {
    const rest = remind[1];
    const found =
      /\bin \d+ (?:minutes?|mins?|hours?)\b/i.exec(rest) ??
      /\btomorrow(?: at)? \d{1,2}(?::\d{2})?(?: ?[ap]m)?/i.exec(rest) ??
      /\bat \d{1,2}(?::\d{2})?(?: ?[ap]m)?/i.exec(rest);
    const when = found ? found[0].replace(/^at /i, "") : "in 2 minutes";
    const what = (found ? rest.replace(found[0], " ") : rest).replace(/^\s*(?:to|that|about)\s+/i, "").replace(/[\s.!?]+$/, "").replace(/\s+/g, " ").trim();
    return { name: "set_reminder", args: { text: what || "Reminder", when } };
  }
  const time = /time in ([A-Za-z_]+\/[A-Za-z_]+)/i.exec(text);
  if (time && names.includes("current_datetime")) return { name: "current_datetime", args: { timezone: time[1] } };
  const remember = /remember (?:that )?(.+)/i.exec(text);
  if (remember && names.includes("remember")) return { name: "remember", args: { fact: remember[1].trim() } };
  const calc = /(?:calculate|compute|what is)\s+([-+*/^%().\d\s!a-z,]+?)\??$/i.exec(text);
  if (calc && names.includes("calculator")) return { name: "calculator", args: { expression: calc[1].trim() } };
  return null;
}

/** A tool call, streamed in two fragments like real providers do. */
async function streamToolCall(res, call) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const args = JSON.stringify(call.args);
  const half = Math.ceil(args.length / 2);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: call.name, arguments: args.slice(0, half) } }] } }] })}\n\n`);
  await sleep(15);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** The spoken briefing (v0.18.0): short, plain text, ending with a question. */
const briefingText = (day) =>
  `Here's your briefing for ${day}. You have two events: the team standup at 10 and a client call at 2 PM. ` +
  "Nothing looks urgent, and there's a short gap for lunch. Anything you want me to prepare?";

async function streamText(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    await sleep(15);
  }
  res.end("data: [DONE]\n\n");
}

// ---------------------------------------------------------------- a fake Google (v0.15.0)
// Point the app at it with GOOGLE_OAUTH_BASE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_API_BASE_URL and
// GOOGLE_REVOKE_URL under http://127.0.0.1:8790/google. Consent is granted at once (both permissions); the calendar
// has two events tomorrow; inserted events and sent emails are logged here.

/** "+05:00" for a time zone right now. */
function zoneOffset(timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}
const localDate = (timeZone, plusDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() + plusDays * 86_400_000));

async function fakeGoogle(req, res, path, url) {
  const json = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "/o/oauth2/v2/auth") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "mock-code");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (path === "/token") {
    const scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/gmail.send";
    return json({ access_token: `mock-access-${Date.now()}`, expires_in: 3599, refresh_token: "mock-refresh", scope, token_type: "Bearer" });
  }
  if (path === "/userinfo") return json({ sub: "mock-google-user", email: "tester@gmail.com", email_verified: true });
  if (path === "/revoke") return json({});
  if (path === "/calendar/v3/calendars/primary/events") {
    const timeZone = url.searchParams.get("timeZone") || "UTC";
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      console.log(`[google] event added: ${body.summary} ${JSON.stringify(body.start)} guests=${(body.attendees ?? []).length} sendUpdates=${url.searchParams.get("sendUpdates")}`);
      return json({ id: "mock-event", htmlLink: "https://www.google.com/calendar/event?eid=mock", ...body });
    }
    const day = localDate(timeZone, 1);
    const offset = zoneOffset(timeZone);
    const all = [
      { summary: "Team standup", start: { dateTime: `${day}T10:00:00${offset}` }, end: { dateTime: `${day}T10:30:00${offset}` } },
      { summary: "Client call", start: { dateTime: `${day}T14:00:00${offset}` }, end: { dateTime: `${day}T15:00:00${offset}` } },
    ];
    const from = Date.parse(url.searchParams.get("timeMin"));
    const to = Date.parse(url.searchParams.get("timeMax"));
    return json({ timeZone, items: all.filter((e) => Date.parse(e.end.dateTime) > from && Date.parse(e.start.dateTime) < to) });
  }
  if (path === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
    const raw = JSON.parse((await readBody(req)) || "{}").raw ?? "";
    const head = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split("\r\n\r\n")[0];
    console.log(`[google] email sent:\n${head}`);
    return json({ id: "mock-message", threadId: "mock-thread", labelIds: ["SENT"] });
  }
  return json({ error: { message: "not found" } }, 404);
}

const server = createServer(async (req, res) => {
  const [, provider = "mock", ...rest] = (req.url ?? "/").split("?")[0].split("/");
  const path = "/" + rest.join("/");
  if (provider === "google") return fakeGoogle(req, res, path, new URL(req.url ?? "/", "http://127.0.0.1"));

  if (req.method === "GET" && path === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: `${provider}-mock-large`, context_window: 131072 }, { id: `${provider}-mock-small`, context_window: 32768 }] }));
    return;
  }

  // Speech to text (Groq-style Whisper endpoint): answers with a fixed sentence and the upload's size.
  if (req.method === "POST" && path === "/audio/transcriptions") {
    const body = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: `Mock transcription (${body.length} bytes received).`, duration: 3 }));
    return;
  }

  if (req.method === "POST" && path === "/chat/completions") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (failing.has(provider)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "20" });
      res.end(JSON.stringify({ error: { message: `Rate limit reached for ${body.model} (mock)` } }));
      return;
    }
    const lastMessage = (body.messages ?? []).at(-1);
    const lastContent = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    // Messages with images arrive as parts: [{ type: "text" }, { type: "image_url" }, …].
    const last = Array.isArray(lastContent)
      ? `${lastContent.filter((p) => p.type === "text").map((p) => p.text).join(" ")} [+${lastContent.filter((p) => p.type === "image_url").length} image(s)]`.trim()
      : lastContent;

    // Documents (v0.16.0): the app may already have searched or read them ("The app already ran …" under the question,
    // so no tool is called); either way the answer cites the first passage it got.
    const prefetched = /\[The app already ran "[^"]+" for this question[^\]]*\]\n([\s\S]*)$/.exec(String(last))?.[1];
    const fromDocuments = documentCitation(lastMessage?.role === "tool" ? lastMessage.content : (prefetched ?? ""));
    if (fromDocuments) return streamText(res, documentAnswer(fromDocuments));

    // "Brief me for tomorrow." (v0.18.0): reads the reminders first when offered (a tool step), then the canned briefing.
    const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name) : [];
    if (/\bbrief me\b/i.test(String(last))) {
      const day = /\btoday\b/i.test(String(last)) ? "today" : "tomorrow";
      if (toolNames.includes("list_reminders") && lastMessage?.role !== "tool") return streamToolCall(res, { name: "list_reminders", args: { day } });
      return streamText(res, briefingText(day));
    }

    // Tool calling: decide on a tool for recognisable requests, then answer from the tool result.
    if (toolNames.length > 0) {
      if (lastMessage?.role === "tool") {
        return streamText(res, `Done. The tool returned: ${lastMessage.content}`);
      }
      const system = String((body.messages ?? []).find((m) => m.role === "system")?.content ?? "");
      const call = pickTool(String(last), toolNames, system);
      if (call) return streamToolCall(res, call);
    }
    const reply =
      `**Mock reply** from \`${provider}\` (model \`${body.model}\`).\n\n` +
      `You said: "${String(last).slice(0, 200)}"\n\n` +
      "Here is a code sample:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n```\n\n" +
      "Math check: \\[ 2{,}340 \\times 0.175 = 409.5 \\] and inline \\(a^2 + b^2 = c^2\\), costing $409.50.\n\n" +
      "| Item | Value |\n|---|---|\n| Messages in context | " + (body.messages?.length ?? 0) + " |\n";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const piece of reply.match(/\S+\s*|\s+/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(15);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 64 } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock LLM server on http://127.0.0.1:${PORT}  (failing: ${[...failing].join(", ") || "none"})`);
});
