import { describe, expect, it } from "vitest";
import { normalizeMath } from "../src/shared/math";
import { SseParser } from "../src/shared/sse";
import type { MessageDto } from "../src/shared/types";
import { deriveTitle } from "../src/worker/db/conversations";
import { parseSettings } from "../src/worker/db/users";
import { parseProviderOrder } from "../src/worker/env";
import { buildContext } from "../src/worker/llm/context";
import { parseOpenAiChunk } from "../src/worker/llm/providers/openai-compatible";
import { classifyWorkersAiError, msUntilUtcMidnight } from "../src/worker/llm/providers/workers-ai";
import { pickOpenRouterDefault } from "../src/worker/llm/registry";
import { cooldownFor, parseSelection } from "../src/worker/llm/router";
import { classifyHttpError, parseRetryAfter, ProviderError } from "../src/worker/llm/types";
import * as entry from "../src/worker/index";
import { citedSources, plainDocumentLinks, tidyCitations } from "../src/web/lib/format";
import { classifyHttpError as classifyError, retryAfterFromMessage } from "../src/worker/llm/types";

describe("document citations are never links", () => {
  const docs = ["AI in Software Engineering.pdf"];
  it("shows a linked document citation as plain text, and any link that isn't a web address", () => {
    expect(plainDocumentLinks("46% ([AI in Software Engineering.pdf, page 4](https://example.com/x)).", docs)).toBe(
      "46% (AI in Software Engineering.pdf, page 4).",
    );
    expect(plainDocumentLinks("([AI in Software Engineering, page 4](#))", docs)).toBe("(AI in Software Engineering, page 4)");
    expect(plainDocumentLinks("([notes](page-4))", docs)).toBe("(notes)");
    // Seen in a real answer: the "link" points at the file name, spaces included.
    expect(plainDocumentLinks("46% ([AI in Software Engineering.pdf, page 4](AI in Software Engineering.pdf)).", docs)).toBe(
      "46% (AI in Software Engineering.pdf, page 4).",
    );
  });
  it("keeps real web links, web PDFs included", () => {
    const text =
      '([Finance Division](https://www.finance.gov.pk/survey/12_Population.pdf)) and [GitHub blog](https://github.blog/x "GitHub")';
    expect(plainDocumentLinks(text, docs)).toBe(text);
  });
});

describe("Groq's 'try again in …' wait", () => {
  it("reads the wait from the message when no header gives it", () => {
    expect(retryAfterFromMessage("Rate limit reached … Please try again in 26.5125s. Need more tokens?")).toBe(26_513);
    expect(retryAfterFromMessage("Please try again in 1m2.5s")).toBe(62_500);
    expect(retryAfterFromMessage("Please try again in 450ms")).toBe(450);
    expect(retryAfterFromMessage("Slow down")).toBeUndefined();
    const body = JSON.stringify({ error: { message: "Rate limit reached for model on tokens per minute (TPM). Please try again in 6.5s." } });
    expect(classifyError("Groq", 429, body, null).options.retryAfterMs).toBe(6_500);
    expect(classifyError("Groq", 429, body, "12").options.retryAfterMs).toBe(12_000); // the header wins when present
  });
});
import { appSettingsSchema } from "../src/worker/db/app-settings";
import { presentEvent, presentMessage } from "../src/worker/lib/present";
import { checkNumbers, numberCheckEvent } from "../src/worker/llm/number-check";

