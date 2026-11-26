import { ArrowUp, AudioLines, MessageSquareText, Mic, Square, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { AUTO_MODEL, type ConversationDto, type FeaturesDto, type UserSettings } from "../../shared/types";
import { speakerLabel, STUDIO_VOICE_MAX_CHARS } from "../../shared/voice";
import { api, ApiError } from "../api/client";
import { useChat, type UiMessage } from "../hooks/useChat";
import {
  agentGreeting,
  briefingRequest,
  loudness,
  nextSentences,
  nextUtcMidnight,
  progressLine,
  rankVoices,
  SilenceDetector,
  speechChunks,
  takeChunks,
  type ListenVerdict,
} from "../lib/agent-voice";
import { answerSources, chipLabels, githubLineLinks, plainDocumentLinks, tidyCitations } from "../lib/format";
import { agentAudio, canRecord, canSpeak, closeAgentAudio, RecordingError, speakableText, stopSpeaking, type Recording } from "../lib/voice";
import { AgentCore, type AgentCoreState } from "./AgentCore";
import { GithubActionCard } from "./GithubActionCard";
import { GoogleActionCard } from "./GoogleActionCard";
import { Markdown } from "./Markdown";
import { plainToolText, WebsiteButtons } from "./ToolActivity";

// ------------------------------------------------------------------ Listening (the microphone, with a loudness meter)

/** Formats the speech services accept, in order of preference (the same as the message box's microphone). */
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new RecordingError("Could not read the recording."));
    reader.readAsDataURL(blob);
  });
}

type EndReason = Exclude<ListenVerdict, "listening">;

/** Web Audio (the microphone meter and the studio voice), where the browser has it. */
const audioContextClass = (): typeof AudioContext | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

/**
 * One listening turn. Records like the message box's microphone (lib/voice.ts) and measures the loudness on the same
 * stream, so it notices when you stop talking (lib/agent-voice.ts decides). Every way out stops the microphone and
 * closes the meter.
 */
class AgentListener {
  private readonly chunks: Blob[] = [];
  private readonly startedAt = Date.now();
  private readonly finished: Promise<void>;
  private readonly limit: ReturnType<typeof setTimeout>;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private audio: AudioContext | null = null;
  private ended = false;
  private released = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
    maxSeconds: number,
    onLevel: (level: number) => void,
    private readonly onEnd: (reason: EndReason) => void,
  ) {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.finished = new Promise((resolve) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => resolve();
    });
    recorder.start(1000);
    this.limit = setTimeout(() => this.end("limit"), maxSeconds * 1000);
    this.meter(maxSeconds, onLevel);
  }

  static async start(maxSeconds: number, onLevel: (level: number) => void, onEnd: (reason: EndReason) => void): Promise<AgentListener> {
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
      return new AgentListener(stream, new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined), maxSeconds, onLevel, onEnd);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      throw new RecordingError("This browser can't record audio.");
    }
  }

  /** The loudness meter. Without one (an old browser), the microphone button and the time limit still end the turn. */
  private meter(maxSeconds: number, onLevel: (level: number) => void): void {
    const Context = audioContextClass();
    if (!Context) return;
    try {
      const audio = new Context();
      this.audio = audio;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      const muted = audio.createGain();
      muted.gain.value = 0;
      audio.createMediaStreamSource(this.stream).connect(analyser);
      // Through a silent output, so every browser keeps measuring.
      analyser.connect(muted).connect(audio.destination);
      void audio.resume().catch(() => {});
      const samples = new Float32Array(analyser.fftSize);
      let detector: SilenceDetector | null = null;
      let shown = 0;
      this.meterTimer = setInterval(() => {
        // A meter whose audio isn't allowed to run hears nothing: it then stays out of the decision.
        if (this.ended || audio.state !== "running") return;
        try {
          analyser.getFloatTimeDomainData(samples);
        } catch {
          this.stopMeter();
          return;
        }
        const level = loudness(samples);
        shown = Math.max(level, shown * 0.8); // quick to rise, gentle to fall
        onLevel(Math.round(shown * 100) / 100);
        const now = Date.now();
        detector ??= new SilenceDetector(now, { maxMs: maxSeconds * 1000 });
        const verdict = detector.feed(level, now);
        if (verdict !== "listening") this.end(verdict);
      }, 50);
    } catch {
      this.stopMeter();
    }
  }

  private end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.stopMeter();
    this.onEnd(reason);
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) clearInterval(this.meterTimer);
    this.meterTimer = null;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.ended = true;
    clearTimeout(this.limit);
    this.stopMeter();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.audio?.close().catch(() => {});
    this.audio = null;
  }

  /** Stop and return the recording. */
  async stop(): Promise<Recording> {
    this.ended = true;
    this.stopMeter();
    const seconds = (Date.now() - this.startedAt) / 1000;
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
      // The last piece of audio arrives with "stop"; never wait for it forever.
      await Promise.race([this.finished, new Promise((resolve) => setTimeout(resolve, 3000))]);
    } finally {
      this.release();
    }
    const mimeType = (this.recorder.mimeType || this.chunks[0]?.type || "audio/webm").replace(/\s+/g, "");
    const blob = new Blob(this.chunks, { type: mimeType });
    if (blob.size === 0) throw new RecordingError("Nothing was recorded.");
    return { base64: await toBase64(blob), mimeType, seconds: Math.round(seconds * 10) / 10 };
  }

  /** Stop and throw the recording away. */
  cancel(): void {
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // already stopped
    }
    this.release();
  }
}

// ------------------------------------------------------------------ VESPER's voice: the studio voice or the device's

const URDU = /[؀-ۿ]/;
const STUDIO_UNTIL_KEY = "vesper-agent-studio-until";
/** Today's studio characters are used up: remembered until 00:00 UTC, so it isn't asked again for every sentence. */
const studioLimited = () => {
  try {
    return Date.now() < Number(localStorage.getItem(STUDIO_UNTIL_KEY) ?? 0);
  } catch {
    return false;
  }
};
const rememberStudioLimit = () => {
  try {
    localStorage.setItem(STUDIO_UNTIL_KEY, String(nextUtcMidnight(Date.now())));
  } catch {
    // storage unavailable: asked again next time
  }
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A studio request that hasn't answered by then is given up (the device voice speaks instead). */
const STUDIO_TIMEOUT_MS = 10_000;

/** The request's own signal, also aborted after `ms` (a timer of our own where AbortSignal.any/timeout are missing). */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const S = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal; timeout?: (ms: number) => AbortSignal };
  if (typeof S.any === "function" && typeof S.timeout === "function") return S.any([signal, S.timeout(ms)]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The studio voice took too long.", "TimeoutError")), ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      controller.abort(signal.reason);
    },
    { once: true },
  );
  return controller.signal;
}

/** Which voice speaks: the studio voice (while it can), or a device voice by name (null: the best female one). */
interface VoiceChoice {
  studio: boolean;
  deviceName: string | null;
}
type StudioIssue = "limit" | "off";
/** One piece to say, in order: by the studio voice (its audio asked for ahead) or by the device. */
type Piece = { text: string; studio: boolean; controller?: AbortController; audio?: Promise<AudioBuffer> };

