import { ArrowUp, AudioLines, MessageSquareText, Mic, Square, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { AUTO_MODEL, type ConversationDto, type FeaturesDto, type UserSettings } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { useChat, type UiMessage } from "../hooks/useChat";
import { agentGreeting, loudness, nextSentences, SilenceDetector, speechChunks, type ListenVerdict } from "../lib/agent-voice";
import { answerSources, chipLabels, githubLineLinks, plainDocumentLinks, tidyCitations } from "../lib/format";
import { canRecord, canSpeak, RecordingError, speakableText, stopSpeaking, type Recording } from "../lib/voice";
import { AgentCore, type AgentCoreState } from "./AgentCore";
import { GithubActionCard } from "./GithubActionCard";
import { GoogleActionCard } from "./GoogleActionCard";
import { Markdown } from "./Markdown";
import { plainToolText } from "./ToolActivity";

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
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

// ------------------------------------------------------------------ VESPER's voice (the device's built-in voices)

const URDU = /[؀-ۿ]/;

/**
 * Sentences spoken one after another while the reply is still being written. Starting stops the chat's Read aloud
 * (and Read aloud stops this, since it cancels the device's speech). `onChange` says whether it is talking.
 */
class AgentVoice {
  private run = 0;
  private readonly queued = new Set<SpeechSynthesisUtterance>();
  /** Looks whether the device still talks: speech cancelled elsewhere, or that never started, may send no events. */
  private watch: ReturnType<typeof setInterval> | null = null;
  private quietSince: number | null = null;

  constructor(private readonly onChange: (speaking: boolean) => void) {}

  get speaking(): boolean {
    return this.queued.size > 0;
  }

  say(markdown: string): void {
    if (!canSpeak()) return;
    const text = speakableText(markdown);
    const parts = speechChunks(text);
    if (parts.length === 0) return;
    if (this.queued.size === 0) stopSpeaking();
    const run = this.run;
    const urdu = URDU.test(text);
    const voice = urdu ? window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("ur")) : undefined;
    for (const part of parts) {
      const u = new SpeechSynthesisUtterance(part);
      if (urdu) u.lang = voice?.lang ?? "ur-PK";
      if (voice) u.voice = voice;
      // Kept in the set until it ends: some browsers drop the end event of an utterance nothing refers to.
      const done = () => {
        if (run !== this.run || !this.queued.delete(u)) return;
        if (this.queued.size === 0) this.finish();
      };
      u.onend = done;
      u.onerror = done;
      this.queued.add(u);
      window.speechSynthesis.speak(u);
    }
    this.onChange(true);
    this.watchQuiet();
  }

  stop(): void {
    const was = this.queued.size > 0;
    if (was && canSpeak()) window.speechSynthesis.cancel();
    this.finish(was);
  }

  /** Nothing more to say: forget the queue (events of what was queued are ignored from now on). */
  private finish(changed = true): void {
    this.run++;
    this.queued.clear();
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
    if (changed) this.onChange(false);
  }

  /** Silent for about a second while sentences are still queued: they won't be spoken, so the voice is done. */
  private watchQuiet(): void {
    if (this.watch !== null) return;
    this.quietSince = null;
    this.watch = setInterval(() => {
      if (this.queued.size === 0) return this.finish(false);
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) {
        this.quietSince = null;
        return;
      }
      const now = Date.now();
      this.quietSince ??= now;
      if (now - this.quietSince >= 1000) this.finish();
    }, 500);
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
  return <AgentCore state={state} level={state === "listening" ? level : 0} size={size} />;
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
}

/**
 * VESPER Agent (v0.17.0): a full-screen mode over the chat. Talk or type; the core shows whether VESPER is listening,
 * thinking or speaking; your words and the reply float around it. Its conversations are normal saved chats (its own
 * chat state, so the normal chat stays as it was). Outward actions keep their Approve cards.
 */
