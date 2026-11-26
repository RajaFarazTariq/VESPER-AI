import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
  /**
   * A button in the toast, e.g. "Undo" after archiving a chat (v0.19.0). Pressing it also closes the toast. Such a
   * toast closes itself after 10 seconds, counted only while it isn't pointed at or focused.
   */
  action?: { label: string; run: () => void };
}

const ACTION_MS = 10_000;

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3" aria-live="assertive">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const left = useRef(ACTION_MS);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const timed = Boolean(t.action);
  const paused = hovered || focused;

  // Toasts with a button: the time left runs only while the toast isn't pointed at or focused.
  useEffect(() => {
    if (!timed || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1500, left.current - (Date.now() - started));
    };
  }, [timed, paused]);

  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg ${
        t.kind === "error" ? "border-[var(--danger)]/30 bg-[var(--bg)] text-[var(--danger)]" : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
      }`}
    >
      <span className="flex-1">{t.message}</span>
      {t.action ? (
        <button
          type="button"
          onClick={() => {
            onDismiss();
            t.action!.run();
          }}
          className="-my-1 shrink-0 rounded-md px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)]"
        >
          {t.action.label}
        </button>
      ) : null}
      <button type="button" onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}
