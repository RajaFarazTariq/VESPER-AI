/**
 * VESPER Agent (v0.17.0): the voice loop's logic that needs nothing from the page, so tests can check it (the worker
 * typecheck reads the tests and has no DOM types). The page side (microphone, loudness meter, speech) lives in
 * components/AgentMode.tsx.
 */

// ------------------------------------------------------------------ Greeting

/** "Good evening, Sara. VESPER is online. How can I help?" (morning / afternoon / evening by the local time). */
export function agentGreeting(firstName: string | null | undefined, now = new Date()): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
  const name = (firstName ?? "").trim().split(/\s+/)[0];
  return `${part}${name ? `, ${name}` : ""}. VESPER is online. How can I help?`;
}

// ------------------------------------------------------------------ Speaking while the reply streams

/** Sentence-ending marks (also the Urdu full stop and the Arabic question mark). */
const END = /[.!?…۔؟]/;
/** What may follow the marks before the space: closing quotes and brackets, Markdown emphasis. */
const CLOSERS = /["'”’)\]*_]/;
/** Words that end with a full stop without ending the sentence ("No." only before a number: see fullStopEnds). */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "approx", "fig"]);

/**
 * Whether the full stop at `at`, followed by a space, ends the sentence: not after "Dr.", "e.g.", "U.S.", "J. Smith"
 * or a list number ("1. Milk"). Two cases depend on what comes next: "No. 5" against "No. You're free", and "$3.50.
 * Want more?" (a decimal number, then a capital) against "v2.1. and". null: what comes next hasn't arrived yet.
 */
