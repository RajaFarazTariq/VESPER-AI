import { z } from "zod";
import type { AppSettingsDto } from "../../shared/types";
import type { AppConfig } from "../env";

/** Validation for each admin-managed setting (also used for the admin API). */
export const appSettingsSchema = z.object({
  signupsOpen: z.boolean(),
  defaultDailyLimit: z.number().int().min(0).max(100_000),
  botInstructions: z.string().max(4_000),
  disabledTools: z.array(z.string().trim().min(1).max(64)).max(50),
});

type Key = keyof AppSettingsDto;
const KEYS = Object.keys(appSettingsSchema.shape) as Key[];

export function defaultAppSettings(config: AppConfig): AppSettingsDto {
  return { signupsOpen: true, defaultDailyLimit: config.defaultDailyLimit, botInstructions: "", disabledTools: [] };
}

/** Stored values override the defaults; anything missing or invalid falls back to the default. */
export async function getAppSettings(db: D1Database, config: AppConfig): Promise<AppSettingsDto> {
  const settings = defaultAppSettings(config);
  const { results } = await db.prepare("SELECT key, value FROM app_settings").all<{ key: string; value: string }>();
  for (const row of results) {
    if (!KEYS.includes(row.key as Key)) continue;
    const key = row.key as Key;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      continue;
    }
    const parsed = appSettingsSchema.shape[key].safeParse(value);
    if (parsed.success) (settings as Record<Key, unknown>)[key] = parsed.data;
  }
  return settings;
}

export async function updateAppSettings(
  db: D1Database,
  config: AppConfig,
  patch: Partial<AppSettingsDto>,
): Promise<AppSettingsDto> {
  const now = Date.now();
  const statements = Object.entries(patch)
    .filter(([key, value]) => KEYS.includes(key as Key) && value !== undefined)
    .map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(key, JSON.stringify(value), now),
    );
  if (statements.length > 0) await db.batch(statements);
  return getAppSettings(db, config);
}
