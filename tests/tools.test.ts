import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ModelInfo, type ProviderId, type ToolEventDto } from "../src/shared/types";
import { addMemory, listMemories, MAX_MEMORIES } from "../src/worker/db/memories";
import type { ProviderHealth, ProviderStateStore } from "../src/worker/db/provider-state";
import { createUser } from "../src/worker/db/users";
import { runAgent } from "../src/worker/llm/agent";
import { planPrefetch } from "../src/worker/llm/prefetch";
import { buildSystemPrompt } from "../src/worker/llm/context";
import { ToolCallAccumulator, toWireMessages } from "../src/worker/llm/providers/openai-compatible";
import {
  flattenToolMessages,
  ProviderError,
  type ChatMessage,
  type Provider,
  type ProviderRequest,
  type StreamChunk,
  type ToolCall,
} from "../src/worker/llm/types";
import { CalcError, evaluate } from "../src/worker/tools/calculator";
import { ALL_TOOLS, enabledTools, type ToolContext } from "../src/worker/tools/registry";
import { chunkUnits } from "../src/shared/chunking";
import {
  addChunks,
  buildMatchQuery,
  completeDocument,
  createCollection,
  createDocument,
  deleteDocument,
  MAX_KNOWLEDGE_CHARS,
  type KnowledgeHit,
} from "../src/worker/db/knowledge";
import { passageAboutQuestion, quotedOrganisations, rerank, topicWords } from "../src/worker/tools/knowledge";
import { nearDuplicate, organisationNames, QUALITY_BOOST, rankResults, sourceQuality } from "../src/worker/tools/web";

