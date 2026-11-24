/**
 * v0.16.0: documents in chat. The assistant's document tools (search_documents, read_document) on a real local D1,
 * the "Documents in this chat" prompt, the prefetch rules, and chat turns that attach documents. Documents are stored
 * with plain SQL here, as the upload API would leave them (the full-text index is filled by the table's triggers).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkUnits, type TextUnit } from "../src/shared/chunking";
import { documentKind } from "../src/shared/documents";
import { SseParser } from "../src/shared/sse";
import { DEFAULT_SETTINGS, type ChatStreamEvent, type MessageDto } from "../src/shared/types";
import { app } from "../src/worker/app";
import { createConversation } from "../src/worker/db/conversations";
import type { ChatDocumentMeta } from "../src/worker/db/document-search";
import { createUser } from "../src/worker/db/users";
import { clearModelMemoryCache } from "../src/worker/llm/catalog";
import { buildContext, buildSystemPrompt } from "../src/worker/llm/context";
import { namedDocument, planPrefetch } from "../src/worker/llm/prefetch";
import { readDocument, searchDocuments, withoutOverlap } from "../src/worker/tools/documents";
import { conversationDocuments } from "../src/worker/db/document-search";
import { ToolInputError, type AgentTool, type ToolContext } from "../src/worker/tools/types";

afterEach(() => {
  vi.restoreAllMocks();
  clearModelMemoryCache();
});

let clock = 1_800_000_000_000;

/** Store a document the way the upload API leaves it: passages from chunkUnits, ready (or not), sent to a chat (or not). */
async function seedDocument(
  userId: string,
  conversationId: string | null,
  name: string,
  units: TextUnit[],
  options: { status?: "ready" | "uploading"; pages?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const chunks = chunkUnits(units);
  const kind = documentKind(name)!;
  const pages = kind === "pdf" ? (options.pages ?? units.length) : null;
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  clock += 1_000; // documents are numbered by when they were added
  await env.DB.prepare(
    `INSERT INTO chat_documents (id, user_id, conversation_id, name, kind, bytes, pages, status, expected_chunks, chunk_count, char_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1000, ?6, ?7, ?8, ?8, ?9, ?10, ?10)`,
  )
    .bind(id, userId, conversationId, name, kind, pages, options.status ?? "ready", chunks.length, chars, clock)
    .run();
  await env.DB.batch(
    chunks.map((c) =>
      env.DB.prepare("INSERT INTO chat_document_chunks (document_id, seq, location, text) VALUES (?1, ?2, ?3, ?4)").bind(id, c.seq, c.location, c.text),
    ),
  );
  return id;
}

let githubId = 9_000;
const newUser = (login: string) => createUser(env.DB, { githubId: githubId++, githubLogin: login, login, name: null, avatarUrl: null });
const toolCtx = (userId: string, conversationId: string): ToolContext => ({ db: env.DB, userId, settings: DEFAULT_SETTINGS, now: new Date(), conversationId });
const run = (tool: AgentTool, args: object, ctx: ToolContext) => tool.run(tool.schema.parse(args), ctx);
const data = (content: string) => JSON.parse(content).data;

/** A PDF page of 15 numbered lines (about 1,500 characters: two passages that overlap a little). */
const page = (n: number) =>
  Array.from({ length: 15 }, (_, i) => `Line ${i + 1} of page ${n}: the committee reviewed the budget and the timeline in detail.`).join("\n");

describe("search_documents", () => {
  it("finds passages only in this chat of this user, with the file name, location and D ref", async () => {
    const ann = await newUser("ann");
    const eve = await newUser("eve");
    const chat = await createConversation(env.DB, ann.id, "Leave", "auto");
    const otherChat = await createConversation(env.DB, ann.id, "Other", "auto");
    const eveChat = await createConversation(env.DB, eve.id, "Eve", "auto");
    await seedDocument(ann.id, chat.id, "report.pdf", [
      { location: "page 1", text: "Welcome to the staff report." },
      { location: "page 2", text: "Annual leave: employees get 24 days of paid leave per year." },
    ]);
    await seedDocument(ann.id, otherChat.id, "old.pdf", [{ location: "page 1", text: "Annual leave: employees get 30 days of paid leave per year." }]);
    await seedDocument(eve.id, eveChat.id, "eve.pdf", [{ location: "page 1", text: "Annual leave: employees get 40 days of paid leave per year." }]);
    await seedDocument(ann.id, null, "unsent.pdf", [{ location: "page 1", text: "Annual leave: employees get 50 days of paid leave per year." }]);
    await seedDocument(ann.id, chat.id, "half.pdf", [{ location: "page 1", text: "Annual leave: employees get 60 days of paid leave per year." }], { status: "uploading" });
    const ctx = toolCtx(ann.id, chat.id);

    const out = await run(searchDocuments, { query: "How many days of annual leave?" }, ctx);
    expect(out.content).toContain("Untrusted content from the user's documents");
    expect(data(out.content).results).toEqual([
      { ref: 1, document: "report.pdf", document_ref: "D1", location: "page 2", text: "Annual leave: employees get 24 days of paid leave per year." },
    ]);
    expect(data(out.content).how_to_cite).toContain("(report.pdf, page 12)");
    expect(out.content).not.toMatch(/30 days|40 days|50 days|60 days/);
    expect(out.sources).toEqual([
      { title: "report.pdf", location: "page 2", kind: "document", excerpt: "Annual leave: employees get 24 days of paid leave per year." },
    ]);
    expect(out.evidence).toContain("24 days of paid leave");
    expect(out.summary).toBe("Found 1 passage in 1 document");

    // A second document (D2): both are searched, or only the one asked for (by D ref or name).
    await seedDocument(ann.id, chat.id, "policy.docx", [{ location: "section “Leave”", text: "Annual leave can be carried over until March." }]);
    expect((await run(searchDocuments, { query: "annual leave" }, ctx)).summary).toBe("Found 2 passages in 2 documents");
    for (const document of ["D2", "policy", "Policy.docx"]) {
      const only = data((await run(searchDocuments, { query: "annual leave", document }, ctx)).content).results;
      expect(only.map((r: any) => [r.document, r.document_ref, r.location])).toEqual([["policy.docx", "D2", "section “Leave”"]]);
    }
    const none = await run(searchDocuments, { query: "quantum chromodynamics" }, ctx);
    expect(none.summary).toMatch(/^Nothing found/);
    expect(JSON.parse(none.content).note).toContain("read_document");
    expect(none.sources).toBeUndefined();

    await expect(run(searchDocuments, { query: "leave", document: "D9" }, ctx)).rejects.toThrow(
      'No document "D9" in this chat. Use one of: D1 (report.pdf), D2 (policy.docx).',
    );
    // Someone else can't search ann's chat, and a chat without documents has nothing to search.
    await expect(run(searchDocuments, { query: "leave" }, toolCtx(eve.id, chat.id))).rejects.toBeInstanceOf(ToolInputError);
    const empty = await createConversation(env.DB, ann.id, "Empty", "auto");
    await expect(run(searchDocuments, { query: "leave" }, toolCtx(ann.id, empty.id))).rejects.toThrow(/No document is attached to this chat/);
  });
});

describe("read_document", () => {
  it("gives a short document whole, and a long one in parts from the start, a page or a part", async () => {
    const ann = await newUser("ann");
    const chat = await createConversation(env.DB, ann.id, "Report", "auto");
    await seedDocument(ann.id, chat.id, "budget.pdf", Array.from({ length: 12 }, (_, i) => ({ location: `page ${i + 1}`, text: page(i + 1) })));
    await seedDocument(ann.id, chat.id, "notes.txt", [{ location: "", text: "Short note: the meeting is on Friday at 10." }]);
    const ctx = toolCtx(ann.id, chat.id);

    // No document named: the newest (D2), whole.
    const short = await run(readDocument, {}, ctx);
    expect(short.content).toContain("Untrusted content from the user's documents");
    expect(data(short.content)).toEqual({
      document: "notes.txt",
      document_ref: "D2",
      total_parts: 1,
      parts: "1",
      text: "Short note: the meeting is on Friday at 10.",
      note: "This is the whole document.",
      how_to_cite: expect.stringContaining("(file name, location)"),
    });
    expect(short.sources).toEqual([{ title: "notes.txt", kind: "document", excerpt: "Short note: the meeting is on Friday at 10." }]);

    // A long document: the first parts, in order, without the lines neighbouring passages repeat.
    const start = await run(readDocument, { document: "D1" }, ctx);
    const first = data(start.content);
    expect(first).toMatchObject({ document: "budget.pdf", document_ref: "D1", total_pages: 12 });
    expect(first.text).toMatch(/^\[page 1\]\nLine 1 of page 1:/);
    expect(first.text).toContain("\n\n[page 2]\nLine 1 of page 2:");
    expect(first.text.match(/Line 10 of page 1:/g)).toHaveLength(1);
    expect(JSON.stringify(first.text).length).toBeLessThanOrEqual(6_502);
    expect(first.next_part).toBeGreaterThan(2);
    expect(first.parts).toBe(`1–${first.next_part - 1}`);
    expect(first.total_parts).toBeGreaterThan(first.next_part);
    expect(first.note).toMatch(/^This is the start of a longer document\./);
    expect(start.sources!.map((s) => s.location)).toEqual(expect.arrayContaining(["page 1", "page 2"]));
    expect(first.pages).toMatch(/^1–\d+$/);
    expect(start.sources!.every((s) => s.kind === "document" && s.title === "budget.pdf" && s.excerpt!.length <= 600)).toBe(true);

    // Reading on with next_part continues where the first read stopped.
    const next = data((await run(readDocument, { document: "budget.pdf", part: first.next_part }, ctx)).content);
    expect(next.parts.split("–")[0]).toBe(String(first.next_part));
    expect(next.note).toMatch(/^More of the document follows/);

    // A page: from its first passage.
    const three = data((await run(readDocument, { document: "D1", page: 3 }, ctx)).content);
    expect(three.text).toMatch(/^\[page 3\]\nLine 1 of page 3:/);
    expect(three.pages).toMatch(/^3/);

    // The last part ends the document.
    const end = data((await run(readDocument, { document: "D1", part: first.total_parts }, ctx)).content);
    expect(end).toMatchObject({ parts: String(first.total_parts), note: "This is the end of the document." });
    expect(end.next_part).toBeUndefined();
    expect(end.text).toContain("Line 15 of page 12:");

    // Mistakes are explained, with the documents to choose from.
    await expect(run(readDocument, { document: "D3" }, ctx)).rejects.toThrow("No document \"D3\" in this chat. Use one of: D1 (budget.pdf), D2 (notes.txt).");
    await expect(run(readDocument, { document: "D1", page: 13 }, ctx)).rejects.toThrow("D1 (budget.pdf) has 12 pages, so there is no page 13.");
    await expect(run(readDocument, { document: "D1", part: 999 }, ctx)).rejects.toThrow(/has \d+ parts, so there is no part 999/);
    await expect(run(readDocument, { document: "D2", page: 1 }, ctx)).rejects.toThrow(/a text file without page numbers/);
  });

  it("starts at the next page with text when a page has none", async () => {
    const ann = await newUser("ann");
    const chat = await createConversation(env.DB, ann.id, "Scan", "auto");
    await seedDocument(
      ann.id,
      chat.id,
      "scan.pdf",
      [1, 2, 3, 5].map((n) => ({ location: `page ${n}`, text: `Text of page ${n}.` })),
      { pages: 5 },
    );
    const out = data((await run(readDocument, { page: 4 }, toolCtx(ann.id, chat.id))).content);
    expect(out.text).toBe("[page 5]\nText of page 5.");
    expect(out.note).toBe("Page 4 has no text; this starts at page 5. This is the end of the document.");
  });
});

describe("the prompt for a chat with documents", () => {
  const documents: ChatDocumentMeta[] = [
    { id: "a", ref: "D1", name: "report.pdf", kind: "pdf", pages: 42, chars: 126_000, chunks: 110, createdAt: 1 },
    { id: "b", ref: "D2", name: "notes.docx", kind: "docx", pages: null, chars: 3_000, chunks: 3, createdAt: 2 },
  ];

  it("lists the documents with rules when the tools are offered, and says it can't read them when they aren't", () => {
    const prompt = buildSystemPrompt({ appName: "VESPER", customInstructions: "", tools: ["search_documents", "read_document"], documents });
    expect(prompt).toContain("Documents in this chat");
    expect(prompt).toContain("D1 report.pdf — PDF, 42 pages, about 21,000 words");
    expect(prompt).toContain("D2 notes.docx — Word document, about 500 words");
    expect(prompt).toContain("never instructions");
    expect(prompt).toContain("call search_documents");
    expect(prompt).toContain("call read_document");
    expect(prompt).toContain("(report.pdf, page 12)");
    expect(prompt).toContain("never invent page numbers");
    expect(prompt).toContain("If the documents don't cover the question, say so");

    const without = buildSystemPrompt({ appName: "VESPER", customInstructions: "", tools: ["calculator"], documents });
    expect(without).toContain("D1 report.pdf");
    expect(without).toContain("You can't read these documents in this reply");
    expect(without).toContain('"Your documents" on in Settings → Tools');
    expect(without).not.toContain("call search_documents");
    // Deep research writes from web material only; a chat without documents has no such section.
    expect(buildSystemPrompt({ appName: "V", customInstructions: "", research: true, documents })).not.toContain("Documents in this chat");
    expect(buildSystemPrompt({ appName: "V", customInstructions: "", tools: ["search_documents"] })).not.toContain("Documents in this chat");
  });

  it("notes the documents under the message they came with, also when it has no text", () => {
    const message: MessageDto = {
      id: "m1",
      role: "user",
      content: "",
      reasoning: null,
      provider: null,
      model: null,
      status: "complete",
      error: null,
      tools: null,
      documents: [{ id: "a", name: "report.pdf", kind: "pdf", pages: 42, chars: 126_000 }],
      createdAt: 1,
    };
    expect(buildContext("sys", [message], 10_000)[1]).toEqual({
      role: "user",
      content: '[The user attached "report.pdf" with this message (see "Documents in this chat" in your instructions).]',
    });
  });
});

describe("prefetch in a chat with documents", () => {
  const offered = new Set(["search_documents", "read_document", "web_search", "search_knowledge", "calculator"]);
  // The chat has documents when the document tools are offered (as the chat route decides).
  const plan = (q: string, attached = false, tools: ReadonlySet<string> = offered, list?: { ref: string; name: string }[]) => {
    const documents = tools.has("search_documents") || tools.has("read_document") ? { attached, ...(list ? { list } : {}) } : undefined;
    const c = planPrefetch(q, tools, documents);
    return c ? { name: c.name, args: JSON.parse(c.arguments) } : null;
  };
  const read = { name: "read_document", args: {} };

  it("reads the newest document for summaries and messages without text, searches for questions about the documents", () => {
    expect(plan("Summarise this", true)).toEqual(read);
    expect(plan("Can you give me the key points?", true)).toEqual(read);
    expect(plan("tl;dr please", true)).toEqual(read);
    expect(plan("Give me an overview of the document")).toEqual(read);
    expect(plan("What is this PDF about?")).toEqual(read);
    expect(plan("", true)).toEqual(read);
    expect(plan("What does the report say about annual leave?")).toEqual({
      name: "search_documents",
      args: { query: "What does the report say about annual leave?" },
    });
    // "page 5" is read, rather than searched for the words "page" and "5".
    expect(plan("What's on page 5?")).toEqual({ name: "read_document", args: { page: 5 } });
    // Sent together with the documents: about them, whatever it says.
    expect(plan("Hi there!", true)).toEqual({ name: "search_documents", args: { query: "Hi there!" } });
  });

  it("reads or searches the document a message names; with several and none named, it never reads the wrong one", () => {
    const two = [
      { ref: "D1", name: "report.pdf" },
      { ref: "D2", name: "contract.pdf" },
    ];
    expect(plan("Summarise report.pdf", false, offered, two)).toEqual({ name: "read_document", args: { document: "D1" } });
    expect(plan("What's on page 3 of D1?", false, offered, two)).toEqual({ name: "read_document", args: { document: "D1", page: 3 } });
    expect(plan("What does the contract say about notice periods?", false, offered, two)).toEqual({
      name: "search_documents",
      args: { query: "What does the contract say about notice periods?", document: "D2" },
    });
    // Several documents, none named: no read (it could be the wrong one); a question searches all of them.
    expect(plan("Summarise the document", false, offered, two)).toBeNull();
    expect(plan("What's on page 3?", false, offered, two)?.name).toBe("search_documents");
    expect(plan("What do the documents say about pay?", false, offered, two)).toEqual({
      name: "search_documents",
      args: { query: "What do the documents say about pay?" },
    });
    // Right after attaching, "summarise this" is about the new (newest) document.
    expect(plan("Summarise this", true, offered, two)).toEqual(read);
    expect(namedDocument("compare report.pdf and the contract", two)).toBeNull(); // two named: neither
    expect(namedDocument("what does d2 say", two)).toBe("D2");
  });

  it("leaves other messages to the model (no web search first), and changes nothing in chats without documents", () => {
    expect(plan("Hello, how are you today?")).toBeNull();
    // Summary words about something else, or a later "summarise this" (maybe the last answer): the model decides.
    expect(plan("Give me an overview of photosynthesis")).toBeNull();
    expect(plan("Summarise this")).toBeNull();
    expect(plan("What is the latest stable version of Python?")).toBeNull();
    expect(plan(`Summarise this: ${"pasted text ".repeat(60)}`)).toBeNull(); // pasted text: the model decides
    // The user switched read_document off: a summary is left to the model.
    expect(plan("Summarise the report", false, new Set(["search_documents"]))).toBeNull();
    const noDocuments = new Set(["web_search", "search_knowledge", "calculator"]);
    expect(plan("What does my PDF say about Kubernetes costs?", false, noDocuments)?.name).toBe("search_knowledge");
    expect(plan("What is the latest stable version of Python?", false, noDocuments)?.name).toBe("web_search");
    expect(plan("Explain how recursion works", false, noDocuments)).toBeNull();
  });
});

// ------------------------------------------------------------------ chat turns

const ORIGIN = "http://localhost";
// AI off: the re-ranker isn't called (the keyword order is kept).
const MODEL = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://groq.test/v1", AI: undefined };

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), { ...env, ...MODEL }, ctx);
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
async function login(name: string) {
  const { response } = await call("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: name }) });
  const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  const me = await call("/api/auth/me", { cookie });
  return { cookie, id: me.json.user.id as string };
}
const post = (path: string, body: unknown, cookie: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const answer = (t: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const events = (body: string) => {
  const p = new SseParser();
  return [...p.feed(body), ...p.flush()].map((e) => JSON.parse(e.data) as ChatStreamEvent);
};
/** The model's requests, answered with `reply`. */
function fakeModel(reply: string) {
  const requests: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://groq.test/v1/chat/completions") return new Response("unexpected " + url, { status: 500 });
    requests.push(JSON.parse(String(init?.body)));
    return answer(reply);
  });
  return requests;
}

describe("chat turns with documents", () => {
  it("sends documents with a message: the chip is stored, the documents join the chat and both tools are offered", async () => {
    const ann = await login("ann");
    const units = [
      { location: "page 1", text: "Welcome to the staff report." },
      { location: "page 2", text: "Annual leave: employees get 24 days of paid leave per year." },
    ];
    const id = await seedDocument(ann.id, null, "report.pdf", units);
    const requests = fakeModel("Employees get 24 days (report.pdf, page 2).");
    const chat = await post("/api/chat", { message: "How many days of leave does the report give?", documents: [id] }, ann.cookie);
    expect(chat.response.status).toBe(200);
    const stream = events(chat.text);
    const chip = { id, name: "report.pdf", kind: "pdf", pages: 2, chars: chunkUnits(units).reduce((n, c) => n + c.text.length, 0) };
    const user = stream.find((e) => e.type === "user_message") as Extract<ChatStreamEvent, { type: "user_message" }>;
    expect(user.message.documents).toEqual([chip]);
    const conversationId = (stream.find((e) => e.type === "conversation") as any).conversation.id;
    expect(await env.DB.prepare("SELECT conversation_id FROM chat_documents WHERE id = ?1").bind(id).first("conversation_id")).toBe(conversationId);

    expect(requests).toHaveLength(1);
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["search_documents", "read_document"]));
    const system = requests[0].messages[0].content as string;
    expect(system).toContain("Documents in this chat");
    expect(system).toContain("D1 report.pdf — PDF, 2 pages");
    // About "the report": the passages were searched before the first request, so the model answers in one call.
    const question = requests[0].messages.at(-1).content as string;
    expect(question).toContain('[The user attached "report.pdf" with this message');
    expect(question).toContain('The app already ran "Your documents"');
    expect(question).toContain("24 days of paid leave");
    const done = stream.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.message.tools![0]).toMatchObject({ name: "search_documents", status: "done" });
    // The best passage's chip carries its text, to show when it's opened.
    expect(done.message.tools![0]!.sources![0]).toEqual({
      title: "report.pdf",
      location: "page 2",
      kind: "document",
      excerpt: "Annual leave: employees get 24 days of paid leave per year.",
    });
    expect(done.message.checkable).toBe(true);
    const saved = await call(`/api/conversations/${conversationId}`, { cookie: ann.cookie });
    expect(saved.json.messages[0].documents).toEqual([chip]);

    // The same document can't be sent again; one that isn't finished can't be sent; nor can someone else's.
    const again = await post("/api/chat", { message: "Again", documents: [id] }, ann.cookie);
    expect([again.response.status, again.json.error.code]).toEqual([409, "document_not_ready"]);
    const half = await seedDocument(ann.id, null, "half.pdf", units, { status: "uploading" });
    expect((await post("/api/chat", { message: "x", documents: [half] }, ann.cookie)).json.error.code).toBe("document_not_ready");
    const eve = await login("eve");
    const annsUnsent = await seedDocument(ann.id, null, "private.pdf", units);
    const stolen = await post("/api/chat", { message: "x", documents: [annsUnsent] }, eve.cookie);
    expect([stolen.response.status, stolen.json.error.code]).toEqual([409, "document_not_ready"]);
  });

  it("names a new chat after the document when there's no text, and reads it first", async () => {
    const ann = await login("ann");
    const id = await seedDocument(ann.id, null, "notes.docx", [{ location: "section “Intro”", text: "The project starts in March." }]);
    const requests = fakeModel("It's about the project start (notes.docx, section “Intro”).");
    const chat = await post("/api/chat", { documents: [id] }, ann.cookie);
    expect(chat.response.status).toBe(200);
    const stream = events(chat.text);
    expect((stream.find((e) => e.type === "conversation") as any).conversation.title).toBe("notes.docx");
    const question = requests[0].messages.at(-1).content as string;
    expect(question).toMatch(/^\[The user attached "notes\.docx" with this message/);
    expect(question).toContain('The app already ran "Read a document"');
    expect(question).toContain("The project starts in March.");
  });

  it("refuses documents beyond the limits, with research, with local models and when switched off", async () => {
    const ann = await login("ann");
    const admin = await login("octocat");
    const text = [{ location: "", text: "Some text." }];
    const full = await createConversation(env.DB, ann.id, "Full", "auto");
    for (let i = 0; i < 5; i++) await seedDocument(ann.id, full.id, `d${i}.txt`, text);
    const id = await seedDocument(ann.id, null, "six.txt", text);

    const sixth = await post("/api/chat", { conversationId: full.id, message: "And this one?", documents: [id] }, ann.cookie);
    expect([sixth.response.status, sixth.json.error.code]).toEqual([409, "chat_documents_full"]);
    expect(sixth.json.error.message).toBe("A chat can have up to 5 documents. Start a new chat to add more.");
    const four = [id, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    expect((await post("/api/chat", { message: "x", documents: four }, ann.cookie)).json.error.message).toMatch(/Attach up to 3 documents per message/);
    const research = await post("/api/chat", { message: "x", documents: [id], research: true }, ann.cookie);
    expect(research.response.status).toBe(400);
    expect(research.json.error.message).toMatch(/Deep research works with text questions only\. Remove the documents\./);
    expect((await post("/api/chat", { conversationId: full.id, regenerate: true, documents: [id] }, ann.cookie)).response.status).toBe(400);
    const local = await post("/api/chat/local/prepare", { message: "x", model: "ollama:llama3", documents: [id] }, ann.cookie);
    expect(local.json.error.message).toBe("Documents work with the cloud models only. Choose Auto or another cloud model.");

    // Settings → Tools lists the document tools while documents are on.
    const listed = async () => (await call("/api/tools", { cookie: ann.cookie })).json.tools.map((t: any) => t.name);
    expect(await listed()).toEqual(expect.arrayContaining(["search_documents", "read_document"]));
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ documentsEnabled: false }), cookie: admin.cookie });
    const off = await post("/api/chat", { message: "x", documents: [id] }, ann.cookie);
    expect([off.response.status, off.json.error.code]).toEqual([403, "documents_off"]);
    expect(await listed()).not.toContain("search_documents");
    expect(await listed()).not.toContain("read_document");
    // Nothing was sent or counted: the document is still unsent.
    expect(await env.DB.prepare("SELECT conversation_id FROM chat_documents WHERE id = ?1").bind(id).first("conversation_id")).toBeNull();
  });

  it("offers no document tools in a chat with documents once they are switched off, but still lists them in the prompt", async () => {
    const ann = await login("ann");
    const admin = await login("octocat");
    const conversation = await createConversation(env.DB, ann.id, "Report", "auto");
    await seedDocument(ann.id, conversation.id, "report.pdf", [{ location: "page 1", text: "Annual leave is 24 days." }]);
    await call("/api/admin/settings", { method: "PUT", body: JSON.stringify({ documentsEnabled: false }), cookie: admin.cookie });
    const requests = fakeModel("I can't read the documents right now.");
    const chat = await post("/api/chat", { conversationId: conversation.id, message: "What does the report say about leave?" }, ann.cookie);
    expect(chat.response.status).toBe(200);
    expect((requests[0].tools ?? []).map((t: any) => t.function.name)).not.toContain("search_documents");
    expect(requests[0].messages[0].content).toContain("You can't read these documents in this reply");
    expect(requests[0].messages.at(-1).content).not.toContain("The app already ran");
  });
});