/** The device voice to use: the chosen one, else the best female voice for English. */
function deviceVoice(name: string | null): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return (name ? voices.find((v) => v.name === name) : undefined) ?? rankVoices(voices)[0];
}

/**
 * VESPER's voice. Sentences arrive while the reply is still being written and are said in order: by the studio voice
 * (natural, from the server: a few sentences per request, the next asked for while one plays, at most two at a time)
 * or by the device's own voice (text with Urdu letters, a device voice chosen, or after a studio error: then the rest
 * of that reply). Starting stops the chat's Read aloud. `onChange` says whether it is talking, `onLevel` how loud the
 * studio voice is (for the core).
 */
class AgentVoice {
  /** Bumped by stop(): everything from earlier speech is ignored. */
  private run = 0;
  /** Sentences for the studio voice not in a request yet, and the pieces to say, in order. */
  private pending: string[] = [];
  private queue: Piece[] = [];
  /** The piece being said (or whose audio is awaited). */
  private current: Piece | null = null;
  private talking = false;
  /** After a studio error: the device voice for the rest of this reply. */
  private deviceForReply = false;
  /** Switched off or not available on the server: the device voice for this session. */
  private studioOff = false;
  private choice: VoiceChoice = { studio: false, deviceName: null };
  private utterance: SpeechSynthesisUtterance | null = null;
  private deviceWatch: ReturnType<typeof setInterval> | null = null;
  private audio: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playWatch: ReturnType<typeof setTimeout> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly events: {
      onChange: (speaking: boolean) => void;
      onLevel: (level: number) => void;
      onStudioIssue: (issue: StudioIssue) => void;
    },
  ) {}

  get speaking(): boolean {
    return this.talking;
  }

  setChoice(choice: VoiceChoice): void {
    this.choice = choice;
  }

  /**
   * Safari and phones let audio start only from a tap, so every tap handler calls this: the studio voice's output is
   * created and started right then. A refusal means no studio voice for this session. Resolves once it runs (or after
   * half a second).
   */
  unlock(force = false): Promise<void> {
    if (!force && (!this.choice.studio || this.studioOff)) return Promise.resolve();
    const audio = this.context();
    if (!audio || audio.state === "running") return Promise.resolve();
    const started = audio.resume().catch(() => {
      this.studioOff = true;
      this.events.onStudioIssue("off");
    });
    return Promise.race([started, wait(500)]);
  }

  /** A sentence of a reply still being written (more may follow). */
  add(markdown: string): void {
    const text = speakableText(markdown);
    if (!text) return;
    if (this.studioFor(text)) {
      this.pending.push(text);
      this.pump(false);
      return;
    }
    // What waits for the studio voice comes first.
    this.pump(true);
    for (const part of speechChunks(text)) this.queue.push({ text: part, studio: false });
    this.next();
  }

  /** Nothing more for now: what waits for the studio voice is asked for too. */
  flush(): void {
    this.pump(true);
  }

  /** A whole text at once (the greeting, a note, the voice test). */
  say(markdown: string): void {
    this.add(markdown);
    this.flush();
  }

  stop(): void {
    this.run++;
    for (const piece of [this.current, ...this.queue]) piece?.controller?.abort();
    this.current = null;
    this.queue = [];
    this.pending = [];
    this.deviceForReply = false;
    if (this.source) {
      const source = this.source;
      this.source = null;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // not started yet
      }
    }
    if (this.playWatch) clearTimeout(this.playWatch);
    this.playWatch = null;
    this.stopMeter();
    if (this.deviceWatch) clearInterval(this.deviceWatch);
    this.deviceWatch = null;
    if (this.utterance) {
      this.utterance = null;
      if (canSpeak()) window.speechSynthesis.cancel();
    }
    this.setTalking(false);
  }

  /** Closing: stop, and let the audio output go. */
  dispose(): void {
    this.stop();
    void this.audio?.close().catch(() => {});
    this.audio = null;
    this.analyser = null;
  }

  /**
   * Whether the studio voice reads this. Only while its output runs: otherwise (no tap yet on Safari or a phone) the
   * device voice says the rest of this reply and nothing is asked for, so no characters are spent unheard.
   */
  private studioFor(text: string): boolean {
    if (!this.choice.studio || this.studioOff || this.deviceForReply || URDU.test(text) || studioLimited()) return false;
    if (this.audio?.state === "running") return true;
    this.deviceForReply = true;
    return false;
  }

  private setTalking(on: boolean): void {
    if (on === this.talking) return;
    this.talking = on;
    // Nothing of VESPER's is being said yet: stop the chat's Read aloud.
    if (on) stopSpeaking();
    this.events.onChange(on);
  }

  private pump(final: boolean): void {
    if (this.pending.length === 0) return;
    const starting = !this.current && this.queue.length === 0;
    // Something playing and nothing after it yet: ask for what has arrived now, so there's no gap.
    const ahead = this.current !== null && this.queue.length === 0;
    const { chunks, rest } = takeChunks(this.pending, { starting, final: final || ahead, max: STUDIO_VOICE_MAX_CHARS });
    this.pending = rest;
    for (const text of chunks) this.queue.push({ text, studio: true });
    this.prefetch();
    this.next();
  }

  /**
   * Ask for the next studio piece's audio while one plays: one ahead only, so at most two requests are open (the
   * piece playing or awaited, and the next) and little is paid for if VESPER is interrupted.
   */
  private prefetch(): void {
    const next = this.queue.find((p) => p.studio);
    if (!next || next.audio) return;
    if (this.audio?.state !== "running") this.switchToDevice(null);
    else this.request(next);
  }

  private request(piece: Piece): void {
    const audio = this.audio!;
    const controller = new AbortController();
    piece.controller = controller;
    piece.audio = api.speech(piece.text, withTimeout(controller.signal, STUDIO_TIMEOUT_MS)).then((bytes) => audio.decodeAudioData(bytes));
    piece.audio.catch(() => {}); // looked at when its turn comes
  }

  private next(): void {
    if (this.current) return;
    const piece = this.queue.shift();
    if (!piece) {
      // Keep talking with what has arrived, or stop.
      if (this.pending.length > 0) this.pump(true);
      else this.setTalking(false);
      return;
    }
    this.current = piece;
    this.setTalking(true);
    // What waits for the studio voice is asked for while this piece plays.
    if (this.queue.length === 0 && this.pending.length > 0) this.pump(true);
    this.prefetch();
    const run = this.run;
    const done = () => {
      if (run !== this.run) return;
      this.current = null;
      this.next();
    };
    if (piece.studio) void this.playStudio(piece, run, done);
    else this.speakDevice(piece.text, done);
  }

  private async playStudio(piece: Piece, run: number, done: () => void): Promise<void> {
    try {
      if (!piece.audio) {
        if (this.audio?.state !== "running") throw new Error("The audio output isn't running.");
        this.request(piece);
      }
      const buffer = await piece.audio!;
      const audio = this.audio;
      if (run !== this.run) return;
      if (!audio || !this.analyser) throw new Error("No audio output.");
      // Stopped meanwhile (a phone call, another output): one short try, else the device voice.
      if (audio.state !== "running") await Promise.race([audio.resume().catch(() => {}), wait(300)]);
      if (run !== this.run) return;
      if (audio.state !== "running") throw new Error("The audio output isn't running.");
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser);
      this.source = source;
      const end = () => {
        if (this.source !== source) return;
        this.source = null;
        if (this.playWatch) clearTimeout(this.playWatch);
        this.playWatch = null;
        this.stopMeter();
        done();
      };
      source.onended = end;
      // Never "speaking" for ever if the output is held up; and held-up audio mustn't play later over the device voice.
      this.playWatch = setTimeout(() => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // not started
        }
        end();
      }, buffer.duration * 1000 + 2000);
      source.start();
      this.startMeter();
    } catch (error) {
      if (run !== this.run) return;
      this.useDevice(error, piece);
      done();
    }
  }

  /** A studio error: this piece and everything after it in this reply are said by the device, in the same order. */
  private useDevice(error: unknown, failed: Piece): void {
    if (error instanceof ApiError) {
      if (error.code === "studio_voice_limit") {
        rememberStudioLimit();
        this.events.onStudioIssue("limit");
      } else if (error.status === 403 || error.status === 404 || error.status === 503) {
        this.studioOff = true;
        this.events.onStudioIssue("off");
      }
    }
    this.switchToDevice(failed);
  }

  /** This piece (if any) and everything after it in this reply: the device voice, in the same order and device-sized pieces. */
  private switchToDevice(failed: Piece | null): void {
    this.deviceForReply = true;
    for (const piece of this.queue) piece.controller?.abort();
    const texts = [...(failed ? [failed.text] : []), ...this.queue.map((p) => p.text), ...this.pending];
    this.pending = [];
    this.queue = texts.flatMap((text) => speechChunks(text).map((part) => ({ text: part, studio: false })));
  }

  private speakDevice(text: string, done: () => void): void {
    if (!canSpeak()) return done();
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    if (URDU.test(text)) {
      const voices = synth.getVoices();
      const urdu = voices.some((v) => v.lang.toLowerCase().startsWith("ur")) ? rankVoices(voices, "ur")[0] : undefined;
      u.lang = urdu?.lang ?? "ur-PK";
      if (urdu) u.voice = urdu;
    } else {
      const voice = deviceVoice(this.choice.deviceName);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
    }
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      if (this.deviceWatch) clearInterval(this.deviceWatch);
      this.deviceWatch = null;
      if (this.utterance === u) this.utterance = null;
      done();
    };
    u.onend = end;
    u.onerror = end;
    // Kept until it ends: some browsers drop the end event of an utterance nothing refers to.
    this.utterance = u;
    synth.speak(u);
    // Speech cancelled elsewhere, or that never starts, may send no events: silent for a second means it's over.
    let quietSince: number | null = null;
    this.deviceWatch = setInterval(() => {
      if (synth.speaking || synth.pending) {
        quietSince = null;
        return;
      }
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 1000) end();
    }, 500);
  }

  /**
   * One audio output per session: the studio voice goes through a meter (the core follows its loudness). It is the
   * one the launcher's tap already started (v0.19.0: Agent mode may have been downloading during that tap).
   */
  private context(): AudioContext | null {
    if (this.audio && this.audio.state !== "closed") return this.audio;
    const audio = agentAudio();
    if (!audio) return null;
    try {
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(audio.destination);
      this.audio = audio;
      this.analyser = analyser;
      return audio;
    } catch {
      return null;
    }
  }

  private startMeter(): void {
    const analyser = this.analyser;
    if (!analyser) return;
    if (this.meterTimer !== null) clearInterval(this.meterTimer);
    const samples = new Float32Array(analyser.fftSize);
    let shown = 0;
    this.meterTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      shown = Math.max(loudness(samples), shown * 0.8);
      this.events.onLevel(Math.round(shown * 100) / 100);
    }, 50);
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.events.onLevel(0);
  }
}

