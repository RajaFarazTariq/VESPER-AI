import { ArrowDown, Menu, SquarePen } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationDto, ModelsResponse, PublicConfigDto, UserDto, UserSettings } from "../shared/types";
import { api, ApiError } from "./api/client";
import { Composer } from "./components/Composer";
import { LoginPage } from "./components/LoginPage";
import { MessageItem } from "./components/MessageItem";
import { ModelPicker } from "./components/ModelPicker";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toasts, type Toast } from "./components/Toasts";
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

const SUGGESTIONS = [
  "Explain how HTTPS works, step by step",
  "Write a Python function that removes duplicates from a list while keeping order",
  "Draft a polite email asking my manager for a day off next Friday",
  "Give me a 3-day study plan for learning SQL basics",
];

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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const empty = chat.messages.length === 0 && !chat.loading;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        appName={appName}
        user={user}
        conversations={conversations}
        hasMore={hasMore}
        activeId={chat.conversationId}
        open={sidebarOpen}
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
        onLogout={async () => {
          await api.logout().catch(() => {});
          window.history.replaceState(null, "", "/");
          onSignedOut();
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-2 sm:px-3">
          <button type="button" onClick={() => setSidebarOpen(true)} className="rounded-md p-2 hover:bg-[var(--bg-hover)] md:hidden" aria-label="Open sidebar">
            <Menu size={18} />
          </button>
          <ModelPicker
            value={selection}
            onChange={setSelection}
            models={models}
            ollamaModels={ollamaModels}
            ollamaError={ollamaError}
            onRefresh={() => void loadModels(true)}
            refreshing={refreshing}
          />
          <div className="flex-1" />
          <button type="button" onClick={() => newChat()} className="rounded-md p-2 hover:bg-[var(--bg-hover)] md:hidden" aria-label="New chat">
            <SquarePen size={18} />
          </button>
        </header>

        <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto thin-scroll">
          {chat.loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
            </div>
          ) : empty ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-10 text-center">
              <img src="/favicon.svg" alt="" className="h-12 w-12" />
              <h1 className="mt-4 text-2xl font-semibold">How can I help{user.name ? `, ${user.name.split(" ")[0]}` : ""}?</h1>
              <p className="mt-2 max-w-md text-sm text-[var(--text-soft)]">
                Ask anything. Replies stream from free AI providers, and the app switches providers automatically when a free limit is reached.
              </p>
              <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-xl border border-[var(--border)] px-4 py-3 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
              {chat.messages.map((m, i) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isLast={i === lastIndex}
                  canRetry={!chat.streaming && Boolean(chat.conversationId)}
                  onRetry={() => void chat.regenerate(selection)}
                />
              ))}
            </div>
          )}
          {!pinned && !empty ? (
            <button
              type="button"
              onClick={() => setPinned(true)}
              className="sticky bottom-3 left-1/2 mx-auto flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] shadow"
              aria-label="Scroll to bottom"
            >
              <ArrowDown size={16} />
            </button>
          ) : null}
        </div>

        <Composer value={input} onChange={setInput} onSend={() => void send()} onStop={chat.stop} streaming={chat.streaming} disabled={chat.loading} />
      </main>

      {settingsOpen ? (
        <SettingsDialog
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
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
