import { describe, expect, it } from "vitest";
import type { ModelInfo, ProviderId } from "../src/shared/types";
import type { ProviderHealth, ProviderStateStore } from "../src/worker/db/provider-state";
import { executeRoute, planRoute, type RouteTarget } from "../src/worker/llm/router";
import { ProviderError, type Provider, type ProviderRequest, type StreamChunk } from "../src/worker/llm/types";

type Behaviour =
  | { kind: "ok"; text: string[] }
  | { kind: "fail"; error: ProviderError }
  | { kind: "break-after"; text: string[]; error: ProviderError };

class FakeProvider implements Provider {
  readonly label: string;
  readonly freeTier = "";
  readonly notes: string[] = [];
  readonly signupUrl = "";
  readonly supportsTools = true;
  calls = 0;
  constructor(
    readonly id: ProviderId,
    private readonly behaviours: Behaviour[],
    private readonly configured = true,
  ) {
    this.label = id;
  }
  isConfigured() {
    return this.configured;
  }
  isAllowedModel(model: string) {
    return this.id !== "openrouter" || model.endsWith(":free");
  }
  async defaultModel() {
    return `${this.id}-default`;
  }
  async fetchModels(): Promise<ModelInfo[]> {
    return [];
  }
  async stream(_request: ProviderRequest): Promise<AsyncIterable<StreamChunk>> {
    const behaviour = this.behaviours[Math.min(this.calls, this.behaviours.length - 1)]!;
    this.calls++;
    if (behaviour.kind === "fail") throw behaviour.error;
    return (async function* () {
      for (const t of behaviour.text) yield { type: "text", text: t } as StreamChunk;
      if (behaviour.kind === "break-after") throw behaviour.error;
      yield { type: "usage", inputTokens: 3, outputTokens: 4 } as StreamChunk;
    })();
  }
}

class MemoryStore implements ProviderStateStore {
  cooldowns = new Map<ProviderId, number>();
  usage: { provider: ProviderId; ok: boolean }[] = [];
  async getHealth() {
    return new Map<ProviderId, ProviderHealth>([...this.cooldowns].map(([p, until]) => [p, { cooldownUntil: until, lastError: null }]));
  }
  async setCooldown(provider: ProviderId, until: number) {
    this.cooldowns.set(provider, until);
  }
  async clearCooldown(provider: ProviderId) {
    this.cooldowns.delete(provider);
  }
  async recordUsage(provider: ProviderId, outcome: { ok: boolean }) {
    this.usage.push({ provider, ok: outcome.ok });
  }
}

function setup(providers: FakeProvider[]) {
  const map = new Map<ProviderId, Provider>(providers.map((p) => [p.id, p]));
  const store = new MemoryStore();
  const events: string[] = [];
  const run = async (plan: RouteTarget[], signal = new AbortController().signal) =>
    executeRoute({
      plan,
      providers: map,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      signal,
      store,
      health: await store.getHealth(),
      sleep: async () => {},
      events: {
        attempt: (t) => void events.push(`attempt:${t.provider}`),
        fallback: (from, reason) => void events.push(`fallback:${from.provider}:${reason}`),
        text: (t) => void events.push(`text:${t}`),
        reasoning: () => {},
      },
    });
  return { map, store, events, run };
}

const order: ProviderId[] = ["groq", "gemini", "openrouter", "mistral", "workers-ai"];

describe("planRoute", () => {
  it("auto mode uses configured providers in order and skips ones cooling down", async () => {
    const { map } = setup([
      new FakeProvider("groq", []),
      new FakeProvider("gemini", []),
      new FakeProvider("mistral", [], false),
      new FakeProvider("openrouter", []),
    ]);
    const health = new Map<ProviderId, ProviderHealth>([["groq", { cooldownUntil: Date.now() + 60_000, lastError: null }]]);
    const result = await planRoute({ selection: "auto", providers: map, order, health, fallback: true });
    expect(result.ok && result.plan.map((t) => t.provider)).toEqual(["gemini", "openrouter"]);
  });

  it("still tries cooling providers when nothing else is left", async () => {
    const { map } = setup([new FakeProvider("groq", [])]);
    const health = new Map<ProviderId, ProviderHealth>([["groq", { cooldownUntil: Date.now() + 60_000, lastError: null }]]);
    const result = await planRoute({ selection: "auto", providers: map, order, health, fallback: true });
    expect(result.ok && result.plan.map((t) => t.provider)).toEqual(["groq"]);
  });

  it("manual selection comes first, then the auto chain without duplicates when fallback is on", async () => {
    const { map } = setup([new FakeProvider("groq", []), new FakeProvider("gemini", [])]);
    const on = await planRoute({ selection: "gemini:gemini-x", providers: map, order, health: new Map(), fallback: true });
    expect(on.ok && on.plan).toEqual([
      { provider: "gemini", model: "gemini-x" },
      { provider: "groq", model: "groq-default" },
    ]);
    const off = await planRoute({ selection: "gemini:gemini-x", providers: map, order, health: new Map(), fallback: false });
    expect(off.ok && off.plan).toEqual([{ provider: "gemini", model: "gemini-x" }]);
  });

  it("rejects paid OpenRouter models, unknown providers, unconfigured providers and Ollama", async () => {
    const { map } = setup([new FakeProvider("openrouter", []), new FakeProvider("mistral", [], false)]);
    const base = { providers: map, order, health: new Map(), fallback: true };
    const paid = await planRoute({ ...base, selection: "openrouter:openai/gpt-5" });
    expect(!paid.ok && paid.error.code).toBe("invalid_model");
    const unknown = await planRoute({ ...base, selection: "acme:model" });
    expect(!unknown.ok && unknown.error.code).toBe("invalid_model");
    const unconfigured = await planRoute({ ...base, selection: "mistral:mistral-small-latest" });
    expect(!unconfigured.ok && unconfigured.error.code).toBe("provider_not_configured");
    const local = await planRoute({ ...base, selection: "ollama:llama3" });
    expect(!local.ok && local.error.code).toBe("local_model");
  });

  it("reports a clear error when no provider is configured", async () => {
    const { map } = setup([new FakeProvider("groq", [], false)]);
    const result = await planRoute({ selection: "auto", providers: map, order, health: new Map(), fallback: true });
    expect(!result.ok && result.error.code).toBe("no_providers");
  });
});

