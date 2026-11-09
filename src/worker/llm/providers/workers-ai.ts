import type { ModelInfo } from "../../../shared/types";
import { linkedController, readSse } from "../stream";
import { ProviderError, type Provider, type ProviderRequest, type StreamChunk } from "../types";
import { parseOpenAiChunk } from "./openai-compatible";

/**
 * Text-generation models confirmed on Cloudflare's Workers AI pricing page (Nov 2026).
 * Override with the WORKERS_AI_MODELS variable (comma-separated) when the catalogue changes.
 */
export const WORKERS_AI_DEFAULT_MODELS: ModelInfo[] = [
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B" },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B A3B" },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B (fast)" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B" },
  { id: "@cf/openai/gpt-oss-20b", label: "gpt-oss 20B" },
];

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Cloudflare Workers AI through the `AI` binding: no API key, 10,000 free neurons per day. */
export class WorkersAiProvider implements Provider {
  readonly id = "workers-ai" as const;
  readonly label = "Cloudflare Workers AI";
  readonly freeTier = "10,000 neurons/day on the Workers Free plan (resets 00:00 UTC). Requests fail, not bill, once used up.";
  readonly notes = [
    "Built in: no API key needed.",
    "Roughly a few hundred thousand output tokens/day on small models; large models use neurons much faster.",
  ];
  readonly signupUrl = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
  private readonly models: ModelInfo[];

  constructor(
    private readonly ai: Ai | undefined,
    private readonly enabled: boolean,
    private readonly preferredModel: string | undefined,
    modelOverride: string | undefined,
  ) {
    const custom = (modelOverride ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^@cf\/[\w.\-/]+$/.test(s));
    this.models = custom.length > 0 ? custom.map((id) => ({ id, label: id.split("/").pop() ?? id })) : WORKERS_AI_DEFAULT_MODELS;
  }

  isConfigured(): boolean {
    return this.enabled && Boolean(this.ai);
  }

  isAllowedModel(model: string): boolean {
    return /^@cf\/[\w.\-/]{1,150}$/.test(model);
  }

  async defaultModel(): Promise<string> {
    return this.preferredModel && this.isAllowedModel(this.preferredModel) ? this.preferredModel : this.models[0]!.id;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async stream(request: ProviderRequest): Promise<AsyncIterable<StreamChunk>> {
    if (!this.ai || !this.enabled) throw new ProviderError("auth", `${this.label}: binding not available`);
    if (!this.isAllowedModel(request.model)) {
      throw new ProviderError("bad_request", `${this.label}: model "${request.model}" is not allowed`);
    }
    let result: unknown;
    try {
      result = await (this.ai as unknown as AiRunner).run(request.model, {
        messages: request.messages,
        stream: true,
        max_tokens: request.maxTokens,
      });
    } catch (error) {
      throw classifyWorkersAiError(error);
    }
    if (!(result instanceof ReadableStream)) {
      throw new ProviderError("bad_request", `${this.label}: model did not return a stream`);
    }
    return this.iterate(result as ReadableStream<Uint8Array>, request.signal);
  }

  private async *iterate(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const { controller, unlink } = linkedController(signal);
    try {
      for await (const event of readSse(body, controller.signal, this.label)) {
        const data = event.data.trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (Array.isArray(json.choices)) {
          yield* parseOpenAiChunk(json);
          continue;
        }
        if (typeof json.response === "string" && json.response) yield { type: "text", text: json.response };
        const usage = json.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          yield {
            type: "usage",
            inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
            outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
          };
        }
      }
    } finally {
      unlink();
    }
  }
}

/** Seconds until the next 00:00 UTC, when the free neuron allowance resets. */
export function msUntilUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

export function classifyWorkersAiError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const text = `Cloudflare Workers AI: ${message.slice(0, 300)}`;
  if (/neurons|free allocation|daily|quota|4006/i.test(message)) {
    return new ProviderError("quota", text, { retryAfterMs: msUntilUtcMidnight() });
  }
  if (/rate limit|too many|3040|capacity/i.test(message)) return new ProviderError("rate_limit", text);
  if (/no such model|not found|5007/i.test(message)) return new ProviderError("not_found", text);
  if (/context|too long|too many tokens|token limit/i.test(message)) return new ProviderError("too_large", text);
  if (/auth|permission|10000/i.test(message)) return new ProviderError("auth", text);
  if (/invalid|bad input|5006/i.test(message)) return new ProviderError("bad_request", text);
  return new ProviderError("unavailable", text);
}