describe("number check", () => {
  it("compares %, M/K, commas and currency by value", () => {
    const evidence = "Copilot writes 46% of code; 4,500,000 suggestions; revenue of $1.2 billion; 250K users; it costs PKR 12,500.";
    expect(checkNumbers("46 percent of code, 4.5 million suggestions, $1.2B revenue, 250,000 users, Rs 12,500.", evidence)).toEqual({
      checked: 5,
      missing: [],
    });
  });

  it("accepts a rounder figure, but flags a different one", () => {
    expect(checkNumbers("about 4.5 million suggestions and 46% of code", "4,512,000 suggestions and 46.2% of code").missing).toEqual([]);
    expect(checkNumbers("In Java it's 63%.", "In Java it's 61%.").missing).toEqual(["63%"]);
    expect(checkNumbers("Everest is 8,849 m tall", "8,848.86 m").missing).toEqual([]);
  });

  it("ignores years, dates, times, list numbers, page references, ordinals, small counts, code and links", () => {
    const answer = [
      "1. In 2023 GitHub said so (Report.pdf, page 47).",
      "2. On 14 February 2023 at 10:30 AM, 3 teams met; see [the blog](https://example.com/2023/62).",
      "As of Nov 19, 2026 (2026-11-19, 19/11/2026), in the 21st century. Run `npm i x@99`.",
    ].join("\n");
    expect(checkNumbers(answer, "")).toEqual({ checked: 0, missing: [] });
  });

  it("needs version numbers to match exactly", () => {
    expect(checkNumbers("The latest is Python 3.15.2.", "Download Python 3.15.2").missing).toEqual([]);
    expect(checkNumbers("The latest is Python 3.15.3.", "Download Python 3.15.2").missing).toEqual(["3.15.3"]);
  });

  it("makes an admin-only step: a warning listing what's missing, a confirmation, or nothing", () => {
    expect(numberCheckEvent("Java: 63% and 46%", ["46%", "61%"])).toMatchObject({ status: "error", summary: "Not found in any source: 63%" });
    expect(numberCheckEvent("Overall 46%", ["46%"])).toMatchObject({ status: "done", summary: "All 1 number found in the sources" });
    expect(numberCheckEvent("No figures here.", ["46%"])).toBeNull();
  });

  it("is shown to the admin only: users never get it, live or when reopening the chat", () => {
    const check = numberCheckEvent("63%", ["61%"])!;
    const user = { admin: false, showReasoning: false };
    const admin = { admin: true, showReasoning: true };
    expect(presentEvent({ type: "tool", messageId: "m", tool: check } as never, user)).toBeNull();
    expect(presentEvent({ type: "tool", messageId: "m", tool: check } as never, admin)).not.toBeNull();
    const search = { id: "s", name: "web_search", label: "Web search", args: {}, status: "done" as const, summary: "x" };
    const message = { role: "assistant", provider: "groq", tools: [search, check] } as never;
    expect((presentMessage(message, user).tools ?? []).map((t) => t.name)).toEqual(["web_search"]);
    expect((presentMessage(message, admin).tools ?? []).map((t) => t.name)).toEqual(["web_search", "answer_check"]);
  });
});

describe("trusted and blocked website lists", () => {
  it("keeps just the website part, drops blanks and duplicates, and rejects anything that isn't a website", () => {
    expect(appSettingsSchema.shape.trustedSites.parse(["https://www.WHO.int/news/x", "who.int", "", "  sbp.org.pk  ", "pbs.gov.pk:443"])).toEqual([
      "who.int",
      "sbp.org.pk",
      "pbs.gov.pk",
    ]);
    expect(appSettingsSchema.shape.blockedSites.safeParse(["not a website"]).success).toBe(false);
    expect(appSettingsSchema.shape.blockedSites.safeParse(Array.from({ length: 101 }, (_, i) => `s${i}.com`)).success).toBe(false);
  });
});

describe("citations under answers", () => {
  const doc = (location: string, title = "AI in SE.pdf") => ({ title, location });
  const web = { title: "GitHub blog", url: "https://github.blog/x" };

  it("shows 【 】 citations (gpt-oss style) in round brackets", () => {
    expect(tidyCitations("accepted 22 %【AI in SE.pdf, page 6】.")).toBe("accepted 22 %(AI in SE.pdf, page 6).");
  });

  it("lists only the document pages an answer cites, and web links always", () => {
    const sources = [doc("page 6"), doc("page 9"), doc("page 2"), doc("page 14"), web];
    expect(citedSources(sources, "22%【AI in SE.pdf, page 6】")).toEqual([doc("page 6"), web]);
    expect(citedSources(sources, "See (AI in SE.pdf, pages 2 and 14).")).toEqual([doc("page 2"), doc("page 14"), web]);
    expect(citedSources(sources, "The document (AI in SE.pdf) does not mention Kubernetes.")).toEqual([web]);
    // With several documents a bare page number isn't enough: the document must be named.
    const two = [doc("page 3", "Handbook.pdf"), doc("page 3", "Pricing.pdf")];
    expect(citedSources(two, "As stated (Pricing.pdf, page 3).")).toEqual([doc("page 3", "Pricing.pdf")]);
    expect(citedSources(two, "As stated (page 3).")).toEqual([]);
    expect(citedSources([doc("section “Annual leave”", "Handbook.docx")], "(Handbook.docx, section “Annual leave”)")).toHaveLength(1);
  });
});

