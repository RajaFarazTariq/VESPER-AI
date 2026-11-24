/**
 * Studio voice for VESPER Agent (v0.17.1): a natural female voice from Cloudflare Workers AI (Deepgram Aura,
 * `@cf/deepgram/aura-1`), the same on every device. It is billed at about 1,364 of Workers AI's 10,000 free daily
 * Neurons per 1,000 characters (shared with everything else that uses Workers AI), so the whole app gets a daily
 * character cap the administrator sets; after it, and for text Aura can't read (Urdu), the device's own voice is used.
 */
import type { StudioSpeaker } from "./types";

export const STUDIO_VOICE_MODEL = "@cf/deepgram/aura-1";
/** Aura's female voices (Deepgram's own descriptions), in the order offered in the admin panel. */
export const STUDIO_SPEAKERS: readonly StudioSpeaker[] = ["luna", "asteria", "stella", "athena", "hera"];
/** Text in one request: one or two sentences, so the first one plays quickly and nothing is spent on unheard text. */
export const STUDIO_VOICE_MAX_CHARS = 600;
/** The most the admin can allow per day: about 10,000 Neurons, the whole free daily allowance. */
export const STUDIO_VOICE_MAX_CHARS_PER_DAY = 7_000;

/** "Luna" for the menus. */
export const speakerLabel = (speaker: StudioSpeaker) => speaker.charAt(0).toUpperCase() + speaker.slice(1);