describe("knowledge base search", () => {
  const tool = ALL_TOOLS.find((t) => t.name === "search_knowledge")!;
  const ctx = (): ToolContext => ({ db: env.DB, userId: "u1", settings: { ...DEFAULT_SETTINGS }, now: new Date() });

  async function addPdf(folder: string, title: string, pages: string[], finish = true) {
    const collection = await createCollection(env.DB, { name: folder, description: "" });
    const chunks = chunkUnits(pages.map((text, i) => ({ location: `page ${i + 1}`, text })));
    const doc = await createDocument(env.DB, {
      collectionId: collection.id,
      title,
      kind: "pdf",
      pages: pages.length,
      expectedChunks: chunks.length,
      totalChars: chunks.reduce((n, c) => n + c.text.length, 0),
    });
    await addChunks(env.DB, doc.id, chunks);
    if (finish) await completeDocument(env.DB, doc.id);
    return doc;
  }

  it("finds passages by key words (word stems too) and cites the document and page", async () => {
    await addPdf("Policies", "Handbook.pdf", [
      "Welcome to the company handbook.",
      "Annual leave: employees get 24 days of paid leave per year. Unused days can be carried over until March.",
      "Salaries are paid on the 25th of each month.",
    ]);
    const out = await tool.run({ query: "How many leaves do employees get?" }, ctx());
    expect(out.summary).toBe("Found 1 passage in 1 document");
    expect(out.content).toContain("24 days of paid leave");
    expect(out.content).toContain("Untrusted content from the knowledge base");
    expect(out.sources).toEqual([{ title: "Handbook.pdf", location: "page 2" }]);

    const none = await tool.run({ query: "quantum chromodynamics" }, ctx());
    expect(none.summary).toMatch(/^Nothing found/);
    expect(none.sources).toBeUndefined();
  });

  it("searches only finished documents, honours the folder filter and forgets deleted documents", async () => {
    await addPdf("Unfinished", "Draft.pdf", ["Parking rules: visitors park in zone B."], false);
    const doc = await addPdf("Facilities", "Building.pdf", ["Parking rules: staff park in zone A."]);
    const all = await tool.run({ query: "parking zone" }, ctx());
    expect(all.content).toContain("zone A");
    expect(all.content).not.toContain("zone B");
    expect((await tool.run({ query: "parking zone", folder: "Policies" }, ctx())).summary).toMatch(/^Nothing found/);
    expect((await tool.run({ query: "parking zone", folder: "facilities" }, ctx())).content).toContain("zone A");
    await deleteDocument(env.DB, doc.id);
    expect((await tool.run({ query: "parking zone" }, ctx())).summary).toMatch(/^Nothing found/);
  });

  it("refuses documents beyond the free space and incomplete uploads", async () => {
    const collection = await createCollection(env.DB, { name: "Big", description: "" });
    await expect(
      createDocument(env.DB, { collectionId: collection.id, title: "x", kind: "txt", expectedChunks: 1, totalChars: MAX_KNOWLEDGE_CHARS + 1 }),
    ).rejects.toThrow(/too large|full/);
    const doc = await createDocument(env.DB, { collectionId: collection.id, title: "two.txt", kind: "txt", expectedChunks: 2, totalChars: 20 });
    await addChunks(env.DB, doc.id, [{ seq: 0, location: "", text: "first part" }]);
    await addChunks(env.DB, doc.id, [{ seq: 0, location: "", text: "first part" }]); // a retried batch is harmless
    await expect(completeDocument(env.DB, doc.id)).rejects.toThrow(/incomplete \(1 of 2/);
    await expect(addChunks(env.DB, doc.id, [{ seq: 5, location: "", text: "x" }])).rejects.toThrow(/out of range/);
    await addChunks(env.DB, doc.id, [{ seq: 1, location: "", text: "second part" }]);
    expect((await completeDocument(env.DB, doc.id)).status).toBe("ready");
  });

  it("re-orders candidates with the re-ranker, and keeps keyword order when it fails", async () => {
    const hit = (n: number): KnowledgeHit => ({
      chunkId: n,
      text: `passage ${n}`,
      location: "",
      documentId: "d",
      title: "t",
      kind: "txt",
      sourceUrl: null,
      collection: "c",
    });
    const hits = [hit(0), hit(1), hit(2)];
    const good = { run: async () => ({ response: [{ id: 0, score: 0.2 }, { id: 2, score: 0.9 }] }) } as unknown as Ai;
    expect((await rerank(good, "q", hits, 2)).map((h) => h.chunkId)).toEqual([2, 0]);
    const broken = {
      run: async () => {
        throw new Error("boom");
      },
    } as unknown as Ai;
    expect((await rerank(broken, "q", hits, 2)).map((h) => h.chunkId)).toEqual([0, 1]);
    expect((await rerank(undefined, "q", hits, 5)).map((h) => h.chunkId)).toEqual([0, 1, 2]);
  });

  it("labels passages that quote an organisation as 'your document (quoting X)'", async () => {
    await addPdf("Quotes", "Survey.pdf", [
      "In February 2023, GitHub reported that 62% of Java code was written by Copilot.",
      "Our own team measured build times across all projects last spring.",
    ]);
    const quoted = JSON.parse((await tool.run({ query: "Java code Copilot" }, ctx())).content).data.results;
    expect(quoted[0].source).toBe("your document (quoting GitHub)");
    const own = JSON.parse((await tool.run({ query: "build times projects" }, ctx())).content).data.results;
    expect(own[0].source).toBe("your document");
  });

  it("knows when a passage is about a question: two shared topic words (or the only one), ignoring common words and years", () => {
    const copilot = topicWords("According to GitHub, what share of Java code does Copilot write?");
    expect([...copilot].sort()).toEqual(["code", "copil", "githu", "java"]);
    expect(passageAboutQuestion("In February 2023, GitHub reported that for Java only, Copilot wrote 62%.", copilot)).toBe(true);
    expect(passageAboutQuestion("Version 2 of the leave policy, effective 2023.", topicWords("latest stable Python version 2023"))).toBe(false);
    expect(passageAboutQuestion("Python was created by Guido van Rossum.", topicWords("Python"))).toBe(true);
    expect([...topicWords("what is the latest version?")]).toEqual([]); // only common words: nothing to match
    expect(passageAboutQuestion("The thing and the other.", topicWords("what is the latest version?"))).toBe(false);
  });

  it("recognises which organisation a passage quotes, but not authors or sentence starts", () => {
    expect(quotedOrganisations("In February 2023, GitHub reported that, on average, 46% of code was written by Copilot.")).toEqual(["GitHub"]);
    expect(quotedOrganisations("Thomas Dohmke, CEO of GitHub, said Copilot will write 80% of code.")).toEqual(["GitHub"]);
    expect(quotedOrganisations("According to the World Health Organization, cases fell.")).toEqual(["World Health Organization"]);
    expect(quotedOrganisations("Peng et al. [40] reported that programmers were faster. We found the same. The study showed gains.")).toEqual([]);
  });

  it("builds safe full-text queries from any text", () => {
    expect(buildMatchQuery('What is the "leave" OR policy* NEAR(x)?')).toBe('"leave" OR "policy" OR "near"'); // 1-letter words dropped
    expect(buildMatchQuery("the")).toBe('"the"'); // only common words: search them anyway
    expect(buildMatchQuery("?! --")).toBeNull();
  });

  it("names the folders in the system prompt and asks for citations", () => {
    const prompt = buildSystemPrompt({
      appName: "VESPER",
      customInstructions: "",
      tools: ["search_knowledge"],
      knowledge: [{ name: "Policies", description: "HR rules" }],
    });
    expect(prompt).toContain("• Policies — HR rules");
    expect(prompt).toContain("(Handbook.pdf, page 12)");
  });

  it("gives the source rules R1–R7 with web tools (R3 only with documents), and none without them", () => {
    const both = buildSystemPrompt({ appName: "V", customInstructions: "", tools: ["web_search", "read_page", "search_knowledge"], knowledge: [] });
    for (const rule of ["R1.", "R2.", "R3.", "R3b.", "R4.", "R5.", "R6.", "R7."]) expect(both).toContain(rule);
    expect(both).toContain('no ranges like "61% to 62%"');
    expect(both).toContain('"your document (quoting X)"'); // a document quoting GitHub is second-hand for GitHub's figures
    expect(both).toContain("official_page_passages");
    expect(both).toContain('"Note:" line only when sources actually give different figures');
    expect(both).toContain('time_range "year"');
    expect(both).toContain("open it with read_page");
    expect(both).toContain("not for writing, explaining or brainstorming"); // R6 never blocks ordinary requests
    expect(buildSystemPrompt({ appName: "V", customInstructions: "", tools: ["web_search"] })).not.toContain("R3.");
    expect(buildSystemPrompt({ appName: "V", customInstructions: "", tools: ["calculator"] })).not.toContain("R4.");
  });
});

describe("source quality and ranking", () => {
  const none = new Set<string>();
  const github = organisationNames("According to GitHub, what share of code does Copilot write?");

  it("recognises government sites, including country versions, and international bodies", () => {
    for (const url of [
      "https://www.pbs.gov.pk/content/census",
      "https://www.gov.uk/x",
      "https://data.census.gov/y",
      "https://www.who.int/news",
      "https://www.gob.mx/",
      "https://www.service-public.gouv.fr/",
      "https://www.mhlw.go.jp/",
      "https://www.canada.ca/en",
      "https://www.un.org/en",
      "https://www.hc-sc.gc.ca/",
    ]) {
      expect(sourceQuality(url, none), url).toBe("government");
    }
  });

  it("gives universities (.edu, edu.pk, ac.uk…) a smaller boost than government sites", () => {
    for (const url of ["https://mit.edu/x", "https://lums.edu.pk/y", "https://www.ox.ac.uk/z", "https://www.iitb.ac.in/"]) {
      expect(sourceQuality(url, none), url).toBe("education");
    }
    expect(QUALITY_BOOST.education).toBeLessThan(QUALITY_BOOST.government);
    expect(QUALITY_BOOST.education).toBeLessThan(QUALITY_BOOST.official);
    expect(QUALITY_BOOST.education).toBeGreaterThan(QUALITY_BOOST.other);
  });

  it("counts an organisation's own site only on an exact name match, never 'contains the name'", () => {
    expect(sourceQuality("https://github.blog/news-insights/x", github)).toBe("official");
    expect(sourceQuality("https://docs.github.com/en", github)).toBe("official");
    expect(sourceQuality("https://githubstats.com/copilot", github)).toBe("other");
    expect(sourceQuality("https://mygithub.blog/x", github)).toBe("other");
    expect(sourceQuality("https://copilot-stats.github.io/", github)).toBe("other"); // a page hosted on GitHub, not GitHub's own
    expect(sourceQuality("https://medium.com/@someone/github", github)).toBe("other");
    expect(sourceQuality("https://survey.stackoverflow.co/2025", organisationNames("Stack Overflow survey"))).toBe("official");
    expect(sourceQuality("https://nodejs.org/en", organisationNames("latest Node.js LTS"))).toBe("official");
    expect(sourceQuality("https://news.com/x", organisationNames("latest news today"))).toBe("other"); // common words aren't names
  });

  it("puts the admin's trusted sites first and drops blocked ones, subdomains included", () => {
    const r = (url: string) => ({ url, snippet: `text about ${url}` });
    const ranked = rankResults([r("https://other.com/1"), r("https://spam.blocked.net/2"), r("https://www.dawn.com/3")], {
      trusted: ["dawn.com"],
      blocked: ["blocked.net"],
      about: "",
      now: new Date(),
      keep: 6,
    });
    expect(ranked.map((x) => [x.url, x.quality])).toEqual([
      ["https://www.dawn.com/3", "trusted"],
      ["https://other.com/1", "other"],
    ]);
  });

  it("ranks newer results higher only when asked, keeps old ones (no hard filter), and never demotes official ones for age", () => {
    const now = new Date("2026-11-19T00:00:00Z");
    const r = (url: string, published: string) => ({ url, published, snippet: `snippet for ${url}` });
    const old = r("https://old.example.com/a", "2018-05-01");
    const fresh = r("https://new.example.com/b", "2026-10-01");
    const base = { trusted: [], blocked: [], about: "According to GitHub", now, keep: 6 };
    expect(rankResults([old, fresh], base).map((x) => x.url)).toEqual([old.url, fresh.url]);
    expect(rankResults([old, fresh], { ...base, prefer: "year" }).map((x) => x.url)).toEqual([fresh.url, old.url]);
    const official = r("https://github.blog/c", "2023-02-14");
    expect(rankResults([fresh, official], { ...base, prefer: "year" }).map((x) => x.url)).toEqual([official.url, fresh.url]);
  });

  it("drops near-duplicate results: the same page, or snippets saying practically the same thing", () => {
    const text = "GitHub Copilot now writes an average of forty six percent of code across all languages";
    const ranked = rankResults(
      [
        { url: "https://a.example.com/story?utm=1", snippet: text },
        { url: "https://www.a.example.com/story/", snippet: "different words entirely here" },
        { url: "https://b.example.com/copy", snippet: `${text}!` },
        { url: "https://c.example.com/other", snippet: "an unrelated snippet about weather in Lahore this week and next" },
      ],
      { trusted: [], blocked: [], about: "", now: new Date(), keep: 6 },
    );
    expect(ranked.map((x) => x.url)).toEqual(["https://a.example.com/story?utm=1", "https://c.example.com/other"]);
    expect(nearDuplicate({ url: "https://x.com/1", snippet: "short" }, { url: "https://y.com/2", snippet: "short" })).toBe(false);
  });
});

describe("calculator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["2 ^ -1", 0.5],
    ["10 % 4", 2],
    ["5!", 120],
    ["0.1 + 0.2", 0.3],
    ["sqrt(16) + abs(-3)", 7],
    ["round(pi, 4)", 3.1416],
    ["max(3, 9, 4) - min(2, 8)", 7],
    ["log(1000)", 3],
    ["log(8, 2)", 3],
    ["ln(e)", 1],
    ["sin(rad(90))", 1],
    ["1.5e3 / 3", 500],
    ["12 × 3 ÷ 4", 9],
    ["2**10", 1024],
    ["(1250 * 0.18) + 2^10", 1249],
  ])("%s = %s", (expression, expected) => {
    expect(evaluate(expression)).toBe(expected);
  });

  it.each([
    ["1 / 0", /Division by zero/],
    ["sqrt(-1)", /not a number/],
    ["2 +", /end of expression/],
    ["foo(1)", /Unknown function/],
    ["alert(1)", /Unknown function/],
    ["constructor", /Unknown name/],
    ["constructor(1)", /Unknown function/],
    ["__proto__", /Unknown name/],
    ["tostring(1)", /Unknown function/],
    ["1; 2", /Unexpected character/],
    ["(1 + 2", /Expected "\)"/],
    ["pow(2)", /takes 2 argument/],
    ["171!", /too large/],
    ["2.5!", /non-negative integers/],
    ["(".repeat(100) + "1" + ")".repeat(100), /nested too deeply/],
  ])("rejects %s", (expression, message) => {
    expect(() => evaluate(expression)).toThrow(CalcError);
    expect(() => evaluate(expression)).toThrow(message);
  });
});

