import type { ModelInfo, ProviderId } from "../../shared/types";
import { readModelCache, writeModelCache } from "../db/provider-state";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";
import type { Provider } from "./types";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Per-isolate cache so most requests never touch D1 or the provider. */
const memory = new Map<ProviderId, { models: ModelInfo[]; fetchedAt: number }>();

/**
 * Model list for a provider: memory -> D1 cache (6h) -> live /models call.
 * Never throws: on failure it returns stale data or just the default model.
 */
export async function getProviderModels(
  db: D1Database,
  provider: Provider,
  options: { refresh?: boolean } = {},
): Promise<ModelInfo[]> {
  const now = Date.now();
  if (!options.refresh) {
    const mem = memory.get(provider.id);
    if (mem && now - mem.fetchedAt < CACHE_TTL_MS) return prime(provider, mem.models);
    const stored = await readModelCache(db, provider.id).catch(() => null);
    if (stored && now - stored.fetchedAt < CACHE_TTL_MS && stored.models.length > 0) {
      memory.set(provider.id, stored);
      return prime(provider, stored.models);
    }
  }
  try {
    const models = await provider.fetchModels();
    if (models.length > 0) {
      memory.set(provider.id, { models, fetchedAt: now });
      await writeModelCache(db, provider.id, models).catch(() => {});
      return prime(provider, models);
    }
  } catch (error) {
    console.warn(JSON.stringify({ msg: "model list fetch failed", provider: provider.id, error: String(error) }));
  }
  const stale = memory.get(provider.id) ?? (await readModelCache(db, provider.id).catch(() => null));
  if (stale && stale.models.length > 0) return prime(provider, stale.models);
  try {
    const fallback = await provider.defaultModel();
    return [{ id: fallback, label: fallback }];
  } catch {
    return [];
  }
}

function prime(provider: Provider, models: ModelInfo[]): ModelInfo[] {
  if (provider instanceof OpenAiCompatibleProvider) provider.primeModels(models);
  return models;
}

/** Test helper. */
export function clearModelMemoryCache(): void {
  memory.clear();
}
