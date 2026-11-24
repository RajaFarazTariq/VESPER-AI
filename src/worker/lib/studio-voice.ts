/**
 * VESPER Agent's studio voice (v0.17.1): text → MP3 with Cloudflare Workers AI (Deepgram Aura, a female speaker the
 * admin picks). The whole app shares a daily character cap, counted in `rate_limits` before each request and given back
 * when the request fails, so two people talking at once can't go over it.
 */
import type { StudioSpeaker } from "../../shared/types";
import { STUDIO_VOICE_MODEL } from "../../shared/voice";
import { getConfig, type Env } from "../env";

const DAY_MS = 86_400_000;
const COUNTER = "voice:studio_chars";
const today = (now = Date.now()) => Math.floor(now / DAY_MS) * DAY_MS;

/** Workers AI is bound and not switched off (it isn't in local development or tests unless they provide it). */
export const studioVoiceAvailable = (env: Env) => getConfig(env).workersAiEnabled && Boolean(env.AI);

/** Characters the studio voice has read today (UTC), for the whole app. */
export async function studioCharsToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?1")
    .bind(COUNTER)
    .first<{ count: number; window_start: number }>();
  return row && row.window_start === today() ? row.count : 0;
}

/** Count `chars` against today's cap. Atomic: false (nothing counted) when they don't fit. */
export async function consumeStudioChars(db: D1Database, chars: number, perDay: number): Promise<{ ok: boolean; day: number }> {
  const day = today();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + ?3 ELSE ?3 END,
         window_start = ?2
       WHERE (CASE WHEN window_start = ?2 THEN count ELSE 0 END) + ?3 <= ?4
       RETURNING count`,
    )
    .bind(COUNTER, day, chars, perDay)
    .first<{ count: number }>();
  return { ok: row !== null, day };
}

/** Give back characters of a request that failed (only within the same day's count). */
export async function refundStudioChars(db: D1Database, chars: number, day: number): Promise<void> {
  await db.prepare("UPDATE rate_limits SET count = MAX(0, count - ?3) WHERE key = ?1 AND window_start = ?2").bind(COUNTER, day, chars).run();
}

export class StudioVoiceError extends Error {}

/** The spoken text as MP3 bytes (a stream). Throws StudioVoiceError when Workers AI doesn't give audio. */
export async function synthesize(env: Env, text: string, speaker: StudioSpeaker): Promise<ReadableStream<Uint8Array>> {
  if (!env.AI) throw new StudioVoiceError("Workers AI isn't available.");
  const run = env.AI.run as unknown as (model: string, input: unknown) => Promise<unknown>;
  let result: unknown;
  try {
    result = await run.call(env.AI, STUDIO_VOICE_MODEL, { text, speaker });
  } catch (error) {
    throw new StudioVoiceError(error instanceof Error ? error.message : String(error));
  }
  // The binding returns the MP3 as a stream (older runtimes may hand back a Response or the bytes).
  if (result instanceof ReadableStream) return result as ReadableStream<Uint8Array>;
  if (result instanceof Response && result.ok && result.body) return result.body;
  if (result instanceof ArrayBuffer || result instanceof Uint8Array) return new Response(result).body!;
  throw new StudioVoiceError("Workers AI returned no audio.");
}