describe("tool-call streaming helpers", () => {
  it("reassembles fragmented tool calls and keeps provider-specific fields", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "calculator", arguments: '{"expr' } }] } }] });
    acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] } }] });
    acc.add({
      choices: [
        { delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "current_datetime", arguments: "{}" }, extra_content: { google: { thought_signature: "sig" } } }] } },
      ],
    });
    const calls = acc.finish();
    expect(calls).toEqual([
      { id: "c1", name: "calculator", arguments: '{"expression":"1+1"}' },
      { id: "c2", name: "current_datetime", arguments: "{}", extra: { extra_content: { google: { thought_signature: "sig" } } } },
    ]);
    // The signature must be echoed back on the next request (Gemini requires it).
    const wire = toWireMessages([{ role: "assistant", content: null, tool_calls: calls }], false);
    expect(wire[0]).toMatchObject({ tool_calls: [{ id: "c1" }, { id: "c2", extra_content: { google: { thought_signature: "sig" } } }] });
  });

  it("invents ids when a provider omits them", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ choices: [{ delta: { tool_calls: [{ function: { name: "calculator", arguments: '{"expression":"2"}' } }] } }] });
    expect(acc.finish()[0]!.id).toMatch(/^call_0_/);
  });

  it("only sends tool `name` to providers that want it", () => {
    const tool: ChatMessage = { role: "tool", tool_call_id: "c1", name: "calculator", content: "{}" };
    expect(toWireMessages([tool], false)[0]).not.toHaveProperty("name");
    expect(toWireMessages([tool], true)[0]).toHaveProperty("name", "calculator");
  });

  it("flattens a tool transcript into plain text for models without tool support", () => {
    const flat = flattenToolMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "calculator", arguments: '{"expression":"2+2"}' }] },
      { role: "tool", tool_call_id: "c1", name: "calculator", content: '{"result":4}' },
    ]);
    // The tool turn becomes a neutral note merged into the user turn; no "[Used tool …]" text for the model to imitate.
    expect(flat.map((m) => m.role)).toEqual(["system", "user"]);
    expect(flat[1]!.content).toContain("What is 2+2?");
    expect(flat[1]!.content).toContain('- calculator({"expression":"2+2"}) returned: {"result":4}');
    expect(flat[1]!.content).toContain("Do not repeat or quote this note");
    expect(JSON.stringify(flat)).not.toContain("Used tool");
  });
});