// ------------------------------------------------------------------ The screen

/** The microphone level outside React state, so only the core redraws while you talk. */
function levelStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    set: (next: number) => {
      if (next === value) return;
      value = next;
      listeners.forEach((l) => l());
    },
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
type LevelStore = ReturnType<typeof levelStore>;

function LiveCore({ levels, state, size }: { levels: LevelStore; state: AgentCoreState; size: number }) {
  const level = useSyncExternalStore(levels.subscribe, levels.get, levels.get);
  return <AgentCore state={state} level={state === "listening" || state === "speaking" ? level : 0} size={size} />;
}

/** The core's size: about 220 px on a phone, up to 320 px on a large screen, smaller on short screens. */
function useCoreSize(): number {
  const measure = () => Math.round(Math.max(150, Math.min(320, window.innerWidth * 0.57, window.innerHeight * 0.34)));
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const onResize = () => setSize(measure());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

const VOICE_KEY = "vesper-agent-voice";
const readVoiceOut = () => {
  try {
    return localStorage.getItem(VOICE_KEY) !== "0";
  } catch {
    return true;
  }
};
const saveVoiceOut = (on: boolean) => {
  try {
    localStorage.setItem(VOICE_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: still works for this visit
  }
};
/** The voice chosen in the voice menu (v0.17.1): "studio", or a device voice's name. */
const CHOICE_KEY = "vesper-agent-voice-choice";
const readChoice = () => {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
};
const saveChoice = (choice: string) => {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // storage unavailable: still works for this visit
  }
};
const TEST_SENTENCE = "Hello, I'm VESPER. How can I help?";
/** Opened from the daily briefing's notification (v0.18.0): sound may only start after a tap, so it waits for one. */
const BRIEFING_READY = "Your briefing is ready. Tap the core to hear it.";
const BRIEFING_TAP = "Tap to hear your briefing";

/** The device's voices (they load a moment after the page: "voiceschanged"). */
function useDeviceVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (canSpeak() ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!canSpeak()) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(synth.getVoices());
    update();
    synth.addEventListener("voiceschanged", update);
    return () => synth.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

const prefersCalm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const finePointer = () => window.matchMedia?.("(pointer: fine)").matches !== false;

const BOOT_MS = 1400;
const CLOSE_MS = 280;
const ERROR_MS = 1600;
const MAX_CHARS = 32_000;
const MAX_CHIPS = 4;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);

const hudBase =
  "flex h-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ag-cyan-soft)] hover:text-[var(--ag-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ag-cyan)] disabled:pointer-events-none disabled:opacity-40 sm:h-10";
const hudIcon = `${hudBase} w-9 sm:w-10`;
/** A HUD button's colours: cyan and lit when on (pressed or listening). */
const hudTone = (on: boolean) => (on ? "bg-[var(--ag-cyan-soft)] text-[var(--ag-cyan)]" : "text-[var(--ag-text-soft)]");
const chip =
  "inline-flex max-w-[12rem] items-center gap-1.5 rounded-md border border-[var(--ag-border)] px-2 py-0.5 text-[11px] text-[var(--ag-text-soft)] transition-colors hover:border-[var(--ag-cyan)] hover:text-[var(--ag-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ag-cyan)]";
/** "Open youtube.com" (v0.19.0): a website the user asked for, the whole domain always shown. */
const siteButton =
  "inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--ag-cyan)] bg-[var(--ag-cyan-soft)] px-3 py-1.5 text-[13px] font-medium text-[var(--ag-text)] transition-colors hover:bg-[var(--ag-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ag-cyan)] [&>svg]:text-[var(--ag-cyan)]";
