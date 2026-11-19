/**
 * Speech to text for the microphone button: Groq's free Whisper first, Cloudflare Workers AI Whisper as the backup.
 *
 * Free limits (checked 2026-11-19): Groq whisper-large-v3-turbo allows 20 requests/min, 2,000/day and
 * 28,800 audio seconds/day (8 hours, shared by the whole app; each request counts as at least 10 s).
 * Workers AI Whisper uses the shared 10,000 free neurons/day (~46 neurons per audio minute). Neither ever bills.
 * The recording is sent once to transcribe it and is never stored.
 */
import { getConfig, type Env } from "../env";

/** The browser stops recording after this long. */
export const MAX_RECORDING_SECONDS = 120;
/** ~1 MB of compressed audio as base64: comfortably more than 2 minutes of browser speech recording. */
export const MAX_AUDIO_BASE64_CHARS = 1_400_000;
export const TRANSCRIBE_BODY_LIMIT = 1_500_000;

const GROQ_STT_MODEL = "whisper-large-v3-turbo";
const WORKERS_AI_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TIMEOUT_MS = 30_000;

export type SpeechService = "groq" | "workers-ai";

export interface SpeechResult {
  text: string;
  /** Length of the audio as the service measured it (null when it didn't say). */
  seconds: number | null;
  service: SpeechService;
}

export class SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechError";
  }
}

/** Is any speech-to-text service set up? */
export function speechAvailable(env: Env): boolean {
  return Boolean(env.GROQ_API_KEY) || (getConfig(env).workersAiEnabled && Boolean(env.AI));
}

/** "audio/webm;codecs=opus" → "webm" (Groq looks at the file name). */
function extensionFor(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type === "audio/mp4" || type === "audio/x-m4a" || type === "audio/aac") return "m4a";
  if (type === "audio/mpeg") return "mp3";
  return type.split("/")[1] ?? "webm";
}

async function groqTranscribe(env: Env, audio: Uint8Array, mimeType: string, language: string | undefined): Promise<SpeechResult> {
  const form = new FormData();
  form.append("file", new File([audio], `speech.${extensionFor(mimeType)}`, { type: mimeType.split(";")[0]! }));
  form.append("model", GROQ_STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  const base = (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new SpeechError(`Groq speech to text: HTTP ${response.status} ${detail}`);
  }
  const json = (await response.json()) as { text?: unknown; duration?: unknown };
  if (typeof json.text !== "string") throw new SpeechError("Groq speech to text: no text in the reply");
  return { text: json.text, seconds: typeof json.duration === "number" ? json.duration : null, service: "groq" };
}

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

async function workersAiTranscribe(env: Env, base64: string, language: string | undefined): Promise<SpeechResult> {
  const result = (await (env.AI as unknown as AiRunner).run(WORKERS_AI_STT_MODEL, {
    audio: base64,
    task: "transcribe",
    vad_filter: true,
    ...(language ? { language } : {}),
  })) as { text?: unknown; transcription_info?: { duration?: unknown } };
  if (typeof result?.text !== "string") throw new SpeechError("Workers AI speech to text: no text in the reply");
  const duration = result.transcription_info?.duration;
  return { text: result.text, seconds: typeof duration === "number" ? duration : null, service: "workers-ai" };
}

/** Turn a recording into text. Tries Groq, then Workers AI; throws SpeechError when both fail. */
export async function transcribe(
  env: Env,
  audio: { bytes: Uint8Array; base64: string; mimeType: string },
  language: "en" | "ur" | undefined,
): Promise<SpeechResult> {
  const failures: string[] = [];
  if (env.GROQ_API_KEY) {
    try {
      return await groqTranscribe(env, audio.bytes, audio.mimeType, language);
    } catch (error) {
      failures.push(String(error instanceof Error ? error.message : error));
    }
  }
  if (getConfig(env).workersAiEnabled && env.AI) {
    try {
      return await workersAiTranscribe(env, audio.base64, language);
    } catch (error) {
      failures.push(`Workers AI speech to text: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
    }
  }
  console.warn(JSON.stringify({ msg: "speech to text failed", failures }));
  throw new SpeechError(failures.length ? failures.join("; ") : "No speech-to-text service is set up.");
}