describe("tool settings", () => {
  it("respects the master switch, per-tool switches and the memory switch", () => {
    // Without a search key, web search isn't offered; without documents, the knowledge base isn't; without the user's
    // GitHub connection (v0.12.0), the GitHub tools aren't; outside a chat with a spreadsheet (v0.14.0), Table analysis
    // isn't; without Google (v0.15.0), the calendar and email tools aren't; with all of them, every tool is.
    const googleTools = ["calendar_events", "calendar_free_time", "calendar_create_event", "gmail_send"];
    const all = ALL_TOOLS.map((t) => t.name).filter((n) => n !== "query_table" && !googleTools.includes(n));
    const noGithub = all.filter((n) => !n.startsWith("github_"));
    expect(enabledTools({ ...DEFAULT_SETTINGS }).map((t) => t.name)).toEqual(noGithub.filter((n) => n !== "web_search" && n !== "search_knowledge"));
    const web = { userAgent: "test", tavilyApiKey: "k", webSearchDailyLimit: 30 };
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web }).map((t) => t.name)).toEqual(noGithub.filter((n) => n !== "search_knowledge"));
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web, knowledgeReady: true }).map((t) => t.name)).toEqual(noGithub);
    // Reading (v0.12.0) and changes with approval (v0.13.0) are separate connections, each with its own tools.
    const changes = ["github_create_issue", "github_comment", "github_open_pr"];
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web, knowledgeReady: true, github: true }).map((t) => t.name)).toEqual(all.filter((n) => !changes.includes(n)));
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web, knowledgeReady: true, githubActions: true }).map((t) => t.name)).toEqual([...noGithub, ...changes]);
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web, knowledgeReady: true, github: true, githubActions: true }).map((t) => t.name)).toEqual(all);
    expect(
      enabledTools({ ...DEFAULT_SETTINGS }, [], { web, knowledgeReady: true, github: true, githubActions: true, tables: true, googleCalendar: true, gmailSend: true }).map(
        (t) => t.name,
      ),
    ).toEqual(ALL_TOOLS.map((t) => t.name));
    // Google: the calendar tools need Calendar allowed, the email tool needs sending allowed.
    const offered = (server: { googleCalendar?: boolean; gmailSend?: boolean }) => enabledTools({ ...DEFAULT_SETTINGS }, [], server).map((t) => t.name).filter((n) => googleTools.includes(n));
    expect(offered({ googleCalendar: true })).toEqual(["calendar_events", "calendar_free_time", "calendar_create_event"]);
    expect(offered({ gmailSend: true })).toEqual(["gmail_send"]);
    expect(offered({})).toEqual([]);
    expect(all.filter((n) => n.startsWith("github_"))).toEqual(["github_repo", "github_file", "github_search", "github_issues", "github_pr_changes", ...changes]);
    expect(enabledTools({ ...DEFAULT_SETTINGS }, [], { web: { ...web, webSearchDailyLimit: 0 } }).map((t) => t.name)).not.toContain("web_search");
    expect(enabledTools({ ...DEFAULT_SETTINGS, toolsEnabled: false })).toEqual([]);
    expect(enabledTools({ ...DEFAULT_SETTINGS, disabledTools: ["calculator"] }).map((t) => t.name)).not.toContain("calculator");
    const noMemory = enabledTools({ ...DEFAULT_SETTINGS, memoryEnabled: false }).map((t) => t.name);
    expect(noMemory).toEqual(["calculator", "current_datetime", "read_page", "weather", "wikipedia", "currency"]);
  });

  it("puts memories and tool guidance into the system prompt", () => {
    const prompt = buildSystemPrompt({
      appName: "VESPER",
      customInstructions: "",
      memories: [{ id: "m1", content: "Prefers Python.", source: "user", createdAt: 0 }],
      tools: ["calculator", "remember"],
    });
    expect(prompt).toContain("You are VESPER");
    expect(prompt).toContain("Tools available: calculator, remember.");
    expect(prompt).toContain("- [m1] Prefers Python.");
    expect(buildSystemPrompt({ appName: "X", customInstructions: "" })).not.toContain("Long-term memory");
  });
});

