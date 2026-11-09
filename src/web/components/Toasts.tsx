import { X } from "lucide-react";

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3" aria-live="assertive">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg ${
            t.kind === "error"
              ? "border-[var(--danger)]/30 bg-[var(--bg)] text-[var(--danger)]"
              : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button type="button" onClick={() => onDismiss(t.id)} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
