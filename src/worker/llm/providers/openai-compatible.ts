import type { ModelInfo, ProviderId } from "../../../shared/types";
import { fetchWithTimeout, readSse } from "../stream";
import {
  classifyHttpError,
  extractErrorMessage,
  ProviderError,
  type ChatMessage,
  type Provider,
  type ProviderRequest,
  type StreamChunk,
  type ToolCall,
} from "../types";

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  /** Model used for automatic routing; if null, picked from the live model list. */
  defaultModel: string | null;
  freeTier: string;
  notes: string[];
  signupUrl: string;
  extraHeaders?: Record<string, string>;
  /** Extra body fields (e.g. stream_options) the provider is known to accept. */
  extraBody?: Record<string, unknown>;
  /** Override how the model list is fetched (e.g. a public endpoint). */
  listModels?: () => Promise<ModelInfo[]>;
  /** Filter/label raw /models entries. Return null to drop an entry. */
  mapModel?: (raw: Record<string, unknown>) => ModelInfo | null;
  /** Restricts which model ids may be used at all (e.g. OpenRouter ":free" only). */
  allowModel?: (model: string) => boolean;
  /** Picks a default from the live list when `defaultModel` is null. */
  pickDefault?: (models: ModelInfo[]) => string | null;
  /** Function calling support (default true). */
  supportsTools?: boolean;
  /** Include `name` on tool-result messages (Mistral expects it; OpenAI-style APIs don't). */
  toolMessageName?: boolean;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;