// ---------- Agent loop ----------

type Turn = { text?: string; calls?: ToolCall[]; fail?: ProviderError };

/** Scripted provider: each stream() call plays the next turn and records what it was sent. */
class ScriptedProvider implements Provider {
  readonly label: string;
  readonly freeTier = "";
  readonly notes: string[] = [];
  readonly signupUrl = "";
  requests: ProviderRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly turns: Turn[],
    readonly supportsTools = true,
  ) {
    this.label = id;
  }
  isConfigured() {
    return true;
  }
  isAllowedModel() {
    return true;
  }
  async defaultModel() {
    return "m";
  }
  async fetchModels(): Promise<ModelInfo[]> {
    return [];
  }
  async stream(request: ProviderRequest): Promise<AsyncIterable<StreamChunk>> {
    this.requests.push(request);
    const turn = this.turns.shift() ?? { text: "fallback text" };
    if (turn.fail) throw turn.fail;
    return (async function* () {
      if (turn.text) yield { type: "text", text: turn.text } as StreamChunk;
      if (turn.calls) yield { type: "tool_calls", calls: turn.calls } as StreamChunk;
    })();
  }
}

const noopStore: ProviderStateStore = {
  getHealth: async () => new Map<ProviderId, ProviderHealth>(),
  setCooldown: async () => {},
  clearCooldown: async () => {},
  recordUsage: async () => {},
};

