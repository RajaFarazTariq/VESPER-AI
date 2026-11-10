import { Monitor, Moon, Plus, Sun, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MemoryDto, ModelsResponse, ToolInfoDto, UserSettings } from "../../shared/types";
import { api, ApiError } from "../api/client";
import { selectionLabel } from "../lib/format";
import { explainOllamaError, listOllamaModels } from "../lib/ollama";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";

// Provider status moved to the admin panel (AdminDialog), since only the administrator manages keys.
type Tab = "general" | "tools" | "memory" | "local" | "appearance";

interface Props {
  settings: UserSettings;
  models: ModelsResponse | null;
  ollamaModels: string[] | null;
  onClose: () => void;
  onSaved: (settings: UserSettings) => void;
}

const MAX_INSTRUCTIONS = 4000;

export function SettingsDialog({ settings, models, ollamaModels, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<UserSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const [ollamaTest, setOllamaTest] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolInfoDto[] | null>(null);
  const [memories, setMemories] = useState<MemoryDto[] | null>(null);
  const [newMemory, setNewMemory] = useState("");
  const [memoryError, setMemoryError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "tools" && tools === null) {
      api.tools().then((r) => setTools(r.tools), () => setTools([]));
    }
    if (tab === "memory" && memories === null) {
      api.listMemories().then(
        (r) => setMemories(r.memories),
        (e: unknown) => {
          setMemories([]);
          setMemoryError(e instanceof ApiError ? e.message : "Could not load memories.");
        },
      );
    }
  }, [tab, tools, memories]);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { settings: saved } = await api.updateSettings(draft);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  };

  const modelOptions: { value: string; label: string }[] = [{ value: "auto", label: "Auto (recommended)" }];
  for (const p of models?.providers ?? []) {
    if (!p.configured) continue;
    for (const m of p.models) modelOptions.push({ value: `${p.id}:${m.id}`, label: `${p.label} · ${m.label}` });
  }
  for (const m of ollamaModels ?? []) modelOptions.push({ value: `ollama:${m}`, label: `Ollama (local) · ${m}` });
  if (!modelOptions.some((o) => o.value === draft.defaultModel)) {
    modelOptions.push({ value: draft.defaultModel, label: selectionLabel(draft.defaultModel, models) });
  }

  const tabs: [Tab, string][] = [
    ["general", "General"],
    ["tools", "Tools"],
    ["memory", "Memory"],
    ["local", "Local models"],
    ["appearance", "Appearance"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 id="settings-title" className="text-lg font-semibold">
            Settings
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 hover:bg-[var(--bg-hover)]" aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-3 thin-scroll" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm ${
                tab === id ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-soft)] hover:text-[var(--text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 thin-scroll">
          {tab === "general" ? (
            <div className="space-y-5">
              <Field label="Default model" hint="Used for new chats. Auto picks the first free provider that is available.">
                <select
                  value={draft.defaultModel}
                  onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                >
                  {modelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle
                checked={draft.fallback}
                onChange={(fallback) => setDraft({ ...draft, fallback })}
                label="Fall back automatically"
                hint="If the model you picked hits a free limit or fails, continue with the next free provider instead of stopping."
              />
              <Field label="Custom instructions" hint="Added to every conversation (e.g. your role, preferred language, answer style).">
                <textarea
                  value={draft.systemPrompt}
                  maxLength={MAX_INSTRUCTIONS}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={6}
                  placeholder="e.g. I'm a backend developer. Prefer Python examples and keep answers short."
                  className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                />
                <div className="mt-1 text-right text-xs text-[var(--text-soft)]">
                  {draft.systemPrompt.length}/{MAX_INSTRUCTIONS}
                </div>
              </Field>
            </div>
          ) : null}

          {tab === "tools" ? (
            <div className="space-y-4">
              <Toggle
                checked={draft.toolsEnabled}
                onChange={(toolsEnabled) => setDraft({ ...draft, toolsEnabled })}
                label="Let the assistant use tools"
                hint="Tools let the model calculate exactly, check the time and manage memory. Each tool step uses one extra request from your free quota."
              />
              <div className={`space-y-2 ${draft.toolsEnabled ? "" : "pointer-events-none opacity-50"}`}>
                {(tools ?? []).map((t) => {
                  const off = draft.disabledTools.includes(t.name);
                  const needsMemory = t.requiresMemory && !draft.memoryEnabled;
                  return (
                    <div key={t.name} className="rounded-xl border border-[var(--border)] p-3">
                      <Toggle
                        checked={!off && !needsMemory}
                        onChange={(on) =>
                          setDraft({
                            ...draft,
                            disabledTools: on ? draft.disabledTools.filter((n) => n !== t.name) : [...draft.disabledTools, t.name],
                          })
                        }
                        label={t.label}
                        hint={`${t.description}${needsMemory ? " (Turn on Memory to use this.)" : ""}`}
                      />
                      <span className="ml-12 mt-1 inline-block rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--text-soft)]">
                        {t.risk === "read" ? "Read-only" : "Changes data in your account"}
                      </span>
                    </div>
                  );
                })}
                {tools === null ? <p className="text-sm text-[var(--text-soft)]">Loading…</p> : null}
              </div>
              <p className="text-xs text-[var(--text-soft)]">
                Tools switched off by the administrator aren't listed. Anything that acts outside your account (sending, creating, deleting) will
                always ask for your approval first.
              </p>
            </div>
          ) : null}

          {tab === "memory" ? (
            <div className="space-y-4">
              <Toggle
                checked={draft.memoryEnabled}
                onChange={(memoryEnabled) => setDraft({ ...draft, memoryEnabled })}
                label="Use long-term memory"
                hint="Saved facts are included in every conversation, and the assistant can save new ones when you ask it to remember something. Never store passwords or sensitive data."
              />
              <div>
                <div className="mb-1.5 text-sm font-medium">Add a memory</div>
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const content = newMemory.trim();
                    if (!content) return;
                    setMemoryError(null);
                    try {
                      const { memory } = await api.addMemory(content);
                      setMemories((list) => [...(list ?? []).filter((m) => m.id !== memory.id), memory]);
                      setNewMemory("");
                    } catch (err) {
                      setMemoryError(err instanceof ApiError ? err.message : "Could not save.");
                    }
                  }}
                >
                  <input
                    value={newMemory}
                    maxLength={500}
                    onChange={(e) => setNewMemory(e.target.value)}
                    placeholder="e.g. I work in Pakistan Standard Time (UTC+5)."
                    aria-label="New memory"
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
                  >
                    <Plus size={14} /> Add
                  </button>
                </form>
              </div>
              {memoryError ? <p className="text-sm text-[var(--danger)]">{memoryError}</p> : null}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm font-medium">
                  <span>Saved memories {memories ? `(${memories.length})` : ""}</span>
                  {memories && memories.length > 0 ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm("Delete ALL saved memories? This cannot be undone.")) return;
                        await api.deleteAllMemories().catch(() => {});
                        setMemories([]);
                      }}
                      className="text-xs font-normal text-[var(--danger)] hover:underline"
                    >
                      Delete all
                    </button>
                  ) : null}
                </div>
                {memories === null ? (
                  <p className="text-sm text-[var(--text-soft)]">Loading…</p>
                ) : memories.length === 0 ? (
                  <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-sm text-[var(--text-soft)]">
                    Nothing saved yet. Try telling the assistant: “Remember that I prefer short answers.”
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                    {[...memories].reverse().map((m) => (
                      <li key={m.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1">{m.content}</span>
                        <span className="shrink-0 text-[11px] text-[var(--text-soft)]">{m.source === "user" ? "added by you" : "saved in chat"}</span>
                        <button
                          type="button"
                          onClick={async () => {
                            await api.deleteMemory(m.id).catch(() => {});
                            setMemories((list) => (list ?? []).filter((x) => x.id !== m.id));
                          }}
                          className="shrink-0 rounded p-1 text-[var(--text-soft)] hover:text-[var(--danger)]"
                          aria-label={`Delete memory: ${m.content}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          {tab === "local" ? (
            <div className="space-y-5">
              <p className="text-sm text-[var(--text-soft)]">
                Run open models on your own computer with{" "}
                <a className="text-[var(--accent)] underline" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">
                  Ollama
                </a>
                . Your browser talks to Ollama directly, so the cloud server never contacts your machine, and local chats still sync to your history.
              </p>
              <Toggle checked={draft.ollamaEnabled} onChange={(ollamaEnabled) => setDraft({ ...draft, ollamaEnabled })} label="Enable local models" />
              <Field label="Ollama URL" hint="Usually http://localhost:11434">
                <div className="flex gap-2">
                  <input
                    value={draft.ollamaUrl}
                    onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      setOllamaTest("Testing…");
                      try {
                        const list = await listOllamaModels(draft.ollamaUrl);
                        setOllamaTest(`Connected: ${list.length} model${list.length === 1 ? "" : "s"} installed.`);
                      } catch (e) {
                        setOllamaTest(explainOllamaError(e));
                      }
                    }}
                    className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
                  >
                    Test
                  </button>
                </div>
                {ollamaTest ? <p className="mt-2 text-xs text-[var(--text-soft)]">{ollamaTest}</p> : null}
              </Field>
              <div className="rounded-lg bg-[var(--bg-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
                <p className="font-medium text-[var(--text)]">One-time setup on your computer</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                  <li>Install Ollama and pull a model, e.g. <code>ollama pull llama3.2</code></li>
                  <li>
                    Allow this site to call it: set the environment variable <code>OLLAMA_ORIGINS={window.location.origin}</code> and restart Ollama.
                  </li>
                  <li>Click Test above, then pick a model under “Local · Ollama” in the model menu.</li>
                </ol>
              </div>
            </div>
          ) : null}

          {tab === "appearance" ? (
            <Field label="Theme">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["light", "Light", <Sun key="s" size={16} />],
                    ["dark", "Dark", <Moon key="m" size={16} />],
                    ["system", "System", <Monitor key="c" size={16} />],
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setTheme(value);
                      setThemePreference(value);
                    }}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                      theme === value ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--bg-hover)]"
                    }`}
                    aria-pressed={theme === value}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}
        </div>

        {tab === "general" || tab === "local" || tab === "tools" || tab === "memory" ? (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            {error ? <span className="mr-auto text-sm text-[var(--danger)]">{error}</span> : null}
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">{label}</div>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-[var(--text-soft)]">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-[var(--text-soft)]">{hint}</span> : null}
      </span>
    </label>
  );
}
