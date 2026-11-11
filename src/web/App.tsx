import {
  ArrowDown,
  BookOpen,
  CloudSun,
  Code2,
  Coins,
  GraduationCap,
  Mail,
  Menu,
  Newspaper,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationDto, ModelsResponse, PublicConfigDto, ToolInfoDto, UserDto, UserSettings } from "../shared/types";
import { api, ApiError } from "./api/client";
import { AdminDialog } from "./components/AdminDialog";
import { Composer, ToolsButton } from "./components/Composer";
import { LoginPage } from "./components/LoginPage";
import { MessageItem } from "./components/MessageItem";
import { ModelPicker } from "./components/ModelPicker";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toasts, type Toast } from "./components/Toasts";
import { TOOL_ICONS } from "./components/ToolActivity";
import { useChat } from "./hooks/useChat";
import { explainOllamaError, listOllamaModels } from "./lib/ollama";

type Session = { user: UserDto; settings: UserSettings };

export function App() {
  const [config, setConfig] = useState<PublicConfigDto | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      const [cfg, me] = await Promise.all([
        api.config(),
        api.me().catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 401) return null;
          throw e;
        }),
      ]);
      setConfig(cfg);
      document.title = cfg.appName;
      setSession(me);
    } catch (e) {
      setBootError(e instanceof ApiError ? e.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (bootError) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[var(--danger)]">{bootError}</p>
        <button type="button" onClick={boot} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-hover)]">
          Try again
        </button>
      </main>
    );
  }
  if (!config || session === undefined) {
    return (
      <main className="flex h-full items-center justify-center" aria-busy="true">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
      </main>
    );
  }
  if (!session) return <LoginPage config={config} onSignedIn={boot} />;
  return (
    <ChatApp
      appName={config.appName}
      session={session}
      onSettings={(settings) => setSession({ ...session, settings })}
      onSignedOut={() => setSession(null)}
    />
  );
}

/** Welcome-screen ideas. Ones that need a tool are only shown when that tool is actually available. */
const SUGGESTIONS: { icon: LucideIcon; title: string; prompt: string; tool?: string }[] = [
  { icon: Newspaper, title: "Catch up on the news", prompt: "What are today's top technology news stories?", tool: "web_search" },
  { icon: CloudSun, title: "Check the weather", prompt: "What's the weather in Lahore this week?", tool: "weather" },
  { icon: Coins, title: "Convert currency", prompt: "Convert 250 USD to PKR", tool: "currency" },
  { icon: BookOpen, title: "Learn about a topic", prompt: "Tell me about Allama Iqbal's life and work", tool: "wikipedia" },
  { icon: Code2, title: "Write some code", prompt: "Write a Python function that removes duplicates from a list while keeping order" },
  { icon: GraduationCap, title: "Plan your learning", prompt: "Give me a 3-day study plan for learning SQL basics" },
  { icon: Mail, title: "Draft an email", prompt: "Draft a polite email asking my manager for a day off next Friday" },
];

/** Short labels for the capability pills on the welcome screen. */
const CAPABILITY_LABELS: Record<string, string> = {
  web_search: "Live web search",
  weather: "Weather",
  wikipedia: "Wikipedia",
  currency: "Currency rates",
  read_page: "Reads web pages",
  calculator: "Exact maths",
  remember: "Memory",
};

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  if (h >= 17 && h < 22) return "Good evening";
  return "Hello";
}

const SIDEBAR_KEY = "vesper-sidebar-collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
};

const conversationIdFromPath = () => /^\/c\/([0-9a-f-]{36})$/i.exec(window.location.pathname)?.[1] ?? null;