describe("reading in order (review fixes)", () => {
  it("leaves out the lines a passage repeats from the one before, also for passages of very short lines", () => {
    const lines = (...xs: string[]) => xs.join("\n");
    expect(withoutOverlap(lines("one", "two", "three"), lines("two", "three", "four"))).toBe("four");
    expect(withoutOverlap(lines("one", "two"), lines("three", "four"))).toBe(lines("three", "four"));
    expect(withoutOverlap("same", lines("same", "next"))).toBe("next");
    // A table read from a PDF: one short line per cell. The repeat is found among the first lines only.
    const cells = (from: number, n: number) => lines(...Array.from({ length: n }, (_, i) => `c${from + i}`));
    const previous = cells(0, 2_000);
    const next = lines(cells(1_960, 40), cells(2_000, 1_900));
    expect(withoutOverlap(previous, next)).toBe(cells(2_000, 1_900));
    // Never leaves nothing: a passage's last line always stays.
    expect(withoutOverlap("a", "a")).toBe("a");
    expect(withoutOverlap(lines("x", "a"), lines("a", "b"))).toBe("b");
  });

  it("numbers documents by when they joined the chat, so earlier answers' D1/D2 keep pointing at the same file", async () => {
    const ann = await newUser("ann");
    const chat = await createConversation(env.DB, ann.id, "Two", "auto");
    const uploadedFirst = await seedDocument(ann.id, null, "early.pdf", [{ location: "page 1", text: "Uploaded first, sent later." }]);
    const sentFirst = await seedDocument(ann.id, chat.id, "sent.pdf", [{ location: "page 1", text: "Sent first." }]);
    // The earlier upload is sent into the chat now (linking sets updated_at).
    await env.DB.prepare("UPDATE chat_documents SET conversation_id = ?1, updated_at = ?2 WHERE id = ?3").bind(chat.id, clock + 10_000, uploadedFirst).run();
    const docs = await conversationDocuments(env.DB, ann.id, chat.id);
    expect(docs.map((d) => [d.ref, d.id])).toEqual([
      ["D1", sentFirst],
      ["D2", uploadedFirst],
    ]);
  });
});