function fullStopEnds(text: string, start: number, at: number, after: number): boolean | null {
  const before = text.slice(start, at);
  if (/^\s*\d{1,3}$/.test(before)) return false;
  const word = (/(\S+)$/.exec(before)?.[1] ?? "").replace(/^[("'“‘*_]+/, "").toLowerCase();
  const next = /\S/.exec(text.slice(after))?.[0] ?? null;
  if (word === "no") return next === null ? null : !/\d/.test(next);
  if (/\d\.\d+$/.test(word)) return next === null ? null : /\p{Lu}/u.test(next);
  return !(ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word) || word.includes("."));
}

export interface SentenceSplit {
  /** Complete sentences, trimmed, in order. */
  sentences: string[];
  /** How many characters of the buffer they used (the rest waits for more text). */
  consumed: number;
}

/**
 * The complete sentences at the start of `buffer` (reply text that hasn't been spoken yet). A sentence ends at a
 * line break, or at . ! ? followed by a space; a mark at the very end waits, since more text may follow ("3." of
 * "3.5"). A code block is held back until it is closed. With `final` (the reply is done) the rest is a sentence too.
 */
export function nextSentences(buffer: string, final = false): SentenceSplit {
  const sentences: string[] = [];
  let start = 0;
  let inCode = false;
  const push = (end: number) => {
    const sentence = buffer.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  };
  const n = buffer.length;
  for (let i = 0; i < n; i++) {
    if (buffer.startsWith("```", i)) {
      inCode = !inCode;
      i += 2;
      continue;
    }
    if (inCode) continue;
    const ch = buffer[i]!;
    if (ch === "\n") {
      push(i + 1);
      continue;
    }
    if (!END.test(ch)) continue;
    let j = i + 1;
    while (j < n && (END.test(buffer[j]!) || CLOSERS.test(buffer[j]!))) j++;
    if (j >= n) break;
    if (/\s/.test(buffer[j]!)) {
      const ends = ch === "." ? fullStopEnds(buffer, start, i, j) : true;
      if (ends === null) break;
      if (ends) push(j);
    }
    i = j - 1;
  }
  if (final) push(n);
  return { sentences, consumed: start };
}

/** Long sentences in pieces of at most `max` characters (some browsers cut long utterances off), at a comma if possible. */
export function speechChunks(text: string, max = 220): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    cut = cut <= 0 ? max : cut + 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ------------------------------------------------------------------ The studio voice (v0.17.1): requests to make

export interface ChunkOptions {
  /** Nothing is playing or waiting: the first piece goes alone (and short), so the voice starts quickly. */
  starting: boolean;
  /** No more text is coming for now: the last, unfinished group goes too. */
  final: boolean;
  /** Sentences are joined up to about this many characters, so there are fewer requests. */
  target?: number;
  /** Never more than this in one request (the server's limit). */
  max?: number;
  /** The most for the first piece when starting. */
  firstMax?: number;
}

/**
 * Sentences waiting for the studio voice → the requests to make now, in order (`chunks`), and what waits for more
 * text (`rest`). Every chunk is at most `max` characters; a long sentence is cut at a comma or a space.
 */
export function takeChunks(sentences: readonly string[], { starting, final, target = 250, max = 600, firstMax = 200 }: ChunkOptions): { chunks: string[]; rest: string[] } {
  const pieces = sentences.flatMap((s) => speechChunks(s, max));
  const chunks: string[] = [];
  if (starting && pieces.length > 0) {
    const [head, ...tail] = speechChunks(pieces.shift()!, firstMax);
    chunks.push(head!);
    pieces.unshift(...tail);
  }
  let group = "";
  for (const piece of pieces) {
    if (!group) group = piece;
    else if (group.length + 1 + piece.length <= target) group = `${group} ${piece}`;
    else {
      chunks.push(group);
      group = piece;
    }
  }
  if (!group) return { chunks, rest: [] };
  if (final || group.length >= target) return { chunks: [...chunks, group], rest: [] };
  return { chunks, rest: [group] };
}

/** When the studio voice's day ends: the next 00:00 UTC after `now` (milliseconds). */
export const nextUtcMidnight = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

// ------------------------------------------------------------------ The device's voices: the best female voice first

/** What a browser voice tells about itself (SpeechSynthesisVoice). */
export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/** Well-known female voices on Windows/Edge ("AvaMultilingual" too; Urdu: Uzma, Gul), macOS/iOS, Chrome and Android (voice codes). */
const FEMALE =
  /\b(?:(?:ava|emma|jenny|aria|sonia|libby|natasha|michelle|ana|clara|jane|nancy|sara|ashley|cora|elizabeth|monica|amber|maisie|hollie|molly|neerja|heera|samantha|karen|moira|tessa|serena|victoria|allison|susan|fiona|veena|kate|hazel|catherine|linda|zira|uzma|gul)(?:multilingual)?|female|woman|x-(?:sfg|iob|iog|tpc|tpf))\b/i;
/** Well-known male voices (never chosen while there's another one). */
const MALE =
  /\b(?:(?:david|mark|george|guy|ryan|james|christopher|eric|roger|steffan|andrew|brian|william|thomas|daniel|alex|fred|oliver|arthur|aaron|rishi|ravi|prabhat|tom|lee|asad|salman)(?:multilingual)?|male|man|x-(?:iom|iol|tpd))\b/i;

/** How good a voice is for VESPER (higher is better): natural female voices first, known male voices last. */
export function voiceScore(v: VoiceInfo): number {
  const name = v.name.toLowerCase();
  let score: number;
  if (/google uk english female/.test(name)) score = 90;
  else if (/google us english/.test(name)) score = 85; // Chrome's US English voice is female
  else if (MALE.test(name) && !/female/.test(name)) return -100 + (v.localService ? 0 : 1);
  else if (/zira/.test(name)) score = 20; // female, but robotic: a last resort
  else if (FEMALE.test(name) && /natural|neural|online|premium|enhanced/.test(name)) score = 100;
  else if (/\b(samantha|karen|moira|tessa|serena)\b/.test(name)) score = 78;
  else if (FEMALE.test(name)) score = 60;
  else score = 10; // unknown: often fine (e.g. Android's own voices), but maybe male
  if (!v.localService) score += 3; // voices from the network usually sound better
  if (/^en-(us|gb)/i.test(v.lang)) score += 1;
  if (v.default) score += 1;
  return score;
}

/**
 * The voices for `language` ("en"), best first; all voices when none is for that language. A known male voice comes
 * after every other one.
 */
export function rankVoices<T extends VoiceInfo>(voices: readonly T[], language = "en"): T[] {
  const prefix = language.toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix));
  const list = matching.length > 0 ? matching : [...voices];
  return list
    .map((v, i) => ({ v, i, score: voiceScore(v) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.v);
}

// ------------------------------------------------------------------ Listening: noticing when you stop talking

/**
 * Loudness 0..1 of one block of microphone samples (-1..1), on a scale that suits the eye and the silence check:
 * a quiet room is about 0.05–0.1, normal speech about 0.3–0.7.
 */
export function loudness(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.8);
}

export interface ListenTiming {
  /** Stop this long after the speech ends. */
  silenceMs: number;
  /** Give up when no speech starts within this time. */
  noSpeechMs: number;
  /** Never record longer than this. */
  maxMs: number;
  /** Loud for at least this long counts as speech (a click or a cough doesn't). */
  minSpeechMs: number;
  /** The first moments measure the room's own noise. */
  calibrateMs: number;
  /** Loudness that always counts as speech is at least this... */
  threshold: number;
  /** ...and at least this much above the room's noise. */
  margin: number;
}

export const LISTEN_TIMING: ListenTiming = {
  silenceMs: 1200,
  noSpeechMs: 8000,
  maxMs: 30_000,
  minSpeechMs: 150,
  calibrateMs: 250,
  threshold: 0.16,
  margin: 0.12,
};

/** listening: keep going. silence: you spoke and then stopped. no-speech: nothing was said in time. limit: too long. */
export type ListenVerdict = "listening" | "silence" | "no-speech" | "limit";

/**
 * Decides when a listening turn is over, from loudness readings (0..1) and their times in milliseconds. Times are
 * used rather than counting readings, so a slower timer (a tab in the background) changes nothing.
 */
export class SilenceDetector {
  private readonly timing: ListenTiming;
  private floor: number | null = null;
  private loudSince: number | null = null;
  private lastLoud = 0;
  private heard = false;

  constructor(
    private readonly startedAt: number,
    timing: Partial<ListenTiming> = {},
  ) {
    this.timing = { ...LISTEN_TIMING, ...timing };
  }

  /** Whether speech has been heard in this turn. */
  get speechHeard(): boolean {
    return this.heard;
  }

  feed(level: number, now: number): ListenVerdict {
    const t = this.timing;
    const elapsed = now - this.startedAt;
    if (elapsed >= t.maxMs) return "limit";
    if (elapsed < t.calibrateMs) {
      // The room's noise: the quietest reading so far (someone already talking mustn't raise it much).
      this.floor = Math.min(this.floor ?? level, level, 0.3);
      return "listening";
    }
    const floor = this.floor ?? 0;
    const loud = level >= Math.max(t.threshold, floor + t.margin);
    if (loud) {
      this.loudSince ??= now;
      if (now - this.loudSince >= t.minSpeechMs) this.heard = true;
      if (this.heard) this.lastLoud = now;
    } else {
      this.loudSince = null;
      // Follow the room's noise slowly, and quickly when it gets quieter.
      this.floor = Math.min(0.3, floor + (level - floor) * (level < floor ? 0.2 : 0.02));
    }
    if (this.heard && now - this.lastLoud >= t.silenceMs) return "silence";
    if (!this.heard && elapsed >= t.noSpeechMs) return "no-speech";
    return "listening";
  }
}
