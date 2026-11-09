import type { ModelInfo, ProviderId } from "../../shared/types";
import { getConfig, type Env } from "../env";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";
import { WorkersAiProvider } from "./providers/workers-ai";
import type { Provider } from "./types";

const NON_CHAT_MODEL = /whisper|tts|orpheus|guard|embed|moderation|ocr|transcri|image|imagen|veo|audio|live|aqa|robotics|computer-use|playai/i;

/** Defaults chosen from each provider's documentation (Nov 2026). Override per provider with *_MODEL variables. */
export const DEFAULT_MODELS = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3.5-flash-lite",
  mistral: "mistral-small-latest",
} as const;

function contextOf(raw: Record<string, unknown>): number | undefined {
  for (const key of ["context_window", "context_length", "max_context_length", "inputTokenLimit"]) {
    const v = raw[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return undefined;
}

/** Prefer well-known strong free models on OpenRouter, then the biggest context window. */
export function pickOpenRouterDefault(models: ModelInfo[]): string | null {
  const preferences = [/deepseek/i, /qwen3/i, /llama-3\.3-70b/i, /gpt-oss/i, /gemma/i, /mistral/i];
  for (const pattern of preferences) {
    const match = models
      .filter((m) => pattern.test(m.id))
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))[0];
    if (match) return match.id;
  }
  return [...models].sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))[0]?.id ?? null;
}

export function createProviders(env: Env): Map<ProviderId, Provider> {
  const config = getConfig(env);
  const providers: Provider[] = [
    new OpenAiCompatibleProvider({
      id: "groq",
      label: "Groq",
      baseUrl: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      defaultModel: env.GROQ_MODEL?.trim() || DEFAULT_MODELS.groq,
      freeTier: "Free plan: about 30 requests/min, 1,000 requests/day and 8,000 tokens/min per model (varies by model).",
      notes: [
        "Very fast. Best default for everyday chat.",
        "Stay on the Free plan (no card on file) so usage can never be billed.",
        "Long prompts can exceed the 8K tokens/min limit; the app then falls back automatically.",
      ],
      signupUrl: "https://console.groq.com/keys",
      extraBody: { stream_options: { include_usage: true } },
      mapModel: (raw) => {
        const id = typeof raw.id === "string" ? raw.id : "";
        if (!id || NON_CHAT_MODEL.test(id) || raw.active === false) return null;
        const contextLength = contextOf(raw);
        return { id, label: id, ...(contextLength ? { contextLength } : {}) };
      },
    }),
    new OpenAiCompatibleProvider({
      id: "gemini",
      label: "Google Gemini",
      baseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      defaultModel: env.GEMINI_MODEL?.trim() || DEFAULT_MODELS.gemini,
      freeTier: "Free tier with per-project limits shown in AI Studio. Flash-Lite allows the most requests/day; Pro models are not free.",
      notes: [
        "Use a key from a Google Cloud project WITHOUT billing enabled; with billing on, usage is charged.",
        "On the free tier Google may use prompts to improve its products (human review possible). Avoid sensitive data.",
        "Very long context window, good for long conversations.",
      ],
      signupUrl: "https://aistudio.google.com/apikey",
      mapModel: (raw) => {
        const rawId = typeof raw.id === "string" ? raw.id : "";
        const id = rawId.replace(/^models\//, "");
        if (!id.startsWith("gemini") || NON_CHAT_MODEL.test(id)) return null;
        const contextLength = contextOf(raw);
        return { id, label: id, ...(contextLength ? { contextLength } : {}) };
      },
    }),
    new OpenAiCompatibleProvider({
      id: "openrouter",
      label: "OpenRouter (free models)",
      baseUrl: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      defaultModel: env.OPENROUTER_MODEL?.trim() || null,
      freeTier: "Only \":free\" models: 20 requests/min and 50 requests/day (1,000/day after a one-time $10 credit purchase).",
      notes: [
        "This app refuses any model whose id does not end in \":free\", so it can never spend credits.",
        "The free model line-up changes often; the list here is fetched live.",
        "Some free endpoints may log prompts depending on the upstream provider.",
      ],
      signupUrl: "https://openrouter.ai/settings/keys",
      extraHeaders: { "X-Title": config.appName },
      extraBody: { stream_options: { include_usage: true } },
      allowModel: (model) => model.endsWith(":free"),
      pickDefault: pickOpenRouterDefault,
      mapModel: (raw) => {
        const id = typeof raw.id === "string" ? raw.id : "";
        if (!id.endsWith(":free")) return null;
        const label = typeof raw.name === "string" ? raw.name : id;
        const contextLength = contextOf(raw);
        return { id, label, ...(contextLength ? { contextLength } : {}) };
      },
    }),
    new OpenAiCompatibleProvider({
      id: "mistral",
      label: "Mistral",
      baseUrl: env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
      apiKey: env.MISTRAL_API_KEY,
      defaultModel: env.MISTRAL_MODEL?.trim() || DEFAULT_MODELS.mistral,
      freeTier: "Free \"Experiment\" plan (phone verification, no card) with conservative rate limits.",
      notes: [
        "The free plan may use your prompts for model training.",
        "Strong for writing and translation in European languages.",
      ],
      signupUrl: "https://console.mistral.ai/api-keys",
      mapModel: (raw) => {
        const id = typeof raw.id === "string" ? raw.id : "";
        const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
        if (!id || NON_CHAT_MODEL.test(id) || caps.completion_chat === false) return null;
        const contextLength = contextOf(raw);
        return { id, label: id, ...(contextLength ? { contextLength } : {}) };
      },
    }),
    new WorkersAiProvider(env.AI, config.workersAiEnabled, env.WORKERS_AI_MODEL?.trim(), env.WORKERS_AI_MODELS),
  ];
  return new Map(providers.map((p) => [p.id, p]));
}

const providerCache = new WeakMap<Env, Map<ProviderId, Provider>>();

/** Providers are cheap to build but we reuse them per environment object (per isolate). */
export function getProviders(env: Env): Map<ProviderId, Provider> {
  let providers = providerCache.get(env);
  if (!providers) {
    providers = createProviders(env);
    providerCache.set(env, providers);
  }
  return providers;
}
