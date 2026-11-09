import type { ModelInfo, ProviderId } from "../../../shared/types";
import { fetchWithTimeout, readSse } from "../stream";
import {
  classifyHttpError,
  extractErrorMessage,
  ProviderError,
  type Provider,
  type ProviderRequest,
  type StreamChunk,
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
  private readonly baseUrl: string;
  private cachedModels: ModelInfo[] | null = null;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.freeTier = options.freeTier;
    this.notes = options.notes;
    this.signupUrl = options.signupUrl;
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
    const body = {
      model: request.model,
      messages: request.messages,
      stream: true,
      max_tokens: request.maxTokens,
      ...this.options.extraBody,
    };
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
    try {
      for await (const event of readSse(body, controller.signal, this.label)) {
        const data = event.data.trim();
        if (!data) continue;
        if (data === "[DONE]") return;
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
        yield* parseOpenAiChunk(json);
      }
    } finally {
      controller.abort();
      unlink();
    }
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