/**
 * Groq, Gemini, OpenRouter and Mistral all expose OpenAI-compatible
 * /chat/completions (streaming) and /models endpoints, so one adapter covers them.
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly freeTier: string;
  readonly notes: string[];
  readonly signupUrl: string;
  readonly supportsTools: boolean;
  private readonly baseUrl: string;
  private cachedModels: ModelInfo[] | null = null;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.freeTier = options.freeTier;
    this.notes = options.notes;
    this.signupUrl = options.signupUrl;
    this.supportsTools = options.supportsTools ?? true;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  isAllowedModel(model: string): boolean {
    if (!MODEL_ID_PATTERN.test(model)) return false;
    return this.options.allowModel ? this.options.allowModel(model) : true;
  }

  /** Let the registry provide a cached list so defaultModel() doesn't refetch. */
  primeModels(models: ModelInfo[]): void {
    this.cachedModels = models;
  }

  async defaultModel(): Promise<string> {
    if (this.options.defaultModel) return this.options.defaultModel;
    const models = this.cachedModels ?? (await this.fetchModels());
    const picked = this.options.pickDefault?.(models) ?? models[0]?.id ?? null;
    if (!picked) throw new ProviderError("not_found", `${this.label}: no free models are currently available`);
    return picked;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey ?? ""}`,
      "Content-Type": "application/json",
      ...this.options.extraHeaders,
    };
  }

  async fetchModels(): Promise<ModelInfo[]> {
    if (this.options.listModels) return this.options.listModels();
    const { response, unlink } = await fetchWithTimeout(
      `${this.baseUrl}/models`,
      { headers: this.headers() },
      new AbortController().signal,
      this.label,
      15_000,
    );
    try {
      if (!response.ok) {
        throw classifyHttpError(this.label, response.status, await response.text(), response.headers.get("retry-after"));
      }
      const json = (await response.json()) as { data?: Record<string, unknown>[] };
      const items = Array.isArray(json.data) ? json.data : [];
      const mapped = items
        .map((raw) => (this.options.mapModel ? this.options.mapModel(raw) : defaultMapModel(raw)))
        .filter((m): m is ModelInfo => m !== null && this.isAllowedModel(m.id));
      return mapped.sort((a, b) => a.label.localeCompare(b.label));
    } finally {
      unlink();
    }
  }

  async stream(request: ProviderRequest): Promise<AsyncIterable<StreamChunk>> {
    if (!this.isConfigured()) throw new ProviderError("auth", `${this.label}: no API key configured`);
    if (!this.isAllowedModel(request.model)) {
      throw new ProviderError("bad_request", `${this.label}: model "${request.model}" is not allowed`);
    }
    const useTools = this.supportsTools && request.tools && request.tools.length > 0;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWireMessages(request.messages, Boolean(this.options.toolMessageName)),
      stream: true,
      max_tokens: request.maxTokens,
      ...this.options.extraBody,
    };
    if (useTools) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }
    const { response, controller, unlink } = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      request.signal,
      this.label,
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      unlink();
      throw classifyHttpError(this.label, response.status, text, response.headers.get("retry-after"));
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // Some providers answer errors with 200 + JSON instead of a stream.
      const text = await response.text();
      unlink();
      throw new ProviderError("bad_request", `${this.label}: ${extractErrorMessage(text)}`);
    }
    return this.iterate(response.body, controller, unlink);
  }

  private async *iterate(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    unlink: () => void,
  ): AsyncGenerator<StreamChunk> {
    const toolCalls = new ToolCallAccumulator();
    try {
      for await (const event of readSse(body, controller.signal, this.label)) {
        const data = event.data.trim();
        if (!data) continue;
        if (data === "[DONE]") break;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue; // ignore malformed keep-alive frames
        }
        if (json.error) {
          const err = json.error as Record<string, unknown>;
          const code = typeof err.code === "number" ? err.code : 502;
          throw classifyHttpError(this.label, code, JSON.stringify({ error: err }), null);
        }
        toolCalls.add(json);
        yield* parseOpenAiChunk(json);
      }
      const calls = toolCalls.finish();
      if (calls.length > 0) yield { type: "tool_calls", calls };
    } finally {
      controller.abort();
      unlink();
    }
  }
}

/** Serialize our message union into the OpenAI wire format. */
export function toWireMessages(messages: ChatMessage[], toolMessageName: boolean): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls.map((c) => ({
          ...(c.extra ?? {}),
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content, ...(toolMessageName ? { name: m.name } : {}) };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}

/**
 * Tool calls arrive in fragments (`delta.tool_calls[i]` with partial `arguments`).
 * Some providers send each call whole, some omit `index` or `id`; this handles all of them.
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; args: string; extra: Record<string, unknown> }>();

  add(json: Record<string, unknown>): void {
    const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
    const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : [];
    parts.forEach((part, position) => {
      const index = typeof part.index === "number" ? part.index : this.calls.size + position;
      const fn = (part.function ?? {}) as Record<string, unknown>;
      let entry = this.calls.get(index);
      if (!entry) {
        entry = { id: "", name: "", args: "", extra: {} };
        this.calls.set(index, entry);
      }
      if (typeof part.id === "string" && part.id) entry.id = part.id;
      if (typeof fn.name === "string" && fn.name) entry.name = entry.name || fn.name;
      if (typeof fn.arguments === "string") entry.args += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === "object") entry.args += JSON.stringify(fn.arguments);
      for (const [key, value] of Object.entries(part)) {
        if (!["index", "id", "type", "function"].includes(key)) entry.extra[key] = value;
      }
    });
  }

  finish(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([index, c]) => ({
        id: c.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
        name: c.name,
        arguments: c.args || "{}",
        ...(Object.keys(c.extra).length ? { extra: c.extra } : {}),
      }));
  }
}

/** Extract text / reasoning / usage from one OpenAI-style streaming chunk. */
export function* parseOpenAiChunk(json: Record<string, unknown>): Generator<StreamChunk> {
  const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
  const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
  const reasoning = delta.reasoning ?? delta.reasoning_content;
  if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
  if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
  const usage = json.usage as Record<string, unknown> | undefined | null;
  if (usage && typeof usage === "object") {
    yield {
      type: "usage",
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    };
  }
}

function defaultMapModel(raw: Record<string, unknown>): ModelInfo | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const contextLength =
    typeof raw.context_window === "number"
      ? raw.context_window
      : typeof raw.context_length === "number"
        ? raw.context_length
        : undefined;
  return { id, label: id, ...(contextLength ? { contextLength } : {}) };
}
