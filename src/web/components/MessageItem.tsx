import { AlertTriangle, Brain, ChevronDown, Info, Pencil, RotateCcw, Square, Volume2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { UiMessage } from "../hooks/useChat";
import { citedSources, plainDocumentLinks, providerLabel, tidyCitations } from "../lib/format";
import { canSpeak, speak, stopSpeaking, useSpeakingId } from "../lib/voice";
import { CopyButton, Markdown } from "./Markdown";
import { collectSources, SourceList, ToolActivity } from "./ToolActivity";

interface Props {
  message: UiMessage;
  isLast: boolean;
  canRetry: boolean;
  onRetry: () => void;
  /** Admins see technical details (tool inputs, provider/model). The server also filters for users. */
  isAdmin?: boolean;
  /** Only the last message you sent can be edited (the reply after it is replaced). */
  canEdit?: boolean;
  onEdit?: (text: string) => Promise<boolean>;
  /** Show "Read aloud" on answers (the admin's Voice switch). */
  readAloud?: boolean;
}

const actionButton =
  "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]";

export const MessageItem = memo(function MessageItem({
  message,
  isLast,
  canRetry,
  onRetry,
  isAdmin = false,
  canEdit = false,
  onEdit,
  readAloud = false,
}: Props) {
  if (message.role === "user") return <UserMessage message={message} canEdit={canEdit} onEdit={onEdit} />;

  const working = message.streaming && !message.content;
  const runningTool = message.tools?.some((t) => t.status === "running");
  const failed = message.status === "error" || message.status === "partial";
  const allSources = collectSources(message.tools);
  const documentTitles = allSources.filter((s) => !s.url).map((s) => s.title);
  const content = plainDocumentLinks(tidyCitations(message.content), documentTitles);
  const sources = message.streaming ? [] : citedSources(allSources, content);

  return (
    <div className="rise-in group flex gap-3 sm:gap-4">
      <img src="/favicon.svg" alt="" className="mt-0.5 h-7 w-7 shrink-0 rounded-lg shadow-[var(--shadow-sm)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {message.notices?.map((notice, i) => (
          <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>{notice}</span>
          </div>
        ))}

        {message.reasoning ? <Reasoning text={message.reasoning} streaming={Boolean(message.streaming && !message.content)} /> : null}

        {message.tools?.length ? <ToolActivity tools={message.tools} plain={!isAdmin} /> : null}

        {working && !runningTool && !message.reasoning ? (
          <div className="flex h-7 items-center gap-2 text-sm" role="status">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
            </span>
            <span className="shimmer-text font-medium">{isAdmin && message.provider ? `Asking ${providerLabel(message.provider)}…` : "Thinking…"}</span>
          </div>
        ) : message.content ? (
          <div className={message.streaming ? "streaming-caret" : undefined}>
            <Markdown text={content} />
          </div>
        ) : null}

        <SourceList sources={sources} />

        {failed && message.error ? (
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-[var(--danger)]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{message.error}</span>
            </div>
            {canRetry && isLast ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
              >
                <RotateCcw size={13} /> Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {!message.streaming && (message.content || message.provider) ? (
          <div
            className={`-ml-2 flex flex-wrap items-center gap-0.5 transition-opacity ${
              isLast ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            }`}
          >
            {message.content ? <CopyButton text={content} /> : null}
            {readAloud && message.content && canSpeak() ? <ReadAloudButton id={message.id} text={content} /> : null}
            {canRetry && isLast && !failed ? (
              <button type="button" onClick={onRetry} className={actionButton} title="Regenerate">
                <RotateCcw size={14} />
                <span className="sr-only sm:not-sr-only">Regenerate</span>
              </button>
            ) : null}
            {message.provider ? (
              <span className="ml-1 truncate text-xs text-[var(--text-faint)]" title={`${message.provider}:${message.model}`}>
                {providerLabel(message.provider)} · {message.model}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function UserMessage({ message, canEdit, onEdit }: { message: UiMessage; canEdit: boolean; onEdit?: (text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing || !box.current) return;
    const el = box.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft, editing]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !onEdit) return;
    setEditing(false);
    if (text === message.content.trim()) return;
    const ok = await onEdit(text);
    if (!ok) setDraft(message.content);
  };

  if (editing) {
    return (
      <div className="rise-in ml-auto w-full max-w-[85%]">
        <div className="rounded-3xl border border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[var(--bg-elevated)] p-3 shadow-[var(--shadow-md)]">
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(message.content);
              }
            }}
            aria-label="Edit your message"
            className="block w-full resize-none bg-transparent px-1 leading-relaxed outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(message.content);
              }}
              className="rounded-full px-3.5 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim()}
              className="rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rise-in group flex flex-col items-end gap-1">
      {message.images?.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Attached image ${i + 1}`}
              className="h-32 w-32 rounded-xl border border-[var(--border)] object-cover sm:h-36 sm:w-36"
            />
          ))}
        </div>
      ) : null}
      {message.content ? (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-lg bg-[var(--user-bubble)] px-4 py-2.5 text-[15px] leading-relaxed">
          {message.content}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {message.content ? <CopyButton text={message.content} /> : null}
        {canEdit && onEdit ? (
          <button
            type="button"
            onClick={() => {
              setDraft(message.content);
              setEditing(true);
            }}
            className={actionButton}
            title="Edit and resend"
          >
            <Pencil size={13} />
            <span className="sr-only sm:not-sr-only">Edit</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Reads the answer with the device's built-in voice; press again to stop. */
function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const speaking = useSpeakingId() === id;
  return (
    <button
      type="button"
      onClick={() => (speaking ? stopSpeaking() : speak(id, text))}
      className={actionButton}
      title={speaking ? "Stop reading" : "Read aloud"}
      aria-pressed={speaking}
    >
      {speaking ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />}
      <span className="sr-only sm:not-sr-only">{speaking ? "Stop" : "Read aloud"}</span>
    </button>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--text-soft)] hover:text-[var(--text)]"
        aria-expanded={open}
      >
        <Brain size={14} className="text-[var(--accent)]" />
        <span className={streaming ? "shimmer-text font-medium" : ""}>{streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronDown size={14} className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[var(--border)] px-3 py-2 text-xs leading-relaxed text-[var(--text-soft)] thin-scroll">
          {text}
        </div>
      ) : null}
    </div>
  );
}
