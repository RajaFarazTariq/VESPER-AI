import { AUTO_MODEL, PROVIDER_IDS, type ProviderId } from "../../shared/types";
import type { ProviderHealth, ProviderStateStore } from "../db/provider-state";
import {
  flattenToolMessages,
  hasForeignToolCalls,
  ProviderError,
  toProviderError,
  type ChatMessage,
  type Provider,
  type ProviderErrorKind,
  type ToolCall,
  type ToolSpec,
} from "./types";

export interface RouteTarget {
  provider: ProviderId;
  model: string;
}

export interface RouteError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Callbacks may be async; the router awaits them so a slow client applies backpressure. */
export interface RouterEvents {
  attempt(target: RouteTarget): void | Promise<void>;
  fallback(from: RouteTarget, reason: string): void | Promise<void>;
  text(text: string): void | Promise<void>;
  reasoning(text: string): void | Promise<void>;
}

export interface RouteResult {
  status: "complete" | "partial" | "error" | "aborted";
  target: RouteTarget | null;
  text: string;
  reasoning: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Tool calls requested by the model (only when tools were offered). */
  toolCalls: ToolCall[];
  error: RouteError | null;
}

const RETRYABLE_KINDS: ProviderErrorKind[] = ["rate_limit", "quota", "unavailable", "timeout", "network"];
const MAX_RETRIES_PER_PROVIDER = 1;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** How long to skip a provider after a given failure (null = don't cool down). */
export function cooldownFor(error: ProviderError): number | null {
  const retryAfter = error.options.retryAfterMs;
  switch (error.kind) {
    case "rate_limit":
      return clamp(retryAfter ?? MINUTE, 5 * SECOND, 60 * MINUTE);
    case "quota":
      return clamp(retryAfter ?? 60 * MINUTE, MINUTE, 24 * 60 * MINUTE);
    case "auth":
      return 15 * MINUTE;
    case "not_found":
      return 10 * MINUTE;
    case "unavailable":
    case "timeout":
    case "network":
      return 30 * SECOND;
    default:
      return null;
  }
}

export function describeError(error: ProviderError): string {
  switch (error.kind) {
    case "rate_limit":
      return "rate limit reached";
    case "quota":
      return "free quota used up";
    case "too_large":
      return "conversation too long for this provider's free limits";
    case "auth":
      return "API key rejected";
    case "not_found":
      return "model not available";
    case "bad_request":
      return "request rejected";
    case "unavailable":
      return "service unavailable";
    case "timeout":
      return "timed out";
    case "network":
      return "network error";
    case "aborted":
      return "stopped";
  }
}

export type PlanResult = { ok: true; plan: RouteTarget[] } | { ok: false; error: RouteError };

/** Parse "provider:model". The model part may itself contain ':' (e.g. "openrouter:x/y:free"). */
export function parseSelection(selection: string): { provider: string; model: string } | null {
  const index = selection.indexOf(":");
  if (index <= 0 || index === selection.length - 1) return null;
  return { provider: selection.slice(0, index), model: selection.slice(index + 1) };
}

async function autoPlan(
  providers: Map<ProviderId, Provider>,
  order: ProviderId[],
  health: Map<ProviderId, ProviderHealth>,
  now: number,
  exclude?: ProviderId,
): Promise<RouteTarget[]> {
  const configured = order
    .map((id) => providers.get(id))
    .filter((p): p is Provider => Boolean(p && p.isConfigured() && p.id !== exclude));
  const ready = configured.filter((p) => (health.get(p.id)?.cooldownUntil ?? 0) <= now);
  // If everything is cooling down, still try them (soonest first) rather than failing outright.
  const candidates =
    ready.length > 0
      ? ready
      : [...configured].sort((a, b) => (health.get(a.id)?.cooldownUntil ?? 0) - (health.get(b.id)?.cooldownUntil ?? 0));
  const plan: RouteTarget[] = [];
  for (const provider of candidates) {
    try {
      plan.push({ provider: provider.id, model: await provider.defaultModel() });
    } catch {
      // provider has no usable default model right now; skip it
    }
  }
  return plan;
}

export async function planRoute(input: {
  selection: string;
  providers: Map<ProviderId, Provider>;
  order: ProviderId[];
  health: Map<ProviderId, ProviderHealth>;
  fallback: boolean;
  now?: number;
}): Promise<PlanResult> {
  const now = input.now ?? Date.now();
  if (input.selection === AUTO_MODEL) {
    const plan = await autoPlan(input.providers, input.order, input.health, now);
    if (plan.length === 0) {
      return {
        ok: false,
        error: {
          code: "no_providers",
          message: "No AI provider is configured. Add at least one free API key (see the README), or enable Workers AI.",
          retryable: false,
        },
      };
    }
    return { ok: true, plan };
  }

  const parsed = parseSelection(input.selection);
  if (!parsed) {
    return { ok: false, error: { code: "invalid_model", message: "Unknown model selection.", retryable: false } };
  }
  if (parsed.provider === "ollama") {
    return {
      ok: false,
      error: { code: "local_model", message: "Local (Ollama) models run in your browser, not on the server.", retryable: false },
    };
  }
  if (!(PROVIDER_IDS as readonly string[]).includes(parsed.provider)) {
    return { ok: false, error: { code: "invalid_model", message: `Unknown provider "${parsed.provider}".`, retryable: false } };
  }
  const provider = input.providers.get(parsed.provider as ProviderId);
  if (!provider || !provider.isConfigured()) {
    return {
      ok: false,
      error: {
        code: "provider_not_configured",
        message: `${provider?.label ?? parsed.provider} is not configured on the server. Add its API key or choose another model.`,
        retryable: false,
      },
    };
  }
  if (!provider.isAllowedModel(parsed.model)) {
    return {
      ok: false,
      error: { code: "invalid_model", message: `Model "${parsed.model}" is not allowed for ${provider.label}.`, retryable: false },
    };
  }
  const plan: RouteTarget[] = [{ provider: provider.id, model: parsed.model }];
  if (input.fallback) plan.push(...(await autoPlan(input.providers, input.order, input.health, now, provider.id)));
  return { ok: true, plan };
}

export async function executeRoute(input: {
  plan: RouteTarget[];
  providers: Map<ProviderId, Provider>;
  messages: ChatMessage[];
  maxTokens: number;
  signal: AbortSignal;
  store: ProviderStateStore;
  health: Map<ProviderId, ProviderHealth>;
  events: RouterEvents;
  tools?: ToolSpec[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<RouteResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const failures: { target: RouteTarget; error: ProviderError }[] = [];
  const result: RouteResult = {
    status: "error",
    target: null,
    text: "",
    reasoning: "",
    usage: { inputTokens: null, outputTokens: null },
    toolCalls: [],
    error: null,
  };

  for (const [index, target] of input.plan.entries()) {
    const provider = input.providers.get(target.provider);
    if (!provider) continue;
    if (index > 0) {
      const previous = failures[failures.length - 1];
      await input.events.fallback(
        previous?.target ?? input.plan[index - 1]!,
        previous ? describeError(previous.error) : "unavailable",
      );
    }
    await input.events.attempt(target);
    result.target = target;

    let lastError: ProviderError | null = null;
    let useTools = Boolean(input.tools?.length) && provider.supportsTools;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      let produced = false;
      try {
        // Tool history from another provider (or for a provider without tools) is sent as a plain note.
        const native = useTools && !hasForeignToolCalls(input.messages, provider.id);
        const stream = await provider.stream({
          model: target.model,
          messages: native ? input.messages : flattenToolMessages(input.messages),
          maxTokens: input.maxTokens,
          signal: input.signal,
          ...(useTools ? { tools: input.tools } : {}),
        });
        for await (const chunk of stream) {
          if (chunk.type === "tool_calls") {
            produced = true;
            result.toolCalls.push(...chunk.calls.map((c) => ({ ...c, origin: target.provider })));
          } else if (chunk.type === "text") {
            produced = true;
            result.text += chunk.text;
            await input.events.text(chunk.text);
          } else if (chunk.type === "reasoning") {
            produced = true;
            result.reasoning += chunk.text;
            await input.events.reasoning(chunk.text);
          } else {
            result.usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
          }
        }
        if (!result.text.trim() && result.toolCalls.length === 0 && !input.signal.aborted) {
          throw new ProviderError("unavailable", `${provider.label}: returned an empty response`);
        }
        await input.store.recordUsage(target.provider, { ok: true, ...result.usage }).catch(() => {});
        if ((input.health.get(target.provider)?.cooldownUntil ?? 0) > 0) {
          await input.store.clearCooldown(target.provider).catch(() => {});
        }
        result.status = "complete";
        result.error = null;
        return result;
      } catch (raw) {
        const error = toProviderError(raw, provider.label);
        if (input.signal.aborted || error.kind === "aborted") {
          result.status = result.text ? "partial" : "aborted";
          result.error = { code: "aborted", message: "Generation stopped.", retryable: true };
          return result;
        }
        await input.store.recordUsage(target.provider, { ok: false }).catch(() => {});
        if (produced) {
          // The answer already started streaming; switching providers now would garble it.
          result.status = "partial";
          result.error = { code: error.kind, message: `${error.message} (response was cut off)`, retryable: true };
          return result;
        }
        lastError = error;
        // Some models (e.g. certain free OpenRouter ones) reject function calling: retry once as plain chat.
        if (useTools && (error.kind === "bad_request" || error.kind === "not_found") && /tool|function/i.test(error.message)) {
          useTools = false;
          attempt--;
          continue;
        }
        if (error.retryable && attempt < MAX_RETRIES_PER_PROVIDER) {
          await sleep(600 + Math.floor(Math.random() * 400));
          continue;
        }
        break;
      }
    }

    if (lastError) {
      failures.push({ target, error: lastError });
      const cooldown = cooldownFor(lastError);
      if (cooldown !== null) {
        await input.store.setCooldown(target.provider, Date.now() + cooldown, lastError.message).catch(() => {});
      }
      console.warn(
        JSON.stringify({ msg: "provider attempt failed", provider: target.provider, model: target.model, kind: lastError.kind, error: lastError.message }),
      );
    }
  }

  result.status = "error";
  result.target = failures[failures.length - 1]?.target ?? null;
  if (failures.length === 1) {
    const only = failures[0]!.error;
    result.error = { code: only.kind, message: only.message, retryable: RETRYABLE_KINDS.includes(only.kind) };
  } else {
    result.error = {
      code: "all_providers_failed",
      message:
        "Every available free provider failed: " +
        failures.map((f) => `${f.target.provider} (${describeError(f.error)})`).join(", ") +
        ". Free limits usually reset within minutes (rate limits) or by the next day (daily quotas).",
      retryable: failures.some((f) => RETRYABLE_KINDS.includes(f.error.kind)),
    };
  }
  return result;
}
