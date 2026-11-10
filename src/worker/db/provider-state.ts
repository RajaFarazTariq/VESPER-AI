import type { ModelInfo, ProviderId } from "../../shared/types";

export interface ProviderHealth {
  cooldownUntil: number;
  lastError: string | null;
}

/** Persistence used by the model router. An interface so tests can swap it out. */
export interface ProviderStateStore {
  getHealth(): Promise<Map<ProviderId, ProviderHealth>>;
  setCooldown(provider: ProviderId, until: number, error: string): Promise<void>;
  clearCooldown(provider: ProviderId): Promise<void>;
  recordUsage(
    provider: ProviderId,
    outcome: { ok: boolean; tokensIn?: number | null; tokensOut?: number | null },
  ): Promise<void>;
}

export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class D1ProviderStateStore implements ProviderStateStore {
  constructor(private readonly db: D1Database) {}

  async getHealth(): Promise<Map<ProviderId, ProviderHealth>> {
    const { results } = await this.db
      .prepare("SELECT provider, cooldown_until, last_error FROM provider_state")
      .all<{ provider: ProviderId; cooldown_until: number; last_error: string | null }>();
    return new Map(results.map((r) => [r.provider, { cooldownUntil: r.cooldown_until, lastError: r.last_error }]));
  }

  async setCooldown(provider: ProviderId, until: number, error: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_state (provider, cooldown_until, last_error, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider) DO UPDATE SET cooldown_until = excluded.cooldown_until,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .bind(provider, until, error.slice(0, 500), Date.now())
      .run();
  }

  async clearCooldown(provider: ProviderId): Promise<void> {
    await this.db
      .prepare("UPDATE provider_state SET cooldown_until = 0, updated_at = ?2 WHERE provider = ?1 AND cooldown_until > 0")
      .bind(provider, Date.now())
      .run();
  }

  async recordUsage(
    provider: ProviderId,
    outcome: { ok: boolean; tokensIn?: number | null; tokensOut?: number | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage_daily (day, provider, requests, failures, tokens_in, tokens_out) VALUES (?1, ?2, 1, ?3, ?4, ?5)
         ON CONFLICT(day, provider) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures,
           tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      )
      .bind(utcDay(), provider, outcome.ok ? 0 : 1, outcome.tokensIn ?? 0, outcome.tokensOut ?? 0)
      .run();
  }
}

export async function getTodayUsage(db: D1Database): Promise<Map<string, { requests: number; failures: number }>> {
  const { results } = await db
    .prepare("SELECT provider, requests, failures FROM usage_daily WHERE day = ?1")
    .bind(utcDay())
    .all<{ provider: string; requests: number; failures: number }>();
  return new Map(results.map((r) => [r.provider, { requests: r.requests, failures: r.failures }]));
}

export async function readModelCache(
  db: D1Database,
  provider: ProviderId,
): Promise<{ models: ModelInfo[]; fetchedAt: number } | null> {
  const row = await db
    .prepare("SELECT models, fetched_at FROM model_cache WHERE provider = ?1")
    .bind(provider)
    .first<{ models: string; fetched_at: number }>();
  if (!row) return null;
  try {
    return { models: JSON.parse(row.models) as ModelInfo[], fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

export async function writeModelCache(db: D1Database, provider: ProviderId, models: ModelInfo[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_cache (provider, models, fetched_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(provider) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at`,
    )
    .bind(provider, JSON.stringify(models), Date.now())
    .run();
}

/** Daily housekeeping, run from the cron trigger. */
export async function cleanup(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 24 * 60 * 60 * 1000),
    db.prepare("DELETE FROM usage_daily WHERE day < ?1").bind(utcDay(now - 90 * 24 * 60 * 60 * 1000)),
    db.prepare("DELETE FROM user_usage_daily WHERE day < ?1").bind(utcDay(now - 90 * 24 * 60 * 60 * 1000)),
  ]);
}
