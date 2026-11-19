import { z } from "zod";
import type { AppSettingsDto } from "../../shared/types";
import type { AppConfig } from "../env";

const HOST = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.WHO.int/news/x" → "who.int": the website part only (subdomains are matched too). */
export function cleanSite(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/** A list of websites, one per entry; blank entries and duplicates dropped, anything else must be a website address. */
const siteList = z
  .array(z.string().max(300))
  .max(100)
  .transform((list) => [...new Set(list.map(cleanSite).filter(Boolean))])
  .refine((list) => list.every((site) => HOST.test(site)), "Use website addresses like who.int (one per line).");

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
  trustedSites: siteList,
  blockedSites: siteList,
  imagesEnabled: z.boolean(),
  imagesPerDay: z.number().int().min(0).max(1_000),
  voiceEnabled: z.boolean(),
  speechMinutesPerDay: z.number().int().min(0).max(1_440),
  researchEnabled: z.boolean(),
  researchRunsPerDay: z.number().int().min(0).max(100),
  researchSearchReserve: z.number().int().min(0).max(1_000),
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
    trustedSites: [],
    blockedSites: [],
    imagesEnabled: true,
    imagesPerDay: 10,
    voiceEnabled: true,
    // Groq's free speech-to-text allows 8 hours a day for the whole app; 15 minutes each leaves room for many users.
    speechMinutesPerDay: 15,
    researchEnabled: true,
    researchRunsPerDay: 3,
    // With the default 30 searches a day, research can use 20 (about 5–10 runs for the whole app).
    researchSearchReserve: 10,
  };
}

const DAY_MS = 86_400_000;
/** The shared daily web-search counter (the web_search tool and deep research both use it). */
const SEARCH_COUNTER = "tool:web_search";
const today = (now = Date.now()) => Math.floor(now / DAY_MS) * DAY_MS;

/** Web searches already used today (UTC), from the shared counter the web_search tool increments. */
export async function webSearchesToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?1")
    .bind(SEARCH_COUNTER)
    .first<{ count: number; window_start: number }>();
  return row && row.window_start === today() ? row.count : 0;
}

/** Searches a research run has set aside (to give back what it didn't use). */
export interface SearchHold {
  granted: number;
  windowStart: number;
}

/**
 * Deep research sets its searches aside before it starts, so two runs at the same time can't both go over. Takes up
 * to `want` searches (at least `min`) from today's count, never touching the last `keep` searches of the daily cap
 * (those stay for normal chat). Returns granted 0 and what's available when there isn't enough; nothing is taken then.
 */
export async function holdResearchSearches(
  db: D1Database,
  options: { cap: number; keep: number; want: number; min: number },
): Promise<SearchHold & { available: number }> {
  const ceiling = options.cap - options.keep;
  for (let attempt = 0; attempt < 3; attempt++) {
    const windowStart = today();
    const available = Math.max(0, ceiling - (await webSearchesToday(db)));
    const granted = Math.min(options.want, available);
    if (granted < options.min) return { granted: 0, windowStart, available };
    // Atomic: only succeeds if the count still leaves room (another run may have taken searches meanwhile).
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start = ?2 THEN count + ?3 ELSE ?3 END,
           window_start = ?2
         WHERE (CASE WHEN window_start = ?2 THEN count ELSE 0 END) + ?3 <= ?4
         RETURNING count`,
      )
      .bind(SEARCH_COUNTER, windowStart, granted, ceiling)
      .first<{ count: number }>();
    if (row) return { granted, windowStart, available };
  }
  return { granted: 0, windowStart: today(), available: 0 };
}

/** Give back searches a run set aside but didn't use (only within the same day's count). */
export async function releaseResearchSearches(db: D1Database, hold: SearchHold, unused: number): Promise<void> {
  if (unused <= 0) return;
  await db
    .prepare("UPDATE rate_limits SET count = MAX(0, count - ?3) WHERE key = ?1 AND window_start = ?2")
    .bind(SEARCH_COUNTER, hold.windowStart, unused)
    .run();
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
