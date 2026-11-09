import { AlertTriangle, Brain, ChevronDown, Info, RotateCcw } from "lucide-react";
import { memo, useState } from "react";
import type { UiMessage } from "../hooks/useChat";
import { providerLabel } from "../lib/format";
import { CopyButton, Markdown } from "./Markdown";

interface Props {
  message: UiMessage;
  isLast: boolean;
  canRetry: boolean;
  onRetry: () => void;
}

export const MessageItem = memo(function MessageItem({ message, isLast, canRetry, onRetry }: Props) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--bg-soft)] px-4 py-2.5 leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  const waiting = message.streaming && !message.content && !message.reasoning;
  const failed = message.status === "error" || message.status === "partial";

  return (
    <div className="group flex flex-col gap-2">
      {message.notices?.map((notice, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      ))}

      {message.reasoning ? <Reasoning text={message.reasoning} streaming={Boolean(message.streaming && !message.content)} /> : null}

      {waiting ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-soft)]" role="status">
          <span className="inline-flex gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
          </span>
          {message.provider ? `Asking ${providerLabel(message.provider)}…` : "Thinking…"}
        </div>
      ) : message.content ? (
        <div className={message.streaming ? "streaming-caret" : undefined}>
          <Markdown text={message.content} />
        </div>
      ) : null}

      {failed && message.error ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2 text-[var(--danger)]">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{message.error}</span>
          </div>
          {canRetry && isLast ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
            >
              <RotateCcw size={13} /> Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {!message.streaming && (message.content || message.provider) ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-[var(--text-soft)] opacity-80 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          {message.content ? <CopyButton text={message.content} /> : null}
          {canRetry && isLast && !failed ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              title="Regenerate"
            >
              <RotateCcw size={14} />
              <span className="sr-only sm:not-sr-only">Regenerate</span>
            </button>
          ) : null}
          {message.provider ? (
            <span className="ml-1 truncate" title={`${message.provider}:${message.model}`}>
              {providerLabel(message.provider)} · {message.model}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--border)] text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--text-soft)] hover:text-[var(--text)]"
        aria-expanded={open}
      >
        <Brain size={14} />
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
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
