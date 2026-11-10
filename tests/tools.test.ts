import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ModelInfo, type ProviderId, type ToolEventDto } from "../src/shared/types";
import { addMemory, listMemories, MAX_MEMORIES } from "../src/worker/db/memories";
import type { ProviderHealth, ProviderStateStore } from "../src/worker/db/provider-state";
import { createUser } from "../src/worker/db/users";
import { runAgent } from "../src/worker/llm/agent";
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
import { ALL_TOOLS, enabledTools } from "../src/worker/tools/registry";

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
    expect(enabledTools({ ...DEFAULT_SETTINGS }).map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    expect(enabledTools({ ...DEFAULT_SETTINGS, toolsEnabled: false })).toEqual([]);
    expect(enabledTools({ ...DEFAULT_SETTINGS, disabledTools: ["calculator"] }).map((t) => t.name)).not.toContain("calculator");
    const noMemory = enabledTools({ ...DEFAULT_SETTINGS, memoryEnabled: false }).map((t) => t.name);
    expect(noMemory).toEqual(["calculator", "current_datetime"]);
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

async function agent(providers: ScriptedProvider[], options: { maxRounds?: number; userId?: string } = {}) {
  const map = new Map<ProviderId, Provider>(providers.map((p) => [p.id, p]));
  const toolEvents: ToolEventDto[] = [];
  const text: string[] = [];
  const result = await runAgent({
    plan: providers.map((p) => ({ provider: p.id, model: "m" })),
    providers: map,
    messages: [
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
    expect(groq.requests.map((r) => r.tools?.length ?? 0)).toEqual([4, 4, 0]);
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
