import { ArrowUp, Check, LoaderCircle, Mic, Paperclip, Settings2, Square, Telescope, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { SpeechLanguage, ToolInfoDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { useMenuLayout } from "../hooks/useMenuLayout";
import { imageFiles, type PendingImage } from "../lib/images";
import { canRecord, RecordingError, VoiceRecorder } from "../lib/voice";
import { TOOL_ICONS } from "./ToolActivity";

const MAX_CHARS = 32_000;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** "hero": large, centred on the welcome screen. "docked": at the bottom of a conversation. */
  variant?: "hero" | "docked";
  /** Controls shown at the bottom-left inside the box (model picker, tools). */
  controls?: ReactNode;
  autoFocus?: boolean;
  /** Images waiting to be sent. Omit to hide the attach button (images switched off). */
  attachments?: {
    items: PendingImage[];
    /** Images still being resized. */
    preparing: number;
    max: number;
    onAdd: (files: File[]) => void;
    onRemove: (id: string) => void;
  };
  /** Microphone button: the recognised text is added to the message box. Omit to hide it. */
  voice?: { maxSeconds: number; language: SpeechLanguage; onError: (message: string) => void };
}

const iconButton =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  variant = "docked",
  controls,
  autoFocus,
  attachments,
  voice,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const hero = variant === "hero";
  const valueRef = useRef(value);
  valueRef.current = value;

  // Auto-grow up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (!streaming && (autoFocus ?? true)) ref.current?.focus();
  }, [streaming, autoFocus]);

  const images = attachments?.items ?? [];
  const preparing = attachments?.preparing ?? 0;
  const tooLong = value.length > MAX_CHARS;
  const hasContent = value.trim().length > 0 || images.length > 0;
  const canSend = !streaming && !disabled && hasContent && !tooLong && preparing === 0 && !micBusy;
  const full = images.length + preparing >= (attachments?.max ?? 0);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachments) return;
    const files = imageFiles(e.clipboardData.files);
    if (files.length === 0) return;
    attachments.onAdd(files);
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const dropHandlers = attachments
    ? {
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          const files = imageFiles(e.dataTransfer.files);
          if (files.length > 0) attachments.onAdd(files);
        },
      }
    : {};

  const addText = (text: string) => {
    const current = valueRef.current;
    onChange(current.trim() ? `${current.trimEnd()} ${text}` : text);
    ref.current?.focus();
  };

  return (
    <div className={hero ? "w-full" : "mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 sm:pb-4"}>
      <div
        {...dropHandlers}
        className={`rounded-[26px] border bg-[var(--bg-elevated)] transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] ${
          dragging ? "border-[var(--accent)]" : "border-[var(--border)]"
        } ${hero ? "shadow-[var(--shadow-lg)]" : "shadow-[var(--shadow-md)]"}`}
      >
        {images.length > 0 || preparing > 0 ? (
          <ul className="flex flex-wrap gap-2 px-4 pt-3" aria-label="Attached images">
            {images.map((img, i) => (
              <li key={img.id} className="relative">
                <img src={img.thumb} alt={`Attached image ${i + 1}`} className="h-16 w-16 rounded-lg border border-[var(--border)] object-cover" />
                <button
                  type="button"
                  onClick={() => attachments?.onRemove(img.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-soft)] shadow-[var(--shadow-sm)] hover:text-[var(--text)]"
                  aria-label={`Remove image ${i + 1}`}
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            {Array.from({ length: preparing }, (_, i) => (
              <li key={`preparing-${i}`} className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-[var(--border)]" role="status">
                <LoaderCircle size={16} className="animate-spin text-[var(--text-faint)]" />
                <span className="sr-only">Preparing image…</span>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={ref}
          rows={hero ? 2 : 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={dragging ? "Drop images to attach" : (placeholder ?? "Send a message…")}
          aria-label="Message"
          className={`block w-full resize-none bg-transparent px-5 leading-relaxed outline-none placeholder:text-[var(--text-faint)] thin-scroll ${
            hero ? "max-h-60 min-h-[56px] pt-4 text-[16px]" : "max-h-60 min-h-[28px] pt-3.5 text-[15px]"
          }`}
          disabled={disabled}
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          {attachments ? (
            <>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={disabled || full}
                className={iconButton}
                aria-label="Attach images"
                title={full ? `Up to ${attachments.max} images per message` : `Attach images (up to ${attachments.max})`}
              >
                <Paperclip size={17} />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = imageFiles(e.target.files);
                  e.target.value = "";
                  if (files.length > 0) attachments.onAdd(files);
                }}
              />
            </>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-1">{controls}</div>
          {voice && canRecord() ? (
            <MicButton {...voice} disabled={Boolean(disabled) || streaming} onBusy={setMicBusy} onText={addText} />
          ) : null}
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--bg)] transition-transform hover:scale-105"
              aria-label="Stop generating"
              title="Stop"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-text)] shadow-[var(--shadow-sm)] transition-[transform,opacity,background-color] hover:bg-[var(--accent-strong)] enabled:hover:scale-105 disabled:opacity-25"
              aria-label="Send message"
              title="Send (Enter)"
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <p className={`mt-2 px-2 text-center text-[11.5px] text-[var(--text-faint)] ${hero ? "hidden" : ""}`}>
        {tooLong ? (
          <span className="text-[var(--danger)]">
            Message is {value.length.toLocaleString()} characters; the limit is {MAX_CHARS.toLocaleString()}.
          </span>
        ) : (
          "Vesper uses free AI models and can make mistakes. Check important information."
        )}
      </p>
      {hero && tooLong ? (
        <p className="mt-2 text-center text-xs text-[var(--danger)]">
          Message is {value.length.toLocaleString()} characters; the limit is {MAX_CHARS.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Record → speech to text on the server → the text appears in the message box to check before sending. */
function MicButton({
  maxSeconds,
  language,
  disabled,
  onError,
  onBusy,
  onText,
}: {
  maxSeconds: number;
  language: SpeechLanguage;
  disabled: boolean;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
  onText: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<VoiceRecorder | null>(null);

  useEffect(() => onBusy(state !== "idle"), [state, onBusy]);
  useEffect(() => () => recorder.current?.cancel(), []);
  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setElapsed(recorder.current?.elapsedSeconds ?? 0), 250);
    return () => clearInterval(id);
  }, [state]);

  const finish = async () => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    setState("transcribing");
    try {
      const recording = await active.stop();
      if (recording.seconds < 0.5) throw new RecordingError("That was too short. Hold on a moment longer and speak.");
      const { text } = await api.transcribe({ audio: recording.base64, mimeType: recording.mimeType, seconds: recording.seconds, language });
      if (text.trim()) onText(text.trim());
      else onError("I didn't catch any speech. Please try again.");
    } catch (e) {
      onError(e instanceof RecordingError || e instanceof ApiError ? e.message : "Voice input didn't work. Please try again.");
    } finally {
      setState("idle");
    }
  };

  const start = async () => {
    setState("starting");
    setElapsed(0);
    try {
      recorder.current = await VoiceRecorder.start(maxSeconds, () => void finish());
      setState("recording");
    } catch (e) {
      recorder.current = null;
      setState("idle");
      onError(e instanceof RecordingError ? e.message : "Couldn't start the microphone.");
    }
  };

  const cancel = () => {
    recorder.current?.cancel();
    recorder.current = null;
    setState("idle");
  };

  if (state === "recording") {
    return (
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--danger)]/10 py-0.5 pl-3 pr-0.5" role="status" aria-live="polite">
        <span className="relative mr-1 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--danger)] opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--danger)]" />
        </span>
        <span className="w-10 text-xs tabular-nums text-[var(--danger)]" aria-label={`Recording, ${Math.floor(elapsed)} seconds`}>
          {clock(elapsed)}
        </span>
        <button type="button" onClick={cancel} className={iconButton} aria-label="Cancel recording" title="Cancel">
          <X size={16} />
        </button>
        <button type="button" onClick={() => void finish()} className={iconButton} aria-label="Stop and turn speech into text" title="Done">
          <Check size={17} />
        </button>
      </div>
    );
  }
  const busy = state !== "idle";
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled || busy}
      className={iconButton}
      aria-label={state === "transcribing" ? "Turning speech into text" : "Speak your message"}
      title={state === "transcribing" ? "Turning speech into text…" : `Speak (up to ${Math.round(maxSeconds / 60)} min)`}
    >
      {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Mic size={17} />}
    </button>
  );
}

/**
 * "Research" switch inside the composer: the next message becomes a deep-research request (several searches, a few
 * pages read, a written brief with sources). Turns itself off after sending.
 */
export function ResearchToggle({ on, onChange, runsPerDay }: { on: boolean; onChange: (on: boolean) => void; runsPerDay: number }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] transition-colors ${
        on
          ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
          : "text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
      }`}
      title={
        on
          ? "Deep research is on for the next message. Click to turn it off."
          : `Deep research: several searches, pages read, a report with sources (${runsPerDay} a day)`
      }
    >
      <Telescope size={14} />
      <span>Research</span>
      {on ? <X size={12} aria-hidden /> : null}
    </button>
  );
}

/** Small "Tools" button inside the composer: what the assistant can use right now, and where to change it. */
export function ToolsButton({ tools, onManage }: { tools: ToolInfoDto[] | null; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Fits the space on screen (opens upward; downward when there's more room below) and scrolls inside when the list
  // is long, so the top of the list is never cut off.
  const layout = useMenuLayout(root, open, "up", 280);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tools === null) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Tools the assistant can use"
      >
        <Wrench size={14} />
        <span>Tools</span>
        {tools.length > 0 ? (
          <span className="rounded-full bg-[var(--accent-soft)] px-1.5 text-[11px] font-semibold text-[var(--accent)]">{tools.length}</span>
        ) : (
          <span className="text-[11px]">off</span>
        )}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Active tools"
          className={`absolute left-0 z-30 flex w-72 max-w-[85vw] flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-lg)] ${
            layout.up ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          style={{ maxHeight: layout.maxHeight }}
        >
          <div className="shrink-0 px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            {tools.length > 0 ? "The assistant can use" : "Tools are switched off"}
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto thin-scroll">
            {tools.map((t) => {
              const Icon = TOOL_ICONS[t.name] ?? Wrench;
              return (
                <li key={t.name} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Icon size={14} />
                  </span>
                  {t.label}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className="mt-1 flex w-full shrink-0 items-center gap-2 rounded-lg border-t border-[var(--border)] px-2 py-2 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <Settings2 size={15} /> Manage tools
          </button>
        </div>
      ) : null}
    </div>
  );
}
