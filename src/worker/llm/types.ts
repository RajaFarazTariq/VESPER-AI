import type { ModelInfo, ProviderId } from "../../shared/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null };

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly freeTier: string;
  readonly notes: string[];
  readonly signupUrl: string;
  isConfigured(): boolean;
  /** The model used for automatic routing (may consult the model list). */
  defaultModel(): Promise<string>;
  /** Fetch the live list of usable free models from the provider. */
  fetchModels(): Promise<ModelInfo[]>;
  /** Validate a model id the user picked manually. */
  isAllowedModel(model: string): boolean;
  /**
   * Start a streaming completion. Must throw a ProviderError if the request fails
   * before any output is produced; may throw later if the stream breaks.
   */
  stream(request: ProviderRequest): Promise<AsyncIterable<StreamChunk>>;
}

export type ProviderErrorKind =
  | "rate_limit" // 429: too many requests right now
  | "quota" // daily/monthly free allowance used up (or provider asked for payment)
  | "too_large" // request exceeds the provider's per-request token limits
  | "auth" // bad or missing API key
  | "not_found" // unknown model
  | "bad_request"
  | "unavailable" // 5xx / overloaded
  | "timeout"
  | "network"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Worth retrying the same provider after a short pause? */
  get retryable(): boolean {
    return this.kind === "unavailable" || this.kind === "timeout" || this.kind === "network";
  }
}

const QUOTA_PATTERN =
  /quota|per[ -]day|daily|exhausted|insufficient|credits|billing|payment|neurons|free allocation|limit: 0|RESOURCE_EXHAUSTED/i;

/** Parse a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** Pull a human-readable message out of a provider's error body. */
export function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) candidates.push(...parsed);
    else candidates.push(parsed);
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === "string") return err;
      if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
        return (err as Record<string, string>).message!;
      }
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.detail === "string") return obj.detail;
    }
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300) || "No details";
}

/** Map an HTTP error response to a ProviderError. */
export function classifyHttpError(
  providerLabel: string,
  status: number,
  body: string,
  retryAfterHeader: string | null,
): ProviderError {
  const detail = extractErrorMessage(body).slice(0, 300);
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const msg = `${providerLabel}: ${detail}`;
  if (status === 413) return new ProviderError("too_large", msg, { status });
  if (status === 402) return new ProviderError("quota", msg, { status, retryAfterMs });
  if (status === 429) {
    if (/request too large|too many tokens requested|reduce your message size/i.test(detail)) {
      return new ProviderError("too_large", msg, { status });
    }
    return new ProviderError(QUOTA_PATTERN.test(detail) ? "quota" : "rate_limit", msg, { status, retryAfterMs });
  }
  if (status === 401 || status === 403) return new ProviderError("auth", msg, { status });
  if (status === 404) return new ProviderError("not_found", msg, { status });
  if (status === 400 || status === 422) {
    if (/context length|context_length|maximum context|too long|too many tokens/i.test(detail)) {
      return new ProviderError("too_large", msg, { status });
    }
    return new ProviderError("bad_request", msg, { status });
  }
  if (status === 408) return new ProviderError("timeout", msg, { status });
  return new ProviderError("unavailable", msg, { status, retryAfterMs });
}

export function toProviderError(error: unknown, providerLabel: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("aborted", `${providerLabel}: request aborted`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError("network", `${providerLabel}: ${message.slice(0, 300)}`);
}
