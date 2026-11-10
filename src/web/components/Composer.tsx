import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

const MAX_CHARS = 32_000;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({ value, onChange, onSend, onStop, streaming, disabled, placeholder }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  const tooLong = value.length > MAX_CHARS;
  const canSend = !streaming && !disabled && value.trim().length > 0 && !tooLong;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="flex items-end gap-2 rounded-3xl border border-[var(--border)] bg-[var(--bg)] p-2 pl-4 shadow-sm focus-within:border-[var(--accent)]/60">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "Send a message…"}
          aria-label="Message"
          className="max-h-60 min-h-[28px] flex-1 resize-none bg-transparent py-1.5 leading-relaxed outline-none placeholder:text-[var(--text-soft)] thin-scroll"
          disabled={disabled}
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
            aria-label="Stop generating"
            title="Stop"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-text)] transition-opacity disabled:opacity-30"
            aria-label="Send message"
            title="Send (Enter)"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <p className="mt-1.5 px-2 text-center text-[11px] text-[var(--text-soft)]">
        {tooLong ? (
          <span className="text-[var(--danger)]">
            Message is {value.length.toLocaleString()} characters; the limit is {MAX_CHARS.toLocaleString()}.
          </span>
        ) : (
          "Free AI models can make mistakes. Check important information. Shift+Enter for a new line."
        )}
      </p>
    </div>
  );
}
