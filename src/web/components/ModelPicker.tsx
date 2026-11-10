import { Check, ChevronDown, Cpu, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelsResponse } from "../../shared/types";
import { formatRelative, selectionLabel } from "../lib/format";

interface Props {
  value: string;
  onChange: (value: string) => void;
  models: ModelsResponse | null;
  ollamaModels: string[] | null;
  ollamaError: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}

const formatContext = (n?: number) => (n ? (n >= 1000 ? `${Math.round(n / 1000)}K ctx` : `${n} ctx`) : "");

export function ModelPicker({ value, onChange, models, ollamaModels, ollamaError, onRefresh, refreshing }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => search.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const now = Date.now();
    return (models?.providers ?? []).map((p) => ({
      ...p,
      cooling: p.cooldownUntil && p.cooldownUntil > now ? formatRelative(p.cooldownUntil, now) : null,
      visible: p.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)),
    }));
  }, [models, q]);
  const localVisible = (ollamaModels ?? []).filter((m) => !q || m.toLowerCase().includes(q));
  // Regular users: only Auto plus the models the admin made available, by their friendly names.
  const userModels = models?.userModels ?? null;

  const choose = (selection: string) => {
    onChange(selection);
    setOpen(false);
    setQuery("");
  };

  const item = (selection: string, label: string, detail?: string) => (
    <button
      key={selection}
      type="button"
      role="option"
      aria-selected={value === selection}
      onClick={() => choose(selection)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 text-xs text-[var(--text-soft)]">{detail}</span> : null}
      {value === selection ? <Check size={14} className="shrink-0 text-[var(--accent)]" /> : <span className="w-[14px]" />}
    </button>
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[60vw] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-[var(--bg-hover)] sm:max-w-xs"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value === "auto" ? <Sparkles size={15} className="shrink-0 text-[var(--accent)]" /> : value.startsWith("ollama:") ? <Cpu size={15} className="shrink-0" /> : null}
        <span className="truncate">{selectionLabel(value, models)}</span>
        <ChevronDown size={15} className="shrink-0 text-[var(--text-soft)]" />
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-[min(92vw,380px)] rounded-xl border border-[var(--border)] bg-[var(--bg)] p-1.5 shadow-xl">
          {userModels ? (
            <div className="max-h-[60vh] overflow-y-auto thin-scroll" role="listbox">
              <button
                type="button"
                role="option"
                aria-selected={value === "auto"}
                onClick={() => choose("auto")}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)]"
              >
                <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">Auto (recommended)</span>
                  <span className="block text-xs text-[var(--text-soft)]">Picks the best available model for you.</span>
                </span>
                {value === "auto" ? <Check size={14} className="mt-1 text-[var(--accent)]" /> : null}
              </button>
              {userModels.map((m) => item(m.value, m.label))}
              {ollamaModels !== null || ollamaError ? (
                <div className="mt-1.5">
                  <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">On this device</div>
                  {ollamaError ? <p className="px-2 pb-1 text-xs text-[var(--danger)]">{ollamaError}</p> : null}
                  {(ollamaModels ?? []).map((m) => item(`ollama:${m}`, m, "local"))}
                </div>
              ) : null}
            </div>
          ) : (
          <>
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <div className="flex flex-1 items-center gap-1.5 rounded-md bg-[var(--bg-soft)] px-2">
              <Search size={14} className="text-[var(--text-soft)]" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="w-full bg-transparent py-1.5 text-sm outline-none"
              />
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md p-1.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)]"
              title="Refresh model lists from providers"
              aria-label="Refresh model lists"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto thin-scroll" role="listbox">
            {!q ? (
              <button
                type="button"
                role="option"
                aria-selected={value === "auto"}
                onClick={() => choose("auto")}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)]"
              >
                <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">Auto (recommended)</span>
                  <span className="block text-xs text-[var(--text-soft)]">
                    Uses the first available free provider and switches automatically when a free limit is hit.
                  </span>
                </span>
                {value === "auto" ? <Check size={14} className="mt-1 text-[var(--accent)]" /> : null}
              </button>
            ) : null}

            {groups.map((g) => (
              <div key={g.id} className="mt-1.5">
                <div className="flex items-center gap-2 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">
                  <span>{g.label}</span>
                  {!g.configured ? <span className="font-normal normal-case">· not configured</span> : null}
                  {g.cooling ? <span className="font-normal normal-case text-amber-600 dark:text-amber-400">· cooling down {g.cooling}</span> : null}
                </div>
                {g.configured ? (
                  g.visible.length > 0 ? (
                    g.visible.map((m) => item(`${g.id}:${m.id}`, m.label, [m.id === g.defaultModel ? "default" : "", formatContext(m.contextLength)].filter(Boolean).join(" · ")))
                  ) : (
                    <p className="px-2 pb-1 text-xs text-[var(--text-soft)]">{q ? "No matches." : "No free models found right now."}</p>
                  )
                ) : (
                  <p className="px-2 pb-1 text-xs text-[var(--text-soft)]">
                    {g.id === "workers-ai"
                      ? "Built in once deployed to Cloudflare (no key needed). Off in local dev or when WORKERS_AI_ENABLED=false."
                      : "Add an API key on the server to enable it. See Settings → Providers."}
                  </p>
                )}
              </div>
            ))}

            {ollamaModels !== null || ollamaError ? (
              <div className="mt-1.5">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">Local · Ollama</div>
                {ollamaError ? <p className="px-2 pb-1 text-xs text-[var(--danger)]">{ollamaError}</p> : null}
                {localVisible.map((m) => item(`ollama:${m}`, m, "on this device"))}
                {ollamaModels && ollamaModels.length === 0 && !ollamaError ? (
                  <p className="px-2 pb-1 text-xs text-[var(--text-soft)]">No local models installed (try `ollama pull llama3.2`).</p>
                ) : null}
              </div>
            ) : null}
          </div>
          </>
          )}
        </div>
      ) : null}
    </div>
  );
}