describe("SseParser", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    const parser = new SseParser();
    const input = 'event: delta\ndata: {"a":1}\n\n: comment\r\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
    const events = [];
    for (let i = 0; i < input.length; i += 3) events.push(...parser.feed(input.slice(i, i + 3)));
    events.push(...parser.flush());
    expect(events).toEqual([
      { event: "delta", data: '{"a":1}' },
      { event: "message", data: "line1\nline2" },
      { event: "message", data: "[DONE]" },
    ]);
  });

  it("dispatches a trailing event without a final blank line on flush", () => {
    const parser = new SseParser();
    expect(parser.feed("data: tail")).toEqual([]);
    expect(parser.flush()).toEqual([{ event: "message", data: "tail" }]);
  });
});

describe("parseOpenAiChunk", () => {
  it("extracts content, reasoning and usage", () => {
    const chunks = [
      ...parseOpenAiChunk({ choices: [{ delta: { reasoning: "think", content: "Hi" } }] }),
      ...parseOpenAiChunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    ];
    expect(chunks).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "Hi" },
      { type: "usage", inputTokens: 5, outputTokens: 7 },
    ]);
  });
});

describe("error classification", () => {
  it("separates rate limits, daily quotas and oversized requests", () => {
    expect(classifyHttpError("X", 429, '{"error":{"message":"Rate limit reached for requests"}}', "12").kind).toBe("rate_limit");
    expect(classifyHttpError("X", 429, '{"error":{"message":"Rate limit reached for requests"}}', "12").options.retryAfterMs).toBe(12_000);
    expect(classifyHttpError("X", 429, '[{"error":{"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}]', null).kind).toBe("quota");
    expect(classifyHttpError("X", 413, "Request too large", null).kind).toBe("too_large");
    expect(classifyHttpError("X", 429, '{"error":{"message":"Request too large for model. Limit 8000"}}', null).kind).toBe("too_large");
    expect(classifyHttpError("X", 402, '{"error":{"message":"Insufficient credits"}}', null).kind).toBe("quota");
    expect(classifyHttpError("X", 401, "{}", null).kind).toBe("auth");
    expect(classifyHttpError("X", 404, "{}", null).kind).toBe("not_found");
    expect(classifyHttpError("X", 503, "overloaded", null).kind).toBe("unavailable");
    expect(classifyHttpError("X", 503, "overloaded", null).retryable).toBe(true);
  });

  it("parses Retry-After in seconds and HTTP-date form", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("treats Workers AI neuron exhaustion as a quota that resets at UTC midnight", () => {
    const error = classifyWorkersAiError(new Error("4006: you have used up your daily free allocation of 10,000 neurons"));
    expect(error.kind).toBe("quota");
    expect(error.options.retryAfterMs).toBeGreaterThan(0);
    expect(msUntilUtcMidnight(Date.UTC(2026, 0, 1, 23, 0, 0))).toBe(60 * 60 * 1000);
  });

  it("chooses sensible cooldowns", () => {
    expect(cooldownFor(new ProviderError("rate_limit", "x", { retryAfterMs: 1_000 }))).toBe(5_000);
    expect(cooldownFor(new ProviderError("rate_limit", "x"))).toBe(60_000);
    expect(cooldownFor(new ProviderError("too_large", "x"))).toBeNull();
    expect(cooldownFor(new ProviderError("auth", "x"))).toBe(15 * 60_000);
  });
});

describe("selection parsing and config", () => {
  it("keeps colons inside model ids", () => {
    expect(parseSelection("openrouter:meta/llama:free")).toEqual({ provider: "openrouter", model: "meta/llama:free" });
    expect(parseSelection("auto")).toBeNull();
    expect(parseSelection("groq:")).toBeNull();
  });

  it("parses provider order, ignoring unknown and duplicate names", () => {
    expect(parseProviderOrder("gemini, groq,unknown,gemini")).toEqual(["gemini", "groq"]);
    expect(parseProviderOrder("")).toEqual(["groq", "gemini", "openrouter", "mistral", "workers-ai"]);
  });

  it("falls back to default settings for corrupt or partial data", () => {
    expect(parseSettings("not json").defaultModel).toBe("auto");
    expect(parseSettings('{"systemPrompt":"Be brief"}').systemPrompt).toBe("Be brief");
    expect(parseSettings('{"ollamaUrl":"javascript:alert(1)"}').ollamaUrl).toBe("http://localhost:11434");
  });

  it("prefers strong OpenRouter free models", () => {
    expect(
      pickOpenRouterDefault([
        { id: "tiny/model:free", label: "a", contextLength: 999_999 },
        { id: "qwen/qwen3-x:free", label: "b", contextLength: 32_000 },
      ]),
    ).toBe("qwen/qwen3-x:free");
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line, shortened at a word boundary", () => {
    expect(deriveTitle("\n\n  Hello   world \nsecond")).toBe("Hello world");
    const long = deriveTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
    expect(deriveTitle("   ")).toBe("New chat");
  });
});

describe("buildContext", () => {
  const msg = (role: "user" | "assistant", content: string, status: MessageDto["status"] = "complete"): MessageDto => ({
    id: crypto.randomUUID(),
    role,
    content,
    reasoning: null,
    provider: null,
    model: null,
    status,
    error: null,
    tools: null,
    createdAt: 0,
  });

  it("keeps the newest messages that fit and drops a leading assistant turn", () => {
    const history = [msg("user", "a".repeat(50)), msg("assistant", "b".repeat(50)), msg("user", "c".repeat(10))];
    const context = buildContext("sys", history, 3 + 50 + 10 + 5);
    expect(context.map((m) => m.role)).toEqual(["system", "user"]);
    expect(context[1]!.content).toBe("c".repeat(10));
  });

  it("skips failed replies and merges consecutive user messages", () => {
    const history = [msg("user", "first"), msg("assistant", "", "error"), msg("user", "second")];
    const context = buildContext("sys", history, 10_000);
    expect(context).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "first\n\nsecond" },
    ]);
  });

  it("truncates a single oversized newest message instead of dropping it", () => {
    const context = buildContext("sys", [msg("user", "x".repeat(5_000))], 2_000);
    expect(context[1]!.content.length).toBeLessThan(5_000);
    expect(context[1]!.content).toContain("truncated");
  });
});

