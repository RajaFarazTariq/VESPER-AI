import { z } from "zod";
import type { AppSettingsDto } from "../../shared/types";
import type { AppConfig } from "../env";

/** Validation for each admin-managed setting (also used for the admin API). */
export const appSettingsSchema = z.object({
  signupsOpen: z.boolean(),
  defaultDailyLimit: z.number().int().min(0).max(100_000),
  botInstructions: z.string().max(4_000),
  disabledTools: z.array(z.string().trim().min(1).max(64)).max(50),
  showReasoningToUsers: z.boolean(),
  userModels: z
    .array(
      z.object({
        // "<provider>:<model id>" for one of the cloud providers (Auto and local models are always allowed).
        value: z
          .string()
          .trim()
          .max(250)
          .regex(/^(groq|gemini|openrouter|mistral|workers-ai):\S{1,240}$/, "Must be <provider>:<model id>"),
        label: z.string().trim().min(1).max(40),
      }),
    )
    .max(20)
    .refine((list) => new Set(list.map((m) => m.value)).size === list.length, "Each model can only be listed once"),
  webSearchDailyLimit: z.number().int().min(0).max(1_000),
});

type Key = keyof AppSettingsDto;
const KEYS = Object.keys(appSettingsSchema.shape) as Key[];

export function defaultAppSettings(config: AppConfig): AppSettingsDto {
  return {
    signupsOpen: true,
    defaultDailyLimit: config.defaultDailyLimit,
    botInstructions: "",
    disabledTools: [],
    showReasoningToUsers: false,
    userModels: [],
    // Tavily's free plan is 1,000 searches a month: 30 a day stays under it.
    webSearchDailyLimit: 30,
  };
}

/** Web searches already used today (UTC), from the shared counter the web_search tool increments. */
export async function webSearchesToday(db: D1Database): Promise<number> {
  const windowStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const row = await db
    .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?1")
    .bind("tool:web_search")
    .first<{ count: number; window_start: number }>();
  return row && row.window_start === windowStart ? row.count : 0;
}

/** Whether a regular user may use this model selection. Auto and local (browser-side) models are always allowed. */
export function userMayUseModel(settings: AppSettingsDto, selection: string): boolean {
  return selection === "auto" || selection.startsWith("ollama:") || settings.userModels.some((m) => m.value === selection);
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
