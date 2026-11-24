import { Hono } from "hono";
import { z } from "zod";
import type { AppSettingsDto, FeaturesDto, TranscriptionDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { addSpeechSeconds, speechSecondsToday } from "../db/users";
import { getConfig, type Env } from "../env";
import { TABLE_LIMITS } from "../../shared/tables";
import { tablesAllowed } from "./files";
import { AppError, badRequest } from "../lib/errors";
import { MAX_IMAGES_PER_MESSAGE } from "../lib/images";
import { MAX_AUDIO_BASE64_CHARS, MAX_RECORDING_SECONDS, SpeechError, speechAvailable, TRANSCRIBE_BODY_LIMIT, transcribe } from "../lib/speech";
import { parseJson } from "../lib/validation";
import { getProviders } from "../llm/registry";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";

/** What the chat screen may offer: the admin's switches, and whether a service that can do it is set up. */
export function featuresFor(env: Env, settings: AppSettingsDto, admin: boolean): FeaturesDto {
  const providers = getProviders(env);
  const canSeeImages = (["gemini", "openrouter"] as const).some((id) => {
    const p = providers.get(id);
    return Boolean(p?.isConfigured() && p.imageModel);
  });
  return {
    images: { enabled: settings.imagesEnabled && canSeeImages, perDay: settings.imagesPerDay, maxPerMessage: MAX_IMAGES_PER_MESSAGE },
    voice: {
      enabled: settings.voiceEnabled,
      speechToText: settings.voiceEnabled && speechAvailable(env),
      minutesPerDay: settings.speechMinutesPerDay,
      maxRecordingSeconds: MAX_RECORDING_SECONDS,
    },
    research: {
      // Needs web search: a Tavily key, web_search not switched off for everyone, and a daily cap above the
      // searches kept for normal chat.
      enabled:
        settings.researchEnabled &&
        Boolean(env.TAVILY_API_KEY) &&
        !settings.disabledTools.includes("web_search") &&
        settings.webSearchDailyLimit > settings.researchSearchReserve,
      runsPerDay: settings.researchRunsPerDay,
    },
    localModels: admin || settings.localModelsForUsers,
    answerCheck: { enabled: settings.answerCheckEnabled, perDay: settings.answerChecksPerDay },
    github: { available: getConfig(env).githubAppEnabled && (admin || settings.githubForUsers) },
    githubActions: { available: getConfig(env).githubActionsAppEnabled && (admin || settings.githubActionsForUsers) },
    tables: {
      enabled: tablesAllowed(settings),
      perDay: settings.tablesPerDay,
      perChat: TABLE_LIMITS.perChat,
      maxRows: TABLE_LIMITS.rows,
      maxMegabytes: TABLE_LIMITS.fileBytes / (1024 * 1024),
    },
    google: { available: getConfig(env).googleConnectEnabled && (admin || settings.googleForUsers) },
  };
}

const transcribeSchema = z.object({
  /** The recording, base64-encoded. */
  audio: z.string().min(16).max(MAX_AUDIO_BASE64_CHARS, "The recording is too long.").regex(/^[A-Za-z0-9+/]+={0,2}$/, "Invalid audio data."),
  mimeType: z
    .string()
    .max(100)
    .regex(/^audio\/(webm|ogg|mp4|x-m4a|aac|mpeg|wav)(;\s*codecs=[\w.,"-]+)?$/i, "Unsupported audio format."),
  /** Length measured by the browser (the service's own measurement is used when it gives one). */
  seconds: z.number().min(0).max(3_600),
  /** Overrides the user's speech language setting for this recording. */
  language: z.enum(["auto", "en", "ur"]).optional(),
});

const voiceLimiter = rateLimit("voice", 12, 60_000, (c) => c.get("user").id);

const minutes = (seconds: number) => Math.max(0, Math.floor(seconds / 60));

export const mediaRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/features", async (c) =>
    c.json(featuresFor(c.env, await getAppSettings(c.env.DB, getConfig(c.env)), c.get("user").role === "admin")),
  )

  /** Microphone: speech → text. The text goes into the message box; nothing is sent to the chat. */
  .post("/transcribe", voiceLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, transcribeSchema, TRANSCRIBE_BODY_LIMIT);
    const settings = await getAppSettings(c.env.DB, getConfig(c.env));
    if (!settings.voiceEnabled) throw new AppError(403, "voice_off", "Voice input is switched off.");
    if (!speechAvailable(c.env)) throw new AppError(503, "voice_unavailable", "Speech to text isn't set up on the server.");

    // Admins are counted (usage view) but never limited, like messages.
    if (user.role !== "admin") {
      const limit = settings.speechMinutesPerDay * 60;
      const used = await speechSecondsToday(c.env.DB, user.id);
      const needed = Math.max(1, Math.min(body.seconds, MAX_RECORDING_SECONDS));
      if (limit <= 0) throw new AppError(429, "speech_limit", "Voice input is paused for your account. Please type your message.");
      if (used + needed > limit) {
        throw new AppError(
          429,
          "speech_limit",
          used >= limit
            ? `You've used all ${settings.speechMinutesPerDay} minutes of voice input for today. It resets at 00:00 UTC; you can still type.`
            : `This recording is longer than the voice time you have left today (about ${minutes(limit - used)} min). Try a shorter one, or type.`,
        );
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(body.audio), (ch) => ch.charCodeAt(0));
    } catch {
      throw badRequest("Invalid audio data.");
    }
    const preferred = body.language ?? user.settings.speechLanguage;
    const language = preferred === "auto" ? undefined : preferred;

    let result;
    try {
      result = await transcribe(c.env, { bytes, base64: body.audio, mimeType: body.mimeType }, language);
    } catch (error) {
      if (error instanceof SpeechError) {
        throw new AppError(503, "voice_failed", "Speech to text didn't work just now. Please try again, or type your message.");
      }
      throw error;
    }
    const seconds = Math.max(1, Math.ceil(result.seconds ?? body.seconds));
    await addSpeechSeconds(c.env.DB, user.id, seconds);
    const reply: TranscriptionDto & { service?: string } = {
      text: result.text.trim(),
      seconds,
      ...(user.role === "admin" ? { service: result.service } : {}),
    };
    return c.json(reply);
  });