describe("worker entry module", () => {
  it("exports only the default handler (the Workers runtime rejects other named exports)", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof entry.default.fetch).toBe("function");
    expect(typeof entry.default.scheduled).toBe("function");
  });
});

describe("normalizeMath", () => {
  it("converts \\[ \\] and \\( \\) delimiters to $$ and leaves currency alone", () => {
    const input = "First:\n\\[ 2{,}340 \\times 0.175 = 409.5 \\]\nSo \\(x = 2\\) and it costs $409.50 or $470.93.";
    const out = normalizeMath(input);
    expect(out).toContain("\n$$\n2{,}340 \\times 0.175 = 409.5\n$$\n");
    expect(out).toContain("$$x = 2$$");
    expect(out).toContain("$409.50 or $470.93");
  });

  it("does not touch code", () => {
    const input = "Regex: `\\[a-z\\]` and\n```js\nconst r = /\\(x\\)/;\n```\n";
    expect(normalizeMath(input)).toBe(input);
  });
});

describe("knowledge chunking", () => {
  it("packs lines into passages that never cross pages, with a small overlap", async () => {
    const { chunkUnits } = await import("../src/shared/chunking");
    const page = Array.from({ length: 40 }, (_, i) => `Line ${i} of the page has some words in it to fill space.`).join("\n");
    const chunks = chunkUnits([{ location: "page 1", text: page }, { location: "page 2", text: "Short page." }]);
    expect(chunks.map((c) => [c.seq, c.location])).toEqual([[0, "page 1"], [1, "page 1"], [2, "page 2"]]);
    expect(chunks[1]!.text).toContain(chunks[0]!.text.split("\n").pop()!);
    const long = chunkUnits([{ location: "", text: "x".repeat(5_000) }]);
    expect(long.every((c) => c.text.length <= 1_800)).toBe(true);
    expect(long.reduce((n, c) => n + c.text.length, 0)).toBe(5_000);
  });

  it("cuts Markdown into sections and CSV into row blocks that repeat the header", async () => {
    const { csvRecords, csvUnits, markdownUnits } = await import("../src/shared/chunking");
    expect(markdownUnits("Intro\n# Leave\nText\n## Pay *rates*\nMore").map((u) => u.location)).toEqual(["", "section “Leave”", "section “Pay rates”"]);
    expect(csvRecords('a,b\n"x\ny",z\r\n')).toEqual(["a,b", '"x\ny",z']);
    const units = csvUnits("name,city\n" + Array.from({ length: 100 }, (_, i) => `"Person, ${i}",City ${i}`).join("\n"));
    expect(units.length).toBeGreaterThan(1);
    expect(units.every((u) => u.text.startsWith("name,city\n"))).toBe(true);
    expect(units[0]!.location).toMatch(/^rows 2–\d+$/);
    expect(units[units.length - 1]!.location).toMatch(/–101$/);
  });
});