export function AgentMode({ firstName, settings, features, origin, onClose, onOpenInChat, onConversationCreated, onConversationActivity }: AgentModeProps) {
  const [calm] = useState(prefersCalm);
  const [booting, setBooting] = useState(!calm);
  const [greeting] = useState(() => agentGreeting(firstName));
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
  const size = useCoreSize();

  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const cardsPanel = useRef<HTMLElement>(null);
  const listener = useRef<AgentListener | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const closingRef = useRef(false);
  const alive = useRef(true);
  const [levels] = useState(levelStore);
  const [voice] = useState(() => new AgentVoice(setSpeaking));
  /** The turn being spoken: which one (counted by your messages), how much of its reply was handed to the voice. */
  const spoken = useRef({ turn: -1, upTo: 0, muted: false });
  /** Hands-free: listen again once this turn's reply has been written and spoken. */
  const listenAfterTurn = useRef(false);
  /** Words that arrived while the previous reply was still being written: sent once it has stopped. */
  const pendingSend = useRef<string | null>(null);
  const lastSent = useRef("");
  const wasStreaming = useRef(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sttOn = Boolean(features?.voice.speechToText) && canRecord();
  const ttsOn = Boolean(features?.voice.enabled) && canSpeak();
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

  /** Speak, unless voice replies are off, the microphone is on or the view is closing. */
  const say = (text: string) => {
    const l = live.current;
    if (l.voiceOut && l.ttsOn && phaseRef.current === "idle" && !closingRef.current) voice.say(text);
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

  const sendText = (raw: string): boolean => {
    const text = raw.trim();
    const c = live.current.chat;
    if (!text || closingRef.current) return false;
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
    spoken.current = { turn: live.current.userCount + 1, upTo: 0, muted: false };
    listenAfterTurn.current = true;
    lastSent.current = text;
    void c.send(text, live.current.model).then((accepted) => {
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
      voice.stop();
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [voice]);

  // Boot-up, then the greeting (at once when the system asks for reduced motion).
  useEffect(() => {
    const greet = () => {
      setBooting(false);
      setReplyNote(greeting);
      if (phaseRef.current === "idle" && live.current.chat.messages.length === 0) say(greeting);
    };
    if (calm) {
      greet();
      return () => voice.stop();
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

  // Focus moves into the view: the text field (on touch screens the view itself, so the keyboard doesn't cover the core).
  useEffect(() => {
    if (finePointer()) field.current?.focus({ preventScroll: true });
    else dialog.current?.focus({ preventScroll: true });
  }, []);

  // Esc closes; Tab stays inside the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
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
    if (!s.muted) for (const sentence of sentences) say(sentence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyContent, replyDone, userCount]);

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
    if (phaseRef.current === "listening") void finishListening("done");
    else if (phaseRef.current === "idle") void startListening();
  };

  /** Tapping the core: stops VESPER talking; while listening, ends your turn; otherwise starts listening. */
  const coreAction = speaking
    ? "Stop speaking"
    : phase === "listening"
      ? "Stop listening and send"
      : phase === "idle" && sttOn && !booting && !chat.streaming
        ? "Start listening"
        : null;
  const onCore = () => {
    if (voice.speaking) {
      voice.stop();
      spoken.current.muted = true;
      listenAfterTurn.current = false;
    } else if (phaseRef.current === "listening") void finishListening("done");
    else if (phaseRef.current === "idle" && sttOn && !booting && !live.current.chat.streaming) void startListening();
  };

  const toggleVoiceOut = () => {
    const next = !voiceOut;
    setVoiceOut(next);
    saveVoiceOut(next);
    if (!next) {
      voice.stop();
      spoken.current.muted = true;
    }
  };

  const toggleHandsFree = () => {
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
          <div className="agent-panel mx-auto flex w-full max-w-3xl items-center gap-1 px-1.5 py-1.5 has-[input:focus]:outline-1 has-[input:focus]:outline-[var(--ag-cyan)]">
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
              className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[16px] text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-text-soft)] sm:text-[15px]"
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
              <button
                type="button"
                onClick={toggleVoiceOut}
                aria-pressed={voiceOut}
                className={`${hudIcon} ${voiceOut ? "text-[var(--ag-cyan)]" : "text-[var(--ag-text-soft)]"}`}
                aria-label="Voice replies"
                title={voiceOut ? "Voice replies are on (click to mute)" : "Voice replies are off (click to turn on)"}
              >
                {voiceOut ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
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