/** Links in a reply in the HUD's colour. */
const replyAccent = { "--accent": "var(--ag-cyan)" } as CSSProperties;

type Phase = "idle" | "starting" | "listening" | "transcribing";
type Flash = { id: number; text: string; tone: "error" | "info"; user: string | null };
/** One thing said and its answer (the greeting and notes like "I didn't hear anything" have no message behind them). */
interface Exchange {
  key: string;
  user: string | null;
  reply: UiMessage | null;
  text: string | null;
  tone: "normal" | "error" | "info";
}

/** The reply as shown: the same tidying as in the chat. */
function shownText(m: UiMessage): string {
  const documentTitles = (m.tools ?? []).flatMap((t) => t.sources ?? []).filter((s) => !s.url).map((s) => s.title);
  return githubLineLinks(plainDocumentLinks(tidyCitations(m.content), documentTitles), m.tools);
}

const plainOf = (e: Exchange) => e.text ?? (e.reply ? speakableText(tidyCitations(e.reply.content)) || e.reply.error || "" : "");

/** One voice in the voice menu. */
function VoiceOption({ value, checked, title, note, onChoose }: { value: string; checked: boolean; title: string; note: string; onChoose: (value: string) => void }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--ag-cyan-soft)] ${checked ? "bg-[var(--ag-cyan-soft)]" : ""}`}>
      <input
        type="radio"
        name="agent-voice"
        value={value}
        checked={checked}
        onChange={() => onChoose(value)}
        className="mt-0.5 shrink-0 accent-[var(--ag-cyan)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ag-cyan)]"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-[var(--ag-text)] [overflow-wrap:anywhere]">{title}</span>
        <span className="block text-[11px] text-[var(--ag-text-soft)]">{note}</span>
      </span>
    </label>
  );
}

export interface AgentModeProps {
  /** For the greeting; without a name it greets without one. */
  firstName: string | null;
  settings: UserSettings;
  features: FeaturesDto | null;
  /** The launcher's centre on screen: the view opens from it and collapses back into it. */
  origin?: { x: number; y: number } | null;
  onClose: () => void;
  /** Close and show this conversation in the normal chat. */
  onOpenInChat: (conversationId: string) => void;
  onConversationCreated: (conversation: ConversationDto) => void;
  onConversationActivity: (id: string) => void;
  /**
   * Opened from the daily briefing's notification (v0.18.0): the greeting says the briefing is ready, and tapping the
   * core asks for it ("Brief me for today/tomorrow.", sent with `briefing: true`) with the sound unlocked by that tap.
   */
  briefing?: boolean;
  /** The day the briefing is about ("YYYY-MM-DD", from the notification); null: today or tomorrow by the time. */
  briefingDay?: string | null;
}

/**
 * VESPER Agent (v0.17.0): a full-screen mode over the chat. Talk or type; the core shows whether VESPER is listening,
 * thinking or speaking; your words and the reply float around it. Its conversations are normal saved chats (its own
 * chat state, so the normal chat stays as it was). Outward actions keep their Approve cards.
 */
export function AgentMode({
  firstName,
  settings,
  features,
  origin,
  onClose,
  onOpenInChat,
  onConversationCreated,
  onConversationActivity,
  briefing = false,
  briefingDay = null,
}: AgentModeProps) {
  const [calm] = useState(prefersCalm);
  const [booting, setBooting] = useState(!calm);
  const [greeting] = useState(() => (briefing ? BRIEFING_READY : agentGreeting(firstName)));
  /** The briefing waits for a tap on the core (until then, or until something else is sent). */
  const [briefingWaiting, setBriefingWaitingState] = useState(briefing);
  const briefingWaitingRef = useRef(briefing);
  const setBriefingWaiting = (on: boolean) => {
    briefingWaitingRef.current = on;
    setBriefingWaitingState(on);
  };
  const [entered, setEntered] = useState(calm);
  const [closing, setClosing] = useState(false);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [voiceOut, setVoiceOut] = useState(readVoiceOut);
  const [handsFree, setHandsFree] = useState(false);
  const [input, setInput] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [errorPulse, setErrorPulse] = useState(false);
  /** What the screen reader hears of the reply (the state is announced separately). */
  const [replyNote, setReplyNote] = useState("");
  /** The voice menu (v0.17.1): the choice, and why the studio voice isn't speaking right now. */
  const [voiceChoice, setVoiceChoice] = useState(readChoice);
  const [studioIssue, setStudioIssue] = useState<"limit" | "off" | null>(() => (studioLimited() ? "limit" : null));
  const [menuOpen, setMenuOpen] = useState(false);
  const size = useCoreSize();
  const deviceVoices = useDeviceVoices();

  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const cardsPanel = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const listener = useRef<AgentListener | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const closingRef = useRef(false);
  const alive = useRef(true);
  const [levels] = useState(levelStore);
  const [voice] = useState(() => new AgentVoice({ onChange: setSpeaking, onLevel: levels.set, onStudioIssue: setStudioIssue }));
  /**
   * The turn being spoken: which one (counted by your messages), how much of its reply was handed to the voice, and
   * whether its spoken progress line (v0.18.0) was dealt with.
   */
  const spoken = useRef({ turn: -1, upTo: 0, muted: false, progress: false });
  /** Hands-free: listen again once this turn's reply has been written and spoken. */
  const listenAfterTurn = useRef(false);
  /** Words that arrived while the previous reply was still being written: sent once it has stopped. */
  const pendingSend = useRef<string | null>(null);
  const lastSent = useRef("");
  const wasStreaming = useRef(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testRun = useRef(0);

  const sttOn = Boolean(features?.voice.speechToText) && canRecord();
  // The studio voice (v0.17.1): switched on by the admin, with Web Audio to play it.
  const studio = features?.voice.enabled && features.voice.studio?.enabled && audioContextClass() ? features.voice.studio : null;
  const ttsOn = Boolean(features?.voice.enabled) && (canSpeak() || studio !== null);
  const rankedVoices = useMemo(() => rankVoices(deviceVoices), [deviceVoices]);
  // Studio when it's there and not declined (the default), else the chosen device voice, else the best female one.
  const useStudio = studio !== null && studioIssue !== "off" && (voiceChoice === null || voiceChoice === "studio");
  const chosenDevice = voiceChoice && voiceChoice !== "studio" && rankedVoices.some((v) => v.name === voiceChoice) ? voiceChoice : null;
  voice.setChoice({ studio: useStudio, deviceName: voiceChoice && voiceChoice !== "studio" ? voiceChoice : null });
  const selectedVoice = useStudio ? "studio" : (chosenDevice ?? rankedVoices[0]?.name ?? null);
  const voiceLabel = useStudio && studio ? `Studio voice (${speakerLabel(studio.speaker)})` : (selectedVoice ?? "the device's voice");
  const maxSeconds = Math.max(5, Math.min(30, features?.voice.maxRecordingSeconds ?? 30));
  // The agent's tasks run on the server's tools, which a model on this computer can't use.
  const localDefault = settings.defaultModel.startsWith("ollama:");
  const model = localDefault ? AUTO_MODEL : settings.defaultModel;

  const chat = useChat({
    agent: true,
    ollamaUrl: settings.ollamaUrl,
    onError: (message) => {
      // Rejected before anything was stored (e.g. a limit): the words go back into the box.
      setInput((text) => text || lastSent.current);
      showFlash(message, "error", lastSent.current || null);
    },
    onConversationCreated,
    onConversationActivity,
  });
  const userCount = chat.messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);
  /** The latest values, for callbacks that finish later (after a recording or a reply). */
  const live = useRef({ chat, voiceOut, ttsOn, sttOn, model, maxSeconds, language: settings.speechLanguage, userCount });
  live.current = { chat, voiceOut, ttsOn, sttOn, model, maxSeconds, language: settings.speechLanguage, userCount };

  const last = chat.messages[chat.messages.length - 1];
  const reply = last?.role === "assistant" ? last : null;
  const replyContent = reply?.content ?? "";
  const replyDone = !chat.streaming;

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const pulse = () => {
    setErrorPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setErrorPulse(false), ERROR_MS);
  };

  /** Whether VESPER may speak now: voice replies on, the microphone off, the view not closing. */
  const maySpeak = () => {
    const l = live.current;
    return l.voiceOut && l.ttsOn && phaseRef.current === "idle" && !closingRef.current;
  };
  /** Speak a whole text (the greeting, a note). */
  const say = (text: string) => {
    if (maySpeak()) voice.say(text);
  };

  /** A note in place of a reply: an error (the core flashes) or a hint such as "I didn't hear anything." */
  function showFlash(text: string, tone: Flash["tone"], user: string | null = null) {
    if (!alive.current || closingRef.current) return;
    listenAfterTurn.current = false;
    setFlash({ id: Date.now(), text, tone, user });
    setReplyNote(text);
    if (tone === "error") pulse();
    say(text);
  }

  const sendText = (raw: string, asBriefing: { day: string | null } | null = null): boolean => {
    const text = raw.trim();
    const c = live.current.chat;
    if (!text || closingRef.current) return false;
    // Anything sent instead of the briefing: it no longer waits.
    setBriefingWaiting(false);
    if (c.streaming) {
      // You moved on: stop the reply being written, then send this.
      pendingSend.current = text;
      spoken.current.muted = true;
      listenAfterTurn.current = false;
      voice.stop();
      c.stop();
      return true;
    }
    voice.stop();
    setFlash(null);
    spoken.current = { turn: live.current.userCount + 1, upTo: 0, muted: false, progress: false };
    listenAfterTurn.current = true;
    lastSent.current = text;
    void c.send(text, live.current.model, [], false, [], [], asBriefing).then((accepted) => {
      if (!accepted) listenAfterTurn.current = false;
    });
    return true;
  };

  const finishListening = async (reason: EndReason | "done") => {
    const active = listener.current;
    if (!active) return;
    listener.current = null;
    levels.set(0);
    if (reason === "no-speech") {
      active.cancel();
      setPhase("idle");
      showFlash("I didn't hear anything.", "info");
      return;
    }
    setPhase("transcribing");
    try {
      const recording = await active.stop();
      if (recording.seconds < 0.5) throw new RecordingError("That was too short. Hold on a moment longer and speak.");
      const { text } = await api.transcribe({
        audio: recording.base64,
        mimeType: recording.mimeType,
        seconds: recording.seconds,
        language: live.current.language,
      });
      if (!alive.current || closingRef.current) return;
      setPhase("idle");
      if (text.trim()) sendText(text);
      else showFlash("I didn't catch any speech. Please try again.", "info");
    } catch (e) {
      if (!alive.current || closingRef.current) return;
      setPhase("idle");
      showFlash(e instanceof RecordingError || e instanceof ApiError ? e.message : "Voice input didn't work. Please try again.", "error");
    }
  };

  const startListening = async () => {
    // One recording at a time (a double click doesn't start a second one).
    if (phaseRef.current !== "idle" || closingRef.current || !live.current.sttOn) return;
    voice.stop();
    // A reply still being written goes on in text only: nothing is read out over the microphone.
    spoken.current.muted = true;
    listenAfterTurn.current = false;
    setFlash(null);
    // An error flash from a moment ago gives way: the core now shows that it listens.
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    setErrorPulse(false);
    setPhase("starting");
    levels.set(0);
    try {
      const started = await AgentListener.start(live.current.maxSeconds, levels.set, (reason) => void finishListening(reason));
      // Closed (or cancelled) while the browser was asking for the microphone: let it go at once.
      if (!alive.current || closingRef.current || (phaseRef.current as Phase) !== "starting") {
        started.cancel();
        return;
      }
      listener.current = started;
      setPhase("listening");
    } catch (e) {
      if (!alive.current || closingRef.current) return;
      setPhase("idle");
      showFlash(e instanceof RecordingError ? e.message : "Couldn't start the microphone.", "error");
    }
  };

  const cancelListening = () => {
    listener.current?.cancel();
    listener.current = null;
    levels.set(0);
    setPhase("idle");
  };

  /** Close: the microphone, the voice and a reply being written all stop at once; then the view collapses into the launcher. */
  const requestClose = (after: () => void = onClose) => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingSend.current = null;
    listenAfterTurn.current = false;
    listener.current?.cancel();
    listener.current = null;
    levels.set(0);
    voice.stop();
    live.current.chat.stop();
    if (calm) {
      after();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(after, CLOSE_MS);
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  // Opening: the chat's Read aloud stops; closing (or leaving the page) releases everything.
  useEffect(() => {
    alive.current = true;
    stopSpeaking();
    return () => {
      alive.current = false;
      listener.current?.cancel();
      listener.current = null;
      voice.dispose();
      closeAgentAudio();
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [voice]);

  // Boot-up, then the greeting (at once when the system asks for reduced motion).
  useEffect(() => {
    const greet = () => {
      setBooting(false);
      setReplyNote(greeting);
      // The briefing's note isn't spoken: no tap yet, so the browser wouldn't play it.
      if (phaseRef.current === "idle" && live.current.chat.messages.length === 0 && !briefingWaitingRef.current) say(greeting);
    };
    if (calm) {
      let current = true;
      void (briefing ? Promise.resolve() : voice.unlock()).then(() => current && greet());
      return () => {
        current = false;
        voice.stop();
      };
    }
    const timer = setTimeout(greet, BOOT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow out of the launcher (two frames, so the browser has drawn the starting size).
  useEffect(() => {
    if (calm) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [calm]);

  // The launcher's tap (this runs while it is being handled): the studio voice's output may start now. Not when opened
  // from the briefing's notification: there was no tap, and the core's tap unlocks it.
  useLayoutEffect(() => {
    if (!briefing) void voice.unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);

  // Focus moves into the view: the text field (on touch screens the view itself, so the keyboard doesn't cover the core).
  useEffect(() => {
    if (finePointer()) field.current?.focus({ preventScroll: true });
    else dialog.current?.focus({ preventScroll: true });
  }, []);

  // The voice menu: focus on the chosen voice; a click outside closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const list = menu.current;
    (list?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? list?.querySelector<HTMLInputElement>("input"))?.focus();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !menuButton.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  // Esc closes; Tab stays inside the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        // The voice menu open: Esc closes only the menu.
        if (menu.current) {
          e.preventDefault();
          e.stopPropagation();
          closeMenuRef.current();
          return;
        }
        // In an approval card (e.g. editing the email), Esc only leaves the card, so the edits aren't thrown away
        // by accident; Esc again closes.
        const panel = cardsPanel.current;
        if (panel && e.target instanceof Node && panel.contains(e.target) && e.target !== panel) {
          panel.focus();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialog.current;
      if (!root) return;
      const items = focusables(root);
      const first = items[0];
      const lastItem = items[items.length - 1];
      if (!first || !lastItem) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!active || !root.contains(active) || active === root) {
        e.preventDefault();
        (e.shiftKey ? lastItem : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Speak the reply sentence by sentence while it is written.
  useEffect(() => {
    const s = spoken.current;
    if (!reply || s.turn !== userCount) return;
    const text = tidyCitations(replyContent);
    if (s.upTo > text.length) s.upTo = text.length;
    const { sentences, consumed } = nextSentences(text.slice(s.upTo), replyDone);
    s.upTo += consumed;
    if (s.muted || !maySpeak()) return;
    for (const sentence of sentences) voice.add(sentence);
    if (replyDone) voice.flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyContent, replyDone, userCount]);

  // Spoken progress (v0.18.0): the turn's first tool step gets a short line ("Let me check your calendar."), so VESPER
  // isn't silent while it works. Once per turn, and not when the reply itself has already started.
  const firstStep = reply?.streaming ? reply.tools?.find((t) => progressLine(t.name) !== null) : undefined;
  useEffect(() => {
    const s = spoken.current;
    if (!firstStep || s.turn !== userCount || s.progress) return;
    s.progress = true;
    if (s.muted || s.upTo > 0 || replyContent.trim() || voice.speaking || !maySpeak()) return;
    // Lists and notes (v0.19.0): "Checking your list." or "Updating your list." by what was asked.
    const request = [...chat.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    voice.say(progressLine(firstStep.name, request, firstStep.args)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstStep?.id, userCount]);

  // A turn ended: the screen reader hears the reply (or the error, and the core flashes).
  useEffect(() => {
    if (chat.streaming) {
      wasStreaming.current = true;
      return;
    }
    if (!wasStreaming.current) return;
    wasStreaming.current = false;
    if (!reply || spoken.current.turn !== userCount) return;
    if (reply.error) {
      listenAfterTurn.current = false;
      pulse();
      setReplyNote(reply.error);
      if (!reply.content && !spoken.current.muted) say(reply.error);
    } else if (reply.content) {
      setReplyNote(speakableText(tidyCitations(reply.content)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.streaming]);

  // Words said while a reply was still being written: sent once it has stopped.
  useEffect(() => {
    if (chat.streaming || pendingSend.current === null) return;
    const text = pendingSend.current;
    pendingSend.current = null;
    sendText(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.streaming]);

  // Hands-free: once VESPER has finished (written and spoken), listen again. The turn must be the one on screen and
  // complete (a message sent a moment ago, not yet shown, doesn't count), or there is no turn yet (the greeting).
  useEffect(() => {
    const s = spoken.current;
    const turnSettled = s.turn === userCount ? !reply?.streaming : s.turn === -1;
    if (!listenAfterTurn.current || booting || !turnSettled || chat.streaming || speaking || voice.speaking || phase !== "idle" || closing) return;
    listenAfterTurn.current = false;
    if (handsFree && sttOn) void startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, chat.streaming, speaking, phase, handsFree, closing, userCount, reply?.streaming]);

  const micLabel =
    phase === "listening"
      ? "Stop listening and send"
      : phase === "starting"
        ? "Starting the microphone"
        : phase === "transcribing"
          ? "Turning speech into text"
          : "Speak";
  const onMic = () => {
    void voice.unlock();
    if (phaseRef.current === "listening") void finishListening("done");
    else if (phaseRef.current === "idle") void startListening();
  };

  /** The briefing waits for this tap (v0.18.0). */
  const briefingReady = briefingWaiting && !booting && phase === "idle" && !chat.streaming;
  /**
   * Tapping the core: stops VESPER talking; while listening, ends your turn; with the briefing waiting, starts it;
   * otherwise starts listening.
   */
  const coreAction = speaking
    ? "Stop speaking"
    : phase === "listening"
      ? "Stop listening and send"
      : briefingReady
        ? BRIEFING_TAP
        : phase === "idle" && sttOn && !booting && !chat.streaming
          ? "Start listening"
          : null;
  const onCore = () => {
    const unlocked = voice.unlock();
    if (voice.speaking) {
      voice.stop();
      spoken.current.muted = true;
      listenAfterTurn.current = false;
    } else if (phaseRef.current === "listening") void finishListening("done");
    else if (briefingWaitingRef.current && phaseRef.current === "idle" && !booting && !live.current.chat.streaming) {
      setBriefingWaiting(false);
      // Asked for once the sound this tap allowed is running (at most half a second), so the first words are heard.
      void unlocked.then(() => {
        if (alive.current && !closingRef.current && phaseRef.current === "idle") sendText(briefingRequest(new Date(), briefingDay), { day: briefingDay });
      });
    } else if (phaseRef.current === "idle" && sttOn && !booting && !live.current.chat.streaming) void startListening();
  };

  /** The voice menu closes back onto its button. */
  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;

  const chooseVoice = (choice: string) => {
    if (choice === "studio") void voice.unlock(true);
    setVoiceChoice(choice);
    saveChoice(choice);
  };

  /** Says one sentence in the chosen voice (even with voice replies off: it was asked for). */
  const testVoice = () => {
    if (phaseRef.current !== "idle" || closingRef.current) return;
    voice.stop();
    spoken.current.muted = true;
    listenAfterTurn.current = false;
    const run = ++testRun.current;
    // Said once the studio voice's output runs (it starts on this tap), else by the device.
    void voice.unlock().then(() => {
      if (run === testRun.current && alive.current && phaseRef.current === "idle") voice.say(TEST_SENTENCE);
    });
  };

  const toggleVoiceOut = () => {
    void voice.unlock();
    const next = !voiceOut;
    setVoiceOut(next);
    saveVoiceOut(next);
    if (!next) {
      voice.stop();
      spoken.current.muted = true;
    }
  };

  const toggleHandsFree = () => {
    void voice.unlock();
    const next = !handsFree;
    setHandsFree(next);
    if (!next) return;
    // On: listen now, or as soon as VESPER has finished (also the greeting, while it boots).
    if (voice.speaking || chat.streaming || booting) listenAfterTurn.current = true;
    else if (phaseRef.current === "idle" && !booting) void startListening();
  };

  /** Stop: the reply stops being written and spoken (hands-free doesn't take over). */
  const stopReply = () => {
    voice.stop();
    spoken.current.muted = true;
    listenAfterTurn.current = false;
    chat.stop();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void voice.unlock();
    if (!input.trim() || chat.streaming || phase === "starting" || phase === "transcribing") return;
    if (phase === "listening") cancelListening();
    if (sendText(input)) setInput("");
  };

  const openInChat = () => {
    const id = chat.conversationId;
    if (id) requestClose(() => onOpenInChat(id));
  };

  // ---------------------------------------------------------------- what is on screen

  const coreState: AgentCoreState = booting
    ? "booting"
    : errorPulse
      ? "error"
      : phase === "listening" || phase === "starting"
        ? "listening"
        : speaking
          ? "speaking"
          : phase === "transcribing" || chat.streaming
            ? "thinking"
            : "idle";
  const stateNote = coreState === "listening" ? "Listening…" : coreState === "thinking" ? "Thinking…" : coreState === "speaking" ? "Speaking" : "";

  const runningTool = reply && chat.streaming ? [...(reply.tools ?? [])].reverse().find((t) => t.status === "running") : undefined;
  // The line under the core (which shows its own state word): what is happening right now, and how to go on.
  const step = booting
    ? ""
    : phase === "starting"
      ? "Starting the microphone…"
      : phase === "listening"
        ? "Listening · stops when you pause"
        : phase === "transcribing"
          ? "Turning speech into text…"
          : runningTool
            ? plainToolText(runningTool)
            : chat.streaming
              ? "Thinking…"
              : speaking
                ? "Speaking · tap the core to stop"
                : briefingReady
                  ? BRIEFING_TAP
                  : "";

  // The last two exchanges: the latest in full, the one before fading; older ones are gone.
  const exchanges = useMemo(() => {
    const list: Exchange[] = [];
    if (!booting) list.push({ key: "greeting", user: null, reply: null, text: greeting, tone: "normal" });
    let turn = 0;
    for (const m of chat.messages) {
      const current = list[list.length - 1];
      if (m.role === "user") list.push({ key: `turn-${turn++}`, user: m.content, reply: null, text: null, tone: "normal" });
      else if (current && current.key.startsWith("turn-") && !current.reply) current.reply = m;
      else list.push({ key: `turn-${turn++}`, user: null, reply: m, text: null, tone: "normal" });
    }
    if (flash) list.push({ key: `note-${flash.id}`, user: flash.user, reply: null, text: flash.text, tone: flash.tone });
    return list.slice(-2);
  }, [booting, greeting, chat.messages, flash]);
  const current = exchanges[exchanges.length - 1] ?? null;
  const previous = exchanges.length > 1 ? exchanges[0]! : null;

  const currentReply = current?.reply ?? null;
  const display = currentReply ? shownText(currentReply) : "";
  const sources = currentReply && !currentReply.streaming ? answerSources(currentReply.tools, display).shown : [];
  const labels = chipLabels(sources);
  const shortReply = !display.includes("\n") && display.length < 240;
  const cards = [...exchanges]
    .reverse()
    .flatMap((e) => e.reply?.tools ?? [])
    .flatMap((t) =>
      t.action ? [<GithubActionCard key={t.action.id} action={t.action} />] : t.google ? [<GoogleActionCard key={t.google.id} action={t.google} />] : [],
    );

  const viewStyle: CSSProperties | undefined = calm
    ? undefined
    : {
        transformOrigin: origin ? `${origin.x}px ${origin.y}px` : "calc(100% - 3rem) calc(100% - 3rem)",
        transform: closing ? "scale(0.1)" : entered ? "none" : "scale(0.92)",
        transition: closing ? `transform ${CLOSE_MS}ms cubic-bezier(0.4, 0, 1, 1)` : "transform 420ms cubic-bezier(0.16, 1, 0.3, 1)",
      };
  const wrapStyle: CSSProperties | undefined =
    closing && !calm ? { opacity: 0, transition: `opacity ${CLOSE_MS - 30}ms ease-in`, pointerEvents: "none" } : undefined;

  return (
    <div className="fixed inset-0 z-50" style={wrapStyle}>
      <div className="agent-dim absolute inset-0" aria-hidden="true" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="VESPER Agent"
        tabIndex={-1}
        className="agent-mode dark absolute inset-0 flex flex-col overflow-hidden outline-none"
        style={viewStyle}
      >
        <header className="relative z-10 flex shrink-0 items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 sm:pt-4">
          <span className="agent-hud-label">VESPER Agent</span>
          <span className="h-px min-w-0 flex-1 bg-[var(--ag-border)]" aria-hidden="true" />
          <button type="button" onClick={() => requestClose()} className={`${hudIcon} ${hudTone(false)}`} aria-label="Close VESPER Agent" title="Close (Esc)">
            <X size={18} />
          </button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden thin-scroll">
          <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col items-center justify-center gap-6 px-4 py-4 sm:px-6 lg:flex-row lg:gap-10">
            <section className="flex w-full min-w-0 max-w-2xl flex-col items-center text-center" aria-label="Conversation with VESPER">
              {previous ? (
                <div key={previous.key} className="mb-3 w-full max-w-xl space-y-0.5 text-[13px] leading-snug text-[var(--ag-text-soft)] opacity-45" aria-hidden="true">
                  {previous.user ? <p className="line-clamp-1 [overflow-wrap:anywhere]">{previous.user}</p> : null}
                  <p className="line-clamp-2 [overflow-wrap:anywhere]">{plainOf(previous)}</p>
                </div>
              ) : null}

              <div className="flex min-h-[1.75rem] w-full max-w-xl items-end justify-center">
                {current?.user ? (
                  <p key={current.key} className="agent-text-in line-clamp-3 text-[15px] leading-snug text-[var(--ag-text-soft)] [overflow-wrap:anywhere] sm:text-base">
                    {current.user}
                  </p>
                ) : null}
              </div>

              {/* aria-disabled rather than disabled, so the keyboard focus stays here while the state changes. */}
              <button
                type="button"
                onClick={onCore}
                aria-disabled={!coreAction}
                aria-label={coreAction ?? "VESPER Agent core"}
                title={coreAction ?? undefined}
                className="relative my-3 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ag-cyan)] aria-disabled:cursor-default"
                style={{ width: size, height: size }}
              >
                <LiveCore levels={levels} state={coreState} size={size} />
              </button>

              <p className="agent-hud-label min-h-[1.25rem]" aria-hidden="true">
                {step}
              </p>
              {localDefault && chat.messages.length === 0 && !booting ? (
                <p className="mt-1 max-w-md text-xs text-[var(--ag-text-soft)]">
                  VESPER Agent uses the cloud models (Auto): your default model runs on this computer and can't carry out tasks.
                </p>
              ) : null}

              {current && (current.text || currentReply?.content || currentReply?.error) ? (
                <div key={current.key} className="agent-text-in mt-4 flex w-full flex-col items-center gap-3">
                  {current.text ? (
                    <p
                      className={`max-w-xl text-lg leading-relaxed [overflow-wrap:anywhere] sm:text-xl ${
                        current.tone === "error" ? "text-[var(--ag-warn)]" : current.tone === "info" ? "text-[var(--ag-text-soft)]" : "text-[var(--ag-text)]"
                      }`}
                    >
                      {current.text}
                    </p>
                  ) : null}
                  {currentReply?.content ? (
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label="VESPER's reply"
                      className={`thin-scroll max-h-[32vh] w-full overflow-y-auto rounded-md px-1 text-[var(--ag-text)] focus-visible:outline-2 focus-visible:outline-[var(--ag-cyan)] [&_.md]:text-[17px]! sm:[&_.md]:text-[19px]! ${
                        shortReply ? "text-center" : "text-left"
                      }`}
                      style={replyAccent}
                    >
                      <Markdown text={display} />
                    </div>
                  ) : null}
                  {currentReply?.error ? <p className="max-w-xl text-sm text-[var(--ag-warn)] [overflow-wrap:anywhere]">{currentReply.error}</p> : null}
                  {currentReply?.tools?.some((t) => t.link) ? (
                    <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                      <WebsiteButtons tools={currentReply.tools} className={siteButton} />
                    </div>
                  ) : null}

                  {sources.length || (currentReply && chat.conversationId) ? (
                    <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                      {sources.length ? (
                        <span className="flex max-w-full flex-wrap items-center justify-center gap-1.5" aria-label="Sources">
                          {sources.slice(0, MAX_CHIPS).map((s, i) =>
                            s.url ? (
                              <a key={`${s.url}|${s.location ?? ""}`} href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={`${s.title}\n${s.url}`} className={chip}>
                                <span className="truncate">{labels[i]}</span>
                              </a>
                            ) : (
                              <span key={`doc:${s.title}|${s.location ?? ""}`} title={s.location ? `${s.title}, ${s.location}` : s.title} className={chip}>
                                <span className="truncate">{labels[i]}</span>
                              </span>
                            ),
                          )}
                          {sources.length > MAX_CHIPS ? <span className="text-[11px] text-[var(--ag-text-soft)]">+{sources.length - MAX_CHIPS} more in the chat</span> : null}
                        </span>
                      ) : null}
                      {currentReply && chat.conversationId ? (
                        <button type="button" onClick={openInChat} className={chip}>
                          <MessageSquareText size={12} aria-hidden="true" /> Open in chat
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            {cards.length ? (
              <aside
                ref={cardsPanel}
                tabIndex={-1}
                className="agent-panel dark flex w-full max-w-md shrink-0 flex-col gap-3 p-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--ag-cyan)] lg:max-h-full lg:w-[400px] lg:overflow-y-auto thin-scroll"
                aria-label="For your approval"
              >
                <p className="agent-hud-label">For your approval</p>
                {cards}
              </aside>
            ) : null}
          </div>
        </div>

        <form onSubmit={onSubmit} className="relative z-10 shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pb-5">
          <div className="agent-panel mx-auto flex w-full max-w-3xl items-center gap-1 px-1.5 py-1.5 has-[.agent-field:focus]:outline-1 has-[.agent-field:focus]:outline-[var(--ag-cyan)]">
            {sttOn ? (
              <>
                {/* aria-disabled while the microphone starts or the words are recognised, so the focus stays on it. */}
                <button
                  type="button"
                  onClick={onMic}
                  aria-disabled={phase === "starting" || phase === "transcribing"}
                  className={`${hudIcon} ${hudTone(phase === "listening")} aria-disabled:opacity-40`}
                  aria-label={micLabel}
                  title={phase === "idle" ? `Speak (up to ${maxSeconds} seconds)` : micLabel}
                >
                  {phase === "listening" ? <Square size={14} fill="currentColor" /> : <Mic size={18} />}
                </button>
                <button
                  type="button"
                  onClick={toggleHandsFree}
                  aria-pressed={handsFree}
                  className={`${hudBase} gap-1.5 px-2.5 text-[13px] ${hudTone(handsFree)}`}
                  title="Hands-free: VESPER listens again after each answer"
                >
                  <AudioLines size={17} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Hands-free</span>
                </button>
              </>
            ) : null}
            <input
              ref={field}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={MAX_CHARS}
              enterKeyHint="send"
              autoComplete="off"
              placeholder={sttOn ? "Type, or tap the mic…" : "Type a message…"}
              aria-label="Message VESPER"
              className="agent-field min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[16px] text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-text-soft)] sm:text-[15px]"
            />
            {chat.streaming ? (
              <button type="button" onClick={stopReply} className={`${hudIcon} ${hudTone(false)}`} aria-label="Stop the reply" title="Stop">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || phase === "starting" || phase === "transcribing"}
                className={`${hudIcon} text-[var(--ag-cyan)]`}
                aria-label="Send message"
                title="Send (Enter)"
              >
                <ArrowUp size={18} strokeWidth={2.4} />
              </button>
            )}
            {ttsOn ? (
              <>
                <button
                  ref={menuButton}
                  type="button"
                  onClick={() => {
                    void voice.unlock();
                    setMenuOpen((open) => !open);
                  }}
                  aria-haspopup="dialog"
                  aria-expanded={menuOpen}
                  aria-controls={menuOpen ? "agent-voice-menu" : undefined}
                  className={`${hudIcon} ${voiceOut ? "text-[var(--ag-cyan)]" : "text-[var(--ag-text-soft)]"}`}
                  aria-label="Voice"
                  title={voiceOut ? `Voice: ${voiceLabel}` : "Voice replies are off"}
                >
                  {voiceOut ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
                {menuOpen ? (
                  <div
                    ref={menu}
                    id="agent-voice-menu"
                    role="dialog"
                    aria-label="VESPER's voice"
                    className="agent-panel absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-1.5rem)] p-3 text-left"
                  >
                    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-[var(--ag-text)]">
                      Voice replies
                      <input
                        type="checkbox"
                        role="switch"
                        checked={voiceOut}
                        onChange={toggleVoiceOut}
                        className="h-4 w-4 accent-[var(--ag-cyan)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ag-cyan)]"
                      />
                    </label>
                    <fieldset className="mt-3 min-w-0 border-t border-[var(--ag-border)] pt-2">
                      <legend className="agent-hud-label pr-2">Voice</legend>
                      <div className="thin-scroll mt-1 max-h-[min(40vh,260px)] space-y-0.5 overflow-y-auto pr-1">
                        {studio ? (
                          <VoiceOption
                            value="studio"
                            checked={selectedVoice === "studio"}
                            title={`Studio voice (${speakerLabel(studio.speaker)})`}
                            note={
                              studioIssue === "limit"
                                ? "Today's limit is used up: the device voice speaks until 00:00 UTC"
                                : studioIssue === "off"
                                  ? "Not available right now: the device voice speaks instead"
                                  : "Natural voice from Cloudflare · daily limit"
                            }
                            onChoose={chooseVoice}
                          />
                        ) : null}
                        {rankedVoices.map((v, i) => (
                          <VoiceOption
                            key={`${v.name}|${v.lang}|${i}`}
                            value={v.name}
                            checked={selectedVoice === v.name}
                            title={v.name}
                            note={i === 0 ? `${v.lang} · Recommended` : v.lang}
                            onChoose={chooseVoice}
                          />
                        ))}
                        {rankedVoices.length === 0 && !studio ? (
                          <p className="px-2 py-1.5 text-xs text-[var(--ag-text-soft)]">This device has no voices to choose from.</p>
                        ) : null}
                      </div>
                    </fieldset>
                    <button type="button" onClick={testVoice} disabled={phase !== "idle"} className={`${chip} mt-3 disabled:opacity-40`}>
                      <Volume2 size={12} aria-hidden="true" /> Test
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </form>

        <p className="sr-only" role="status">
          {stateNote}
        </p>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {replyNote}
        </p>
      </div>
    </div>
  );
}