describe("executeRoute", () => {
  it("falls back to the next provider on a rate limit and records a cooldown", async () => {
    const groq = new FakeProvider("groq", [{ kind: "fail", error: new ProviderError("rate_limit", "429", { retryAfterMs: 30_000 }) }]);
    const gemini = new FakeProvider("gemini", [{ kind: "ok", text: ["Hel", "lo"] }]);
    const { store, events, run } = setup([groq, gemini]);
    const result = await run([
      { provider: "groq", model: "g" },
      { provider: "gemini", model: "m" },
    ]);
    expect(result.status).toBe("complete");
    expect(result.text).toBe("Hello");
    expect(result.target).toEqual({ provider: "gemini", model: "m" });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(events).toEqual(["attempt:groq", "fallback:groq:rate limit reached", "attempt:gemini", "text:Hel", "text:lo"]);
    expect(store.cooldowns.get("groq")).toBeGreaterThan(Date.now() + 25_000);
    expect(groq.calls).toBe(1); // rate limits are not retried on the same provider
    expect(store.usage).toEqual([
      { provider: "groq", ok: false },
      { provider: "gemini", ok: true },
    ]);
  });

  it("retries a transient error once on the same provider before moving on", async () => {
    const groq = new FakeProvider("groq", [
      { kind: "fail", error: new ProviderError("unavailable", "503") },
      { kind: "ok", text: ["ok"] },
    ]);
    const { run } = setup([groq]);
    const result = await run([{ provider: "groq", model: "g" }]);
    expect(result.status).toBe("complete");
    expect(groq.calls).toBe(2);
  });

  it("does not switch providers once text has streamed; returns a partial result", async () => {
    const groq = new FakeProvider("groq", [{ kind: "break-after", text: ["Half"], error: new ProviderError("network", "reset") }]);
    const gemini = new FakeProvider("gemini", [{ kind: "ok", text: ["never"] }]);
    const { run } = setup([groq, gemini]);
    const result = await run([
      { provider: "groq", model: "g" },
      { provider: "gemini", model: "m" },
    ]);
    expect(result.status).toBe("partial");
    expect(result.text).toBe("Half");
    expect(gemini.calls).toBe(0);
  });

  it("summarises every failure when the whole chain fails", async () => {
    const { run } = setup([
      new FakeProvider("groq", [{ kind: "fail", error: new ProviderError("quota", "daily") }]),
      new FakeProvider("gemini", [{ kind: "fail", error: new ProviderError("auth", "bad key") }]),
    ]);
    const result = await run([
      { provider: "groq", model: "g" },
      { provider: "gemini", model: "m" },
    ]);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("all_providers_failed");
    expect(result.error?.message).toContain("groq (free quota used up)");
    expect(result.error?.message).toContain("gemini (API key rejected)");
    expect(result.error?.retryable).toBe(true);
  });

  it("treats an empty completion as a failure and falls back", async () => {
    const { run } = setup([
      new FakeProvider("groq", [{ kind: "ok", text: [] }]),
      new FakeProvider("gemini", [{ kind: "ok", text: ["answer"] }]),
    ]);
    const result = await run([
      { provider: "groq", model: "g" },
      { provider: "gemini", model: "m" },
    ]);
    expect(result.text).toBe("answer");
  });

  it("stops without saving anything when aborted before output", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run } = setup([new FakeProvider("groq", [{ kind: "fail", error: new ProviderError("aborted", "stop") }])]);
    const result = await run([{ provider: "groq", model: "g" }], controller.signal);
    expect(result.status).toBe("aborted");
  });
});
