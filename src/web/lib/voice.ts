import { useSyncExternalStore } from "react";

// ------------------------------------------------------------------ Recording (microphone → server → text)

export const canRecord = () =>
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";

/** Formats the speech services accept, in order of preference (Chrome/Edge/Firefox: WebM; Safari: MP4). */
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export interface Recording {
  base64: string;
  mimeType: string;
  seconds: number;
}

export class RecordingError extends Error {}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new RecordingError("Could not read the recording."));
    reader.readAsDataURL(blob);
  });
}

/** One recording from the microphone. Stops by itself after `maxSeconds`. */
export class VoiceRecorder {
  private readonly chunks: Blob[] = [];
  private readonly started = Date.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly finished: Promise<void>;

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
    maxSeconds: number,
    onLimit: () => void,
  ) {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.finished = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    this.timer = setTimeout(onLimit, maxSeconds * 1000);
    recorder.start(1000);
  }

  static async start(maxSeconds: number, onLimit: () => void): Promise<VoiceRecorder> {
    if (!canRecord()) throw new RecordingError("This browser can't record audio.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      throw new RecordingError(
        denied
          ? "Microphone access was blocked. Allow the microphone for this site (the icon in the address bar) and try again."
          : "No microphone was found.",
      );
    }
    const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
    try {
      return new VoiceRecorder(stream, new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined), maxSeconds, onLimit);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      throw new RecordingError("This browser can't record audio.");
    }
  }

  get elapsedSeconds(): number {
    return (Date.now() - this.started) / 1000;
  }

  private release(): void {
    clearTimeout(this.timer);
    this.stream.getTracks().forEach((t) => t.stop());
  }

  /** Stop and return the recording. */
  async stop(): Promise<Recording> {
    const seconds = this.elapsedSeconds;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.finished;
    this.release();
    const mimeType = (this.recorder.mimeType || this.chunks[0]?.type || "audio/webm").replace(/\s+/g, "");
    const blob = new Blob(this.chunks, { type: mimeType });
    if (blob.size === 0) throw new RecordingError("Nothing was recorded.");
    return { base64: await toBase64(blob), mimeType, seconds: Math.round(seconds * 10) / 10 };
  }

  /** Stop and throw the recording away. */
  cancel(): void {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }
}

// ------------------------------------------------------------------ Read aloud (the device's built-in voices)

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** Markdown answer → text worth hearing (no code, links read by their text, no table/markup symbols). */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "\n(code omitted)\n")
    .replace(/\$\$[\s\S]*?\$\$/g, " (formula) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Short pieces: long single utterances get cut off in some browsers. */
function pieces(text: string): string[] {
  const sentences = text.match(/[^.!?۔\n]+[.!?۔]*|\n/g) ?? [text];
  const out: string[] = [];
  let current = "";
  const push = (s: string) => {
    if (s.trim()) out.push(s.trim());
  };
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) {
      push(current);
      current = "";
      continue;
    }
    if (s.length > 260) {
      push(current);
      current = "";
      for (let i = 0; i < s.length; i += 240) {
        const cut = s.slice(i, i + 240);
        push(cut);
      }
      continue;
    }
    if (current && current.length + s.length > 220) {
      push(current);
      current = s;
    } else current = current ? `${current} ${s}` : s;
  }
  push(current);
  return out;
}

const URDU = /[؀-ۿ]/;

let speakingId: string | null = null;
/** Bumped on every start/stop, so events from an earlier (cancelled) reading are ignored. */
let generation = 0;
const listeners = new Set<() => void>();
const setSpeaking = (id: string | null) => {
  speakingId = id;
  listeners.forEach((l) => l());
};

export function stopSpeaking(): void {
  if (!canSpeak()) return;
  generation++;
  window.speechSynthesis.cancel();
  setSpeaking(null);
}

/** Read one answer aloud (stops anything already being read). */
export function speak(id: string, markdown: string): void {
  if (!canSpeak()) return;
  const run = ++generation;
  window.speechSynthesis.cancel();
  const text = speakableText(markdown);
  const parts = pieces(text);
  if (parts.length === 0) return setSpeaking(null);
  const urdu = URDU.test(text);
  const voice = urdu ? window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("ur")) : undefined;
  const done = () => run === generation && setSpeaking(null);
  setSpeaking(id);
  parts.forEach((part, index) => {
    const u = new SpeechSynthesisUtterance(part);
    if (urdu) u.lang = voice?.lang ?? "ur-PK";
    if (voice) u.voice = voice;
    if (index === parts.length - 1) u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

/** The id of the answer being read aloud right now (null when silent). */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => speakingId,
    () => null,
  );
}
