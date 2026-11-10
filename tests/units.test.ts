import { describe, expect, it } from "vitest";
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
