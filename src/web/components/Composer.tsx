import { ArrowUp, Settings2, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ToolInfoDto } from "../../shared/types";
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
}

export function Composer({ value, onChange, onSend, onStop, streaming, disabled, placeholder, variant = "docked", controls, autoFocus }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hero = variant === "hero";

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

  const tooLong = value.length > MAX_CHARS;
  const canSend = !streaming && !disabled && value.trim().length > 0 && !tooLong;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className={hero ? "w-full" : "mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 sm:pb-4"}>
      <div
        className={`rounded-[26px] border border-[var(--border)] bg-[var(--bg-elevated)] transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] ${
          hero ? "shadow-[var(--shadow-lg)]" : "shadow-[var(--shadow-md)]"
        }`}
      >
        <textarea
          ref={ref}
          rows={hero ? 2 : 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "Send a message…"}
          aria-label="Message"
          className={`block w-full resize-none bg-transparent px-5 leading-relaxed outline-none placeholder:text-[var(--text-faint)] thin-scroll ${
            hero ? "max-h-60 min-h-[56px] pt-4 text-[16px]" : "max-h-60 min-h-[28px] pt-3.5 text-[15px]"
          }`}
          disabled={disabled}
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-1">{controls}</div>
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

/** Small "Tools" button inside the composer: what the assistant can use right now, and where to change it. */
export function ToolsButton({ tools, onManage }: { tools: ToolInfoDto[] | null; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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
          className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-lg)]"
        >
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            {tools.length > 0 ? "The assistant can use" : "Tools are switched off"}
          </div>
          <ul className="space-y-0.5">
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
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <Settings2 size={15} /> Manage tools
          </button>
        </div>
      ) : null}
    </div>
  );
}