async function agent(
  providers: ScriptedProvider[],
  options: { maxRounds?: number; userId?: string; messages?: ChatMessage[]; prefetch?: ToolCall | null } = {},
) {
  const map = new Map<ProviderId, Provider>(providers.map((p) => [p.id, p]));
  const toolEvents: ToolEventDto[] = [];
  const text: string[] = [];
  const result = await runAgent({
    plan: providers.map((p) => ({ provider: p.id, model: "m" })),
    providers: map,
    messages: options.messages ?? [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    tools: ALL_TOOLS,
    toolContext: { db: env.DB, userId: options.userId ?? "nobody", settings: DEFAULT_SETTINGS, now: new Date("2026-11-10T12:00:00Z") },
    maxTokens: 100,
    signal: new AbortController().signal,
    store: noopStore,
    health: new Map(),
    sleep: async () => {},
    maxRounds: options.maxRounds,
    prefetch: options.prefetch ?? null,
    events: {
      attempt: () => {},
      fallback: () => {},
      reasoning: () => {},
      text: (t) => void text.push(t),
      tool: (e) => void toolEvents.push(e),
    },
  });
  return { result, toolEvents, streamed: text.join("") };
}

const call = (name: string, args: object, id = `c_${name}`): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

describe("runAgent", () => {
  it("runs a tool, feeds the result back and returns the final answer", async () => {
    const groq = new ScriptedProvider("groq", [
      { text: "Let me calculate.", calls: [call("calculator", { expression: "2^10" })] },
      { text: "2^10 is 1024." },
    ]);
    const { result, toolEvents, streamed } = await agent([groq]);
    expect(result.status).toBe("complete");
    expect(result.text).toBe("Let me calculate.\n\n2^10 is 1024.");
    expect(streamed).toBe(result.text);
    expect(result.tools).toEqual([
      { id: "c_calculator", name: "calculator", label: "Calculator", args: { expression: "2^10" }, status: "done", summary: "2^10 = 1024" },
    ]);
    expect(toolEvents.map((e) => e.status)).toEqual(["running", "done"]);
    // Second request carries the assistant tool call and the tool result.
    const second = groq.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ name: "calculator" }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c_calculator", content: '{"expression":"2^10","result":1024}' });
    expect(groq.requests[0]!.tools?.map((t) => t.function.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  async function addDocument(folder: string, title: string, pages: string[]) {
    const collection = await createCollection(env.DB, { name: folder, description: "" });
    const chunks = chunkUnits(pages.map((text, i) => ({ location: `page ${i + 1}`, text })));
    const doc = await createDocument(env.DB, {
      collectionId: collection.id,
      title,
      kind: "pdf",
      pages: pages.length,
      expectedChunks: chunks.length,
      totalChars: chunks.reduce((n, c) => n + c.text.length, 0),
    });
    await addChunks(env.DB, doc.id, chunks);
    await completeDocument(env.DB, doc.id);
  }

  it("also searches the knowledge base when the model goes to the web first, once per reply", async () => {
    await addDocument("Research", "Survey.pdf", ["GitHub reported that Copilot now writes a large share of developers' code."]);
    const groq = new ScriptedProvider("groq", [
      { calls: [call("web_search", { query: "Copilot share of code" })] },
      { calls: [call("web_search", { query: "Copilot Java share" }, "c_web2")] },
      { text: "Done." },
    ]);
    const { result } = await agent([groq]);
    expect(result.status).toBe("complete");
    // The paired search shows as its own step; the second web search isn't paired again.
    expect(result.tools.map((t) => t.name)).toEqual(["web_search", "search_knowledge", "web_search"]);
    expect(result.tools[1]).toMatchObject({ id: "c_web_search-kb", args: { query: "Copilot share of code", limit: 3 } });
    // The model gets exactly one result per call it made (none for the paired search); the first carries both parts.
    const toolMessages = groq.requests.at(-1)!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c_web_search", "c_web2"]);
    expect(toolMessages[0]!.content).toContain("knowledge base (the administrator's documents) was also searched automatically");
    expect(toolMessages[0]!.content).toContain("[This document quotes GitHub; it is not GitHub's own publication]");
    expect(toolMessages[1]!.content).not.toContain("knowledge base");
  });

  it("adds no document passages to a web look-up they aren't about (no tokens spent on them)", async () => {
    // Shares the word "version" with the search, so it's found, but it isn't about Python: it must not be added.
    await addDocument("Policies", "Handbook.pdf", ["Version 2 of the leave policy: employees get 24 days of paid leave per year."]);
    const groq = new ScriptedProvider("groq", [{ calls: [call("web_search", { query: "latest stable Python version" })] }, { text: "Done." }]);
    const { result } = await agent([groq]);
    expect(result.tools.map((t) => [t.name, t.summary])).toEqual([
      ["web_search", expect.any(String)],
      ["search_knowledge", 'Nothing relevant for "latest stable Python version"'],
    ]);
    const toolMessage = groq.requests.at(-1)!.messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).not.toContain("knowledge base");
  });

  it("runs the server's look-up before the first request, so the model answers in one call", async () => {
    await addDocument("Research", "Paper.pdf", ["CodeCompose at Meta: the acceptance rate from developers was 22% over 4.5 million suggestions."]);
    const groq = new ScriptedProvider("groq", [{ text: "The PDF says 22% (Paper.pdf, page 1)." }]);
    const question = "What does my PDF say about the CodeCompose acceptance rate?";
    const { result, toolEvents } = await agent([groq], {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: question },
      ],
      prefetch: planPrefetch(question, new Set(ALL_TOOLS.map((t) => t.name))),
    });
    expect(groq.requests).toHaveLength(1);
    const sent = groq.requests[0]!.messages.at(-1)!;
    expect(sent.role).toBe("user");
    expect(sent.content).toMatch(/^What does my PDF say about the CodeCompose acceptance rate\?/);
    expect(sent.content).toContain('The app already ran "Knowledge base"');
    expect(sent.content).toContain("acceptance rate from developers was 22%");
    expect(result.tools[0]).toMatchObject({ name: "search_knowledge", status: "done" });
    expect(toolEvents[0]).toMatchObject({ name: "search_knowledge", status: "running" });
    expect(result.tools.at(-1)).toMatchObject({ name: "answer_check", status: "done" }); // 22% is in the passage
  });

  it("leaves the question as it is when the server's look-up fails, and the model works as before", async () => {
    const groq = new ScriptedProvider("groq", [{ text: "I can't search right now." }]);
    const question = "What is the latest stable version of Python?";
    const { result } = await agent([groq], {
      messages: [{ role: "user", content: question }],
      prefetch: planPrefetch(question, new Set(ALL_TOOLS.map((t) => t.name))),
    });
    expect(result.tools[0]).toMatchObject({ name: "web_search", status: "error" }); // no search key in tests
    expect(groq.requests[0]!.messages.at(-1)!.content).toBe(question);
    expect(result.status).toBe("complete");
  });

  it("checks the answer's numbers against whole document passages, the question and the chat, and lists only the unsupported one", async () => {
    const folder = await createCollection(env.DB, { name: "Number check research", description: "" });
    // Longer than the 1,100 characters the model is shown: the figures sit in the part it doesn't see, so only the
    // whole passage (the check's evidence) contains them.
    const filler = "Background on code completion tools and how teams adopt them. ".repeat(20);
    const chunks = chunkUnits([{ location: "page 6", text: `${filler}CodeCompose made 4.5 million suggestions; the acceptance rate was 22%.` }]);
    const doc = await createDocument(env.DB, {
      collectionId: folder.id,
      title: "Paper.pdf",
      kind: "pdf",
      pages: 1,
      expectedChunks: chunks.length,
      totalChars: chunks.reduce((n, c) => n + c.text.length, 0),
    });
    await addChunks(env.DB, doc.id, chunks);
    await completeDocument(env.DB, doc.id);
    const groq = new ScriptedProvider("groq", [
      { calls: [call("search_knowledge", { query: "CodeCompose acceptance rate" })] },
      { text: "CodeCompose's acceptance rate was 22% over 4.5 million suggestions (Paper.pdf, page 6). For your 37 teams and 1,234 users, about 63% would accept." },
    ]);
    const { result, toolEvents } = await agent([groq], {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "How many users do we have?" },
        { role: "assistant", content: "You have 1,234 users." },
        { role: "user", content: "What acceptance rate would CodeCompose give our 37 teams?" },
      ],
    });
    expect(result.status).toBe("complete");
    const check = result.tools.at(-1)!;
    expect(check).toMatchObject({ name: "answer_check", label: "Number check", status: "error", summary: "Not found in any source: 63%" });
    expect(toolEvents.at(-1)).toEqual(check);
  });

  it("adds no number check after replies that only used the calculator", async () => {
    const groq = new ScriptedProvider("groq", [{ calls: [call("calculator", { expression: "18% * 12500" })] }, { text: "That's 2,250." }]);
    const { result } = await agent([groq]);
    expect(result.tools.map((t) => t.name)).toEqual(["calculator"]);
  });

  it("reports bad tool input to the model instead of failing the turn", async () => {
    const groq = new ScriptedProvider("groq", [
      { calls: [call("calculator", { expression: "1/0" }), call("nope", {}), { id: "c_bad", name: "calculator", arguments: "{not json" }] },
      { text: "Sorry, that division is undefined." },
    ]);
    const { result } = await agent([groq]);
    expect(result.status).toBe("complete");
    expect(result.tools.map((t) => [t.name, t.status, t.summary])).toEqual([
      ["calculator", "error", "Division by zero"],
      ["nope", "error", expect.stringContaining('Unknown tool "nope"')],
      ["calculator", "error", expect.any(String)],
    ]);
    const toolMessages = groq.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]!.content).toContain("Division by zero");
  });

  it("stops offering tools on the last round so the model must answer", async () => {
    const loop: Turn[] = Array.from({ length: 10 }, () => ({ calls: [call("current_datetime", {})] }));
    const groq = new ScriptedProvider("groq", loop);
    await agent([groq], { maxRounds: 2 });
    expect(groq.requests.map((r) => r.tools?.length ?? 0)).toEqual([ALL_TOOLS.length, ALL_TOOLS.length, 0]);
  });

  it("falls back mid-task and gives a tool-less provider a flattened transcript", async () => {
    const groq = new ScriptedProvider("groq", [
      { calls: [call("calculator", { expression: "6*7" })] },
      { fail: new ProviderError("rate_limit", "429") },
    ]);
    const workers = new ScriptedProvider("workers-ai", [{ text: "The answer is 42." }], false);
    const { result } = await agent([groq, workers]);
    expect(result.status).toBe("complete");
    expect(result.target?.provider).toBe("workers-ai");
    const sent = workers.requests[0]!;
    expect(sent.tools).toBeUndefined();
    expect(sent.messages.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(sent.messages)).toContain("calculator({\\\"expression\\\":\\\"6*7\\\"}) returned");
  });

  it("hands a tool-using task from Groq to Gemini without sending Groq's tool history natively", async () => {
    // Regression: Groq called the calculator, then hit its rate limit; Gemini rejected the foreign
    // tool history (no thought signatures) and the old fallback text leaked into the answer.
    const groq = new ScriptedProvider("groq", [
      { calls: [call("calculator", { expression: "0.175*2340" })] },
      { fail: new ProviderError("rate_limit", "429") },
    ]);
    const gemini = new ScriptedProvider("gemini", [
      { calls: [call("calculator", { expression: "409.5 * 1.15" }, "g1")] },
      { text: "17.5% of 2,340 is 409.50; with a 15% tip that's 470.93." },
    ]);
    const { result } = await agent([groq, gemini]);
    expect(result.status).toBe("complete");
    expect(result.text).toBe("17.5% of 2,340 is 409.50; with a 15% tip that's 470.93.");
    expect(result.tools.map((t) => t.summary)).toEqual(["0.175*2340 = 409.5", "409.5 * 1.15 = 470.925"]);
    // Gemini's first request: Groq's call arrives as a note, but tools are still offered.
    const first = gemini.requests[0]!;
    expect(first.tools?.length).toBeGreaterThan(0);
    expect(first.messages.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(first.messages)).toContain("0.175*2340");
    // Gemini's second request: while foreign calls are in the history, all tool history is sent as notes
    // (no native function calls means no signatures for Gemini to validate).
    const second = gemini.requests[1]!;
    expect(second.messages.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(second.messages)).toContain("409.5 * 1.15");
  });

  it("sends a provider's own tool history natively", async () => {
    const gemini = new ScriptedProvider("gemini", [{ calls: [call("calculator", { expression: "1+1" })] }, { text: "2" }]);
    await agent([gemini]);
    const second = gemini.requests[1]!;
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c_calculator" });
    expect((second.messages.at(-2) as { tool_calls: { origin?: string }[] }).tool_calls[0]!.origin).toBe("gemini");
  });

  it("retries as plain chat when a model rejects function calling", async () => {
    const openrouter = new ScriptedProvider("openrouter", [
      { fail: new ProviderError("not_found", "OpenRouter: No endpoints found that support tool use") },
      { text: "Plain answer." },
    ]);
    const { result } = await agent([openrouter]);
    expect(result.text).toBe("Plain answer.");
    expect(openrouter.requests[0]!.tools).toBeDefined();
    expect(openrouter.requests[1]!.tools).toBeUndefined();
  });

  it("saves and forgets memories through tools, scoped to the user", async () => {
    const user = await createUser(env.DB, { githubId: 501, githubLogin: "mem-user", login: "mem-user", name: null, avatarUrl: null });
    const groq = new ScriptedProvider("groq", [
      { calls: [call("remember", { fact: "Prefers dark mode." })] },
      { text: "Noted." },
    ]);
    await agent([groq], { userId: user.id });
    const saved = await listMemories(env.DB, user.id);
    expect(saved.map((m) => [m.content, m.source])).toEqual([["Prefers dark mode.", "assistant"]]);

    const forget = new ScriptedProvider("groq", [{ calls: [call("forget", { memory_id: saved[0]!.id })] }, { text: "Forgotten." }]);
    await agent([forget], { userId: user.id });
    expect(await listMemories(env.DB, user.id)).toEqual([]);

    const secret = new ScriptedProvider("groq", [{ calls: [call("remember", { fact: "My password is hunter2" })] }, { text: "I won't store that." }]);
    const { result } = await agent([secret], { userId: user.id });
    expect(result.tools[0]!.status).toBe("error");
    expect(await listMemories(env.DB, user.id)).toEqual([]);
  });

  it("caps the number of memories", async () => {
    const user = await createUser(env.DB, { githubId: 502, githubLogin: "cap-user", login: "cap-user", name: null, avatarUrl: null });
    for (let i = 0; i < MAX_MEMORIES; i++) await addMemory(env.DB, user.id, `fact ${i}`, "user");
    await expect(addMemory(env.DB, user.id, "one too many", "user")).rejects.toThrow(/Memory is full/);
    // Exact duplicates are not stored twice.
    expect((await addMemory(env.DB, user.id, "fact 1", "user")).content).toBe("fact 1");
  });
});