function ChatApp({
  appName,
  session,
  onSettings,
  onSignedOut,
}: {
  appName: string;
  session: Session;
  onSettings: (s: UserSettings) => void;
  onSignedOut: () => void;
}) {
  const { user, settings } = session;
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const settingsOpen = settingsTab !== null;
  const setSettingsOpen = (open: boolean) => setSettingsTab(open ? "general" : null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [toolList, setToolList] = useState<ToolInfoDto[] | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [selection, setSelection] = useState(settings.defaultModel);
  const [input, setInput] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, kind: Toast["kind"] = "error") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  const loadModels = useCallback(
    async (refresh = false) => {
      setRefreshing(refresh);
      try {
        setModels(await api.models(refresh));
      } catch (e) {
        if (refresh) toast(e instanceof ApiError ? e.message : "Could not load models.");
      } finally {
        setRefreshing(false);
      }
    },
    [toast],
  );

  const chat = useChat({
    ollamaUrl: settings.ollamaUrl,
    onError: toast,
    onConversationCreated: (conversation) => {
      setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
      window.history.replaceState(null, "", `/c/${conversation.id}`);
    },
    onConversationActivity: (id) => {
      setConversations((list) => {
        const found = list.find((c) => c.id === id);
        return found ? [{ ...found, updatedAt: Date.now() }, ...list.filter((c) => c.id !== id)] : list;
      });
      void loadModels();
    },
  });

  // Initial data.
  useEffect(() => {
    void loadModels();
    api
      .listConversations()
      .then((r) => {
        setConversations(r.conversations);
        setHasMore(r.hasMore);
      })
      .catch((e: unknown) => toast(e instanceof ApiError ? e.message : "Could not load conversations."));
  }, [loadModels, toast]);

  // Tools this server offers (refreshed when settings change, since the user can switch tools off).
  useEffect(() => {
    api.tools().then(
      (r) => setToolList(r.tools),
      () => setToolList([]),
    );
  }, [settings]);
  const activeTools = useMemo(() => {
    if (toolList === null) return null;
    if (!settings.toolsEnabled) return [];
    return toolList.filter((t) => !settings.disabledTools.includes(t.name) && (!t.requiresMemory || settings.memoryEnabled));
  }, [toolList, settings]);
  const activeNames = new Set((activeTools ?? []).map((t) => t.name));

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      } catch {
        // storage unavailable: still works for this visit
      }
      return !c;
    });

  // Optional local models.
  useEffect(() => {
    if (!settings.ollamaEnabled) {
      setOllamaModels(null);
      setOllamaError(null);
      return;
    }
    const controller = new AbortController();
    listOllamaModels(settings.ollamaUrl, controller.signal)
      .then((list) => {
        setOllamaModels(list.map((m) => m.name));
        setOllamaError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setOllamaModels([]);
        setOllamaError(explainOllamaError(e));
      });
    return () => controller.abort();
  }, [settings.ollamaEnabled, settings.ollamaUrl]);

  const openConversation = useCallback(
    async (id: string, push = true) => {
      if (push) window.history.pushState(null, "", `/c/${id}`);
      setSidebarOpen(false);
      const conversation = await chat.load(id);
      if (!conversation) {
        window.history.replaceState(null, "", "/");
        return;
      }
      setSelection(conversation.model ?? settings.defaultModel);
    },
    [chat, settings.defaultModel],
  );

  const newChat = useCallback(
    (push = true) => {
      chat.reset();
      setSelection(settings.defaultModel);
      setInput("");
      setSidebarOpen(false);
      if (push && window.location.pathname !== "/") window.history.pushState(null, "", "/");
    },
    [chat, settings.defaultModel],
  );

  // URL routing: /c/<id> opens a conversation; back/forward work.
  useEffect(() => {
    const initial = conversationIdFromPath();
    if (initial) void openConversation(initial, false);
    else if (window.location.search) window.history.replaceState(null, "", "/");
    const onPop = () => {
      const id = conversationIdFromPath();
      if (id) void openConversation(id, false);
      else newChat(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (text = input) => {
    const message = text.trim();
    if (!message || chat.streaming) return;
    setInput("");
    const accepted = await chat.send(message, selection);
    if (!accepted) setInput(message);
  };

  // Auto-scroll while the reply streams, unless the user scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useLayoutEffect(() => {
    if (pinned && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat.messages, pinned]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const lastIndex = chat.messages.length - 1;
  const lastUserIndex = chat.messages.map((m) => m.role).lastIndexOf("user");
  const empty = chat.messages.length === 0 && !chat.loading;
  const activeTitle = conversations.find((c) => c.id === chat.conversationId)?.title ?? null;
  const firstName = (user.name ?? "").trim().split(/\s+/)[0] || null;
  const suggestions = SUGGESTIONS.filter((s) => !s.tool || activeNames.has(s.tool)).slice(0, 4);
  const capabilities = Object.keys(CAPABILITY_LABELS).filter((name) => activeNames.has(name));

  const composerControls = (
    <>
      <ModelPicker
        value={selection}
        onChange={setSelection}
        models={models}
        ollamaModels={ollamaModels}
        ollamaError={ollamaError}
        onRefresh={() => void loadModels(true)}
        refreshing={refreshing}
        placement="up"
      />
      <ToolsButton tools={activeTools} onManage={() => setSettingsTab("tools")} />
    </>
  );

  return (
    <div className="flex h-full overflow-hidden bg-[var(--bg)]">
      <Sidebar
        appName={appName}
        user={user}
        conversations={conversations}
        hasMore={hasMore}
        activeId={chat.conversationId}
        open={sidebarOpen}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onClose={() => setSidebarOpen(false)}
        onNewChat={() => newChat()}
        onSelect={(id) => void openConversation(id)}
        onRename={async (id, title) => {
          try {
            const { conversation } = await api.renameConversation(id, title);
            setConversations((list) => list.map((c) => (c.id === id ? conversation : c)));
          } catch (e) {
            toast(e instanceof ApiError ? e.message : "Rename failed.");
          }
        }}
        onDelete={async (id) => {
          try {
            await api.deleteConversation(id);
            setConversations((list) => list.filter((c) => c.id !== id));
            if (chat.conversationId === id) newChat();
          } catch (e) {
            toast(e instanceof ApiError ? e.message : "Delete failed.");
          }
        }}
        onLoadMore={async () => {
          const oldest = conversations[conversations.length - 1];
          try {
            const r = await api.listConversations(oldest?.updatedAt);
            setConversations((list) => [...list, ...r.conversations.filter((c) => !list.some((x) => x.id === c.id))]);
            setHasMore(r.hasMore);
          } catch (e) {
            toast(e instanceof ApiError ? e.message : "Could not load more.");
          }
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        onOpenAdmin={() => {
          setAdminOpen(true);
          setSidebarOpen(false);
        }}
        onLogout={async () => {
          await api.logout().catch(() => {});
          window.history.replaceState(null, "", "/");
          onSignedOut();
        }}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-4">
          <button type="button" onClick={() => setSidebarOpen(true)} className="rounded-lg p-2 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] md:hidden" aria-label="Open sidebar">
            <Menu size={19} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            {!empty && activeTitle ? (
              <h2 className="truncate text-[15px] font-medium text-[var(--text)]" title={activeTitle}>
                {activeTitle}
              </h2>
            ) : (
              <span className="flex items-center gap-2 md:hidden">
                <img src="/favicon.svg" alt="" className="h-6 w-6" />
                <span className="font-[family-name:var(--font-display)] font-semibold">{appName}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => newChat()}
            className="rounded-lg p-2 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            aria-label="New chat"
            title="New chat"
          >
            <SquarePen size={18} />
          </button>
        </header>

        {empty ? (
          // ------------------------------------------------ Welcome screen
          <div className="relative flex-1 overflow-y-auto thin-scroll">
            <div className="dusk-glow pointer-events-none absolute inset-x-0 top-0 h-[520px]" aria-hidden />
            <div className="relative mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-4 pb-10 pt-6 sm:pt-0">
              <div className="rise-in flex flex-col items-center text-center">
                <img src="/favicon.svg" alt="" className="h-12 w-12 rounded-2xl shadow-[var(--shadow-md)]" />
                <h1 className="mt-5 font-[family-name:var(--font-display)] text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px]">
                  <span className="dusk-text">{greeting()}</span>
                  {firstName ? `, ${firstName}` : ""}
                </h1>
                <p className="mt-2 max-w-md text-[15px] text-[var(--text-soft)]">What would you like to explore today?</p>
              </div>

              <div className="rise-in mt-7">
                <Composer
                  variant="hero"
                  value={input}
                  onChange={setInput}
                  onSend={() => void send()}
                  onStop={chat.stop}
                  streaming={chat.streaming}
                  disabled={chat.loading}
                  placeholder={`Ask ${appName} anything…`}
                  controls={composerControls}
                />
              </div>

              {activeTools !== null && capabilities.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5" aria-label="What Vesper can do">
                  {capabilities.map((name) => {
                    const Icon = TOOL_ICONS[name] ?? Sparkles;
                    return (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs text-[var(--text-soft)]"
                      >
                        <Icon size={12} className="text-[var(--accent)]" />
                        {CAPABILITY_LABELS[name]}
                      </span>
                    );
                  })}
                </div>
              ) : null}

              {/* Wait for the tool list so the cards don't change (and jump) after it loads. */}
              <div className={`mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-2 ${activeTools === null ? "invisible" : ""}`}>
                {suggestions.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    onClick={() => void send(s.prompt)}
                    className="group flex w-full min-w-0 items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3.5 text-left shadow-[var(--shadow-sm)] transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                      <s.icon size={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-[var(--text)]">{s.title}</span>
                      <span className="mt-0.5 block truncate text-[13px] text-[var(--text-soft)]">{s.prompt}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          // ------------------------------------------------ Conversation
          <>
            <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto thin-scroll">
              {chat.loading ? (
                <div className="flex h-full items-center justify-center">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
                </div>
              ) : (
                <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 pb-10 pt-4 sm:px-6">
                  {chat.messages.map((m, i) => (
                    <MessageItem
                      key={m.id}
                      message={m}
                      isLast={i === lastIndex}
                      canRetry={!chat.streaming && Boolean(chat.conversationId)}
                      onRetry={() => void chat.regenerate(selection)}
                      isAdmin={user.role === "admin"}
                      canEdit={i === lastUserIndex && !chat.streaming && Boolean(chat.conversationId)}
                      onEdit={(text) => chat.edit(text, selection)}
                    />
                  ))}
                </div>
              )}
              {!pinned ? (
                <button
                  type="button"
                  onClick={() => setPinned(true)}
                  className="sticky bottom-4 left-1/2 mx-auto flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-soft)] shadow-[var(--shadow-md)] hover:text-[var(--text)]"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown size={16} />
                </button>
              ) : null}
            </div>

            <div className="relative shrink-0 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-[var(--bg)] before:to-transparent">
              <Composer
                value={input}
                onChange={setInput}
                onSend={() => void send()}
                onStop={chat.stop}
                streaming={chat.streaming}
                disabled={chat.loading}
                placeholder={`Message ${appName}…`}
                controls={composerControls}
              />
            </div>
          </>
        )}
      </main>

      {settingsOpen ? (
        <SettingsDialog
          initialTab={settingsTab ?? "general"}
          settings={settings}
          models={models}
          ollamaModels={ollamaModels}
          onClose={() => setSettingsOpen(false)}
          onSaved={(saved) => {
            onSettings(saved);
            if (!chat.conversationId) setSelection(saved.defaultModel);
            setSettingsOpen(false);
            toast("Settings saved.", "info");
          }}
        />
      ) : null}
      {adminOpen && user.role === "admin" ? (
        <AdminDialog
          currentUserId={user.id}
          models={models}
          refreshingModels={refreshing}
          onRefreshModels={() => void loadModels(true)}
          onClose={() => setAdminOpen(false)}
          onNotice={toast}
        />
      ) : null}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
