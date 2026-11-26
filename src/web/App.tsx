import { Archive, ArrowDown, FileSpreadsheet, FileText, Menu, Mic, Paperclip, Sparkles, SquarePen, Telescope } from "lucide-react";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ConversationDto, FeaturesDto, ModelsResponse, PublicConfigDto, ToolInfoDto, UserDto, UserSettings } from "../shared/types";
import { api, ApiError } from "./api/client";
import { AgentLauncher } from "./components/AgentCore";
import { Composer, ResearchToggle, ToolsButton } from "./components/Composer";
import { LoginPage } from "./components/LoginPage";
import { MessageItem } from "./components/MessageItem";
import { ModelPicker } from "./components/ModelPicker";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toasts, type Toast } from "./components/Toasts";
import { TOOL_ICONS } from "./components/ToolActivity";
import { useChat } from "./hooks/useChat";
import { DOCUMENT_LIMITS, documentKind, READ_DOCUMENT_TOOL, SEARCH_DOCUMENTS_TOOL } from "../shared/documents";
import { tableKind } from "../shared/tables";
import { documentProblem, orList, rejectedFileMessage, routeFiles } from "./lib/attachments";
import { documentErrorMessage, messageDocument, readDocument, uploadDocument, type PendingDocument } from "./lib/documents";
import { ImageError, prepareImage, type PendingImage } from "./lib/images";
import { messageFile, readInBackground, tableErrorMessage, uploadTables, type PendingTable } from "./lib/tables";
import { explainOllamaError, listOllamaModels } from "./lib/ollama";
import { agentLink, briefingDayOf } from "./lib/agent-voice";
import { insertByUpdated } from "./lib/format";
import { agentAudio, canSpeak, speak, stopSpeaking } from "./lib/voice";
import { VesperMark } from "./components/VesperMark";
import { lazyPart, LoadBoundary, LOAD_FAILED } from "./components/LoadBoundary";

// Parts most visits never open are downloaded when first opened (v0.19.0), which keeps the first load small: the admin
// panel and VESPER Agent. The agent's launcher stays here; pointing at it, focusing it or pressing it starts the
// download. Once downloaded, the agent is drawn directly, within the tap (as before v0.19.0): Safari lets its voice
// start only then, and there is no loading screen.
type AgentModule = typeof import("./components/AgentMode");
let agentModule: AgentModule | null = null;
const loadAgentMode = () => import("./components/AgentMode").then((m) => (agentModule = m));
const preloadAgentMode = () => void loadAgentMode().catch(() => {});
/** Opened before the download finished (a tap without pointing first, or a notification's link): a loading screen. */
const LazyAgentMode = lazyPart(() => loadAgentMode().then((m) => m.AgentMode));
const AdminDialog = lazyPart(() => import("./components/AdminDialog").then((m) => m.AdminDialog));

/** Shown over the page while a dialog's part downloads (the same spinner as everywhere else). */
function DialogLoading({ label, agent = false }: { label: string; agent?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="status" aria-label={label}>
      <div className={agent ? "agent-dim" : "absolute inset-0 bg-black/45 backdrop-blur-[3px]"} aria-hidden="true" />
      <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" aria-hidden="true" />
    </div>
  );
}

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

/**
 * Signing out (v0.18.0): this browser stops getting the account's notifications (a shared computer must not show the
 * last user's reminders): the server forgets this device, the browser drops its subscription and the saved id. Best
 * effort, and never holds the sign-out up for more than 2.5 seconds. (The push code is loaded only now.)
 */
async function forgetPushDevice(): Promise<void> {
  const work = (async () => {
    const push = await import("./lib/push");
    const id = push.savedDeviceId();
    push.saveDeviceId(null);
    await Promise.allSettled([id ? api.notifications.removeDevice(id) : Promise.resolve(), push.unsubscribe()]);
  })().catch(() => {});
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 2500))]);
}

const conversationIdFromPath = () => /^\/c\/([0-9a-f-]{36})$/i.exec(window.location.pathname)?.[1] ?? null;

/**
 * VESPER Agent's launcher on the welcome screen (v0.17.0) sits in the bottom-right corner, unless the message box
 * reaches that corner (a long message on a short screen): then it moves just above the box, or below it. Returns the
 * launcher's distance from the bottom of the screen in that case, else null (the corner).
 */
function useLauncherLift(box: RefObject<HTMLElement | null>, active: boolean): number | null {
  const [lift, setLift] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!active || !el) {
      setLift(null);
      return;
    }
    const SIZE = 56;
    const GAP = 8;
    const place = () => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const right = vw >= 640 ? 24 : 16; // right-4 / sm:right-6
      const inCorner = r.bottom > vh - 24 - SIZE - GAP && r.right > vw - right - SIZE - GAP;
      if (!inCorner) return setLift(null);
      const above = r.top - 56; // below the header
      const below = vh - r.bottom;
      if (above >= SIZE + 2 * GAP || above >= below) setLift(vh - r.top + GAP);
      else setLift(Math.max(GAP, below - SIZE - GAP));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    const scroller = el.closest(".overflow-y-auto");
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [box, active]);
  return lift;
}

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
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;
  /** A restored (un-archived) chat back in the sidebar, unless it belongs among older chats not loaded yet. */
  const restoreToSidebar = (conversation: ConversationDto) => setConversations((list) => insertByUpdated(list, conversation, hasMoreRef.current));
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
  const [attachments, setAttachments] = useState<PendingImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  /** Spreadsheets waiting in the message box (v0.14.0), and how to stop reading or uploading each one. */
  const [tableFiles, setTableFiles] = useState<PendingTable[]>([]);
  const tableJobs = useRef(new Map<string, AbortController>());
  /** Documents waiting in the message box (v0.16.0), and how to stop reading or uploading each one. */
  const [docFiles, setDocFiles] = useState<PendingDocument[]>([]);
  const docJobs = useRef(new Map<string, AbortController>());
  const [features, setFeatures] = useState<FeaturesDto | null>(null);
  /** Deep research for the next message (turns itself off after sending). */
  const [researchMode, setResearchMode] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** VESPER Agent (v0.17.0): open over the chat, growing out of the launcher at `agentOrigin`. */
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentOrigin, setAgentOrigin] = useState<{ x: number; y: number } | null>(null);
  /** Opened from the daily briefing's notification (v0.18.0); each such opening starts a fresh agent view. */
  const [agentBriefing, setAgentBriefing] = useState(false);
  /** The day that briefing is about ("YYYY-MM-DD", from the link), when it says. */
  const [agentBriefingDay, setAgentBriefingDay] = useState<string | null>(null);
  const [agentRun, setAgentRun] = useState(0);
  /** Agent mode's code was there when it opened (drawn directly, within the tap). */
  const [agentReady, setAgentReady] = useState(false);
  const agentOpenRef = useRef(false);
  agentOpenRef.current = agentOpen;
  const launcher = useRef<HTMLButtonElement>(null);

  const toast = useCallback((message: string, kind: Toast["kind"] = "error", action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, kind, ...(action ? { action } : {}) }]);
    // A toast with a button (e.g. Undo) times itself (Toasts): longer, and not while pointed at or focused.
    if (!action) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);
  /**
   * An archived chat open in the chat view (v0.19.0, opened from Settings → Archived chats or its address). It isn't
   * in the sidebar; sending a message in it restores it on the server, and then it joins the sidebar again.
   */
  const [archivedChat, setArchivedChat] = useState<ConversationDto | null>(null);
  const archivedChatRef = useRef<ConversationDto | null>(null);
  archivedChatRef.current = archivedChat;

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

  const voiceOn = Boolean(features?.voice.enabled);
  const chat = useChat({
    ollamaUrl: settings.ollamaUrl,
    onError: toast,
    onReplyDone: (message) => {
      // Not while VESPER Agent is open: it is the one speaking then.
      if (settings.readAloud && voiceOn && canSpeak() && message.content.trim() && !agentOpenRef.current) speak(message.id, message.content);
    },
    onConversationCreated: (conversation) => {
      setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
      window.history.replaceState(null, "", `/c/${conversation.id}`);
    },
    onConversationActivity: (id) => {
      const archived = archivedChatRef.current?.id === id ? archivedChatRef.current : null;
      if (archived) setArchivedChat(null);
      setConversations((list) => {
        const found = list.find((c) => c.id === id) ?? (archived ? { ...archived, archivedAt: null } : null);
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

  // Tools this server offers. Refreshed when settings change (the user can switch tools off) and when the admin
  // panel closes (the first ready document adds the knowledge base; the admin can switch tools off for everyone).
  useEffect(() => {
    if (adminOpen) return;
    api.tools().then(
      (r) => setToolList(r.tools),
      () => setToolList([]),
    );
    // Image and voice switches (admin panel → App settings).
    // A failed refresh keeps what was known: otherwise files waiting in the message box would vanish from view.
    api.features().then(setFeatures, () => {});
  }, [settings, adminOpen]);

  // Stop reading aloud when leaving the page.
  useEffect(() => () => stopSpeaking(), []);

  const imagesOn = Boolean(features?.images.enabled);
  const maxImages = features?.images.maxPerMessage ?? 3;
  const addImages = useCallback(
    (files: File[]) => {
      if (selection.startsWith("ollama:")) {
        toast("Images work with the cloud models only. Choose Auto or another cloud model to attach images.");
        return;
      }
      const room = maxImages - attachments.length - preparing;
      if (files.length > room) toast(`Up to ${maxImages} images per message.`);
      for (const file of files.slice(0, Math.max(0, room))) {
        setPreparing((n) => n + 1);
        prepareImage(file)
          .then((image) => setAttachments((list) => [...list, { ...image, id: `${Date.now()}-${Math.random()}` }].slice(0, maxImages)))
          .catch((e: unknown) => toast(e instanceof ImageError ? e.message : "That image couldn't be prepared."))
          .finally(() => setPreparing((n) => n - 1));
      }
    },
    [selection, maxImages, attachments.length, preparing, toast],
  );
  // Spreadsheets (v0.14.0): read in the background, uploaded, then sent with the message.
  const tablesOn = Boolean(features?.tables?.enabled);
  const maxTables = 1;
  const chatFiles = useMemo(() => chat.messages.reduce((n, m) => n + (m.files?.length ?? 0), 0), [chat.messages]);
  const patchTable = useCallback(
    (id: string, patch: Partial<PendingTable>) => setTableFiles((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [],
  );
  const addTables = useCallback(
    (files: File[]) => {
      const sheets = files.filter((f) => tableKind(f.name));
      if (!features?.tables?.enabled || sheets.length === 0) return;
      if (selection.startsWith("ollama:")) {
        toast("Spreadsheets work with the cloud models only. Choose Auto or another cloud model to attach one.");
        return;
      }
      if (tableFiles.length >= maxTables || sheets.length > maxTables) {
        toast("Attach one spreadsheet per message.");
        if (tableFiles.length >= maxTables) return;
      }
      if (chatFiles + tableFiles.length >= features.tables.perChat) {
        toast(`A chat can have up to ${features.tables.perChat} spreadsheets. Start a new chat to add more.`);
        return;
      }
      const file = sheets[0]!;
      const id = `${Date.now()}-${Math.random()}`;
      const controller = new AbortController();
      tableJobs.current.set(id, controller);
      setTableFiles((list) => [...list, { id, name: file.name, status: "reading", progress: 0 }]);
      void (async () => {
        try {
          const read = await readInBackground(file, () => {}, controller.signal);
          patchTable(id, { status: "uploading", rows: read.tables.reduce((n, t) => n + t.rows, 0), sheets: read.tables.length });
          const saved = await uploadTables(
            read,
            (fileId) => patchTable(id, { fileId }),
            (progress) => patchTable(id, { progress }),
            controller.signal,
          );
          patchTable(id, { status: "ready", fileId: saved.id, progress: 1 });
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = tableErrorMessage(error);
          if (message) toast(message);
          setTableFiles((list) => list.filter((t) => t.id !== id));
        } finally {
          tableJobs.current.delete(id);
        }
      })();
    },
    [features, selection, tableFiles.length, chatFiles, patchTable, toast],
  );
  /** Remove spreadsheets from the message box: stop their reading or upload, and delete what was uploaded. */
  const dropTables = useCallback((items: PendingTable[]) => {
    for (const t of items) {
      tableJobs.current.get(t.id)?.abort();
      if (t.fileId) void api.files.remove(t.fileId).catch(() => {});
    }
    const ids = new Set(items.map((t) => t.id));
    setTableFiles((list) => list.filter((t) => !ids.has(t.id)));
  }, []);

  // Documents (v0.16.0): read in this browser, their passages uploaded, then sent with the message.
  const documentsOn = Boolean(features?.documents?.enabled);
  const maxDocuments = features?.documents?.perMessage ?? DOCUMENT_LIMITS.perMessage;
  const chatDocuments = useMemo(() => chat.messages.reduce((n, m) => n + (m.documents?.length ?? 0), 0), [chat.messages]);
  const patchDocument = useCallback(
    (id: string, patch: Partial<PendingDocument>) => setDocFiles((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d))),
    [],
  );
  /** Remove documents from the message box: stop their reading or upload, and delete what was uploaded. */
  const dropDocuments = useCallback((items: PendingDocument[]) => {
    for (const d of items) {
      docJobs.current.get(d.id)?.abort();
      if (d.documentId) void api.documents.remove(d.documentId).catch(() => {});
    }
    const ids = new Set(items.map((d) => d.id));
    setDocFiles((list) => list.filter((d) => !ids.has(d.id)));
  }, []);

  const activeTools = useMemo(() => {
    if (toolList === null) return null;
    if (!settings.toolsEnabled) return [];
    return toolList.filter((t) => !settings.disabledTools.includes(t.name) && (!t.requiresMemory || settings.memoryEnabled));
  }, [toolList, settings]);
  const activeNames = new Set((activeTools ?? []).map((t) => t.name));
  // The documents are read only through the assistant's document tools (the user can switch those off).
  const documentToolsOff = activeTools !== null && !activeNames.has(SEARCH_DOCUMENTS_TOOL) && !activeNames.has(READ_DOCUMENT_TOOL);

  const addDocuments = useCallback(
    (files: File[]) => {
      const limits = features?.documents;
      if (!limits?.enabled || files.length === 0) return;
      if (selection.startsWith("ollama:")) {
        toast("Documents work with the cloud models only. Choose Auto or another cloud model to attach one.");
        return;
      }
      // The same limits and wording as the server, which checks them again.
      const inMessage = maxDocuments - docFiles.length;
      const inChat = limits.perChat - chatDocuments - docFiles.length;
      const chatMessage = `A chat can have up to ${limits.perChat} documents. Start a new chat to add more.`;
      const messageMessage = `Attach up to ${maxDocuments} documents per message.`;
      const room = Math.max(0, Math.min(inMessage, inChat));
      // Problems known before reading (type, empty, size) don't add a chip, and don't take a free place either.
      const usable = files.filter((file) => {
        const problem = documentProblem(file);
        if (problem) toast(`${file.name}: ${problem}`);
        return !problem;
      });
      if (usable.length > room) toast(inChat <= inMessage ? chatMessage : messageMessage);
      const picked = usable.slice(0, room);
      if (picked.length === 0) return;
      if (documentToolsOff) {
        toast(
          settings.toolsEnabled
            ? "To read documents, switch on “Your documents” in Settings → Tools."
            : "To read documents, switch tools on in Settings → Tools.",
          "info",
        );
      }
      for (const file of picked) {
        const id = `${Date.now()}-${Math.random()}`;
        const controller = new AbortController();
        docJobs.current.set(id, controller);
        setDocFiles((list) => [...list, { id, name: file.name, kind: documentKind(file.name)!, status: "reading", progress: 0 }]);
        void (async () => {
          try {
            const read = await readDocument(file, (note) => patchDocument(id, { note }), controller.signal);
            patchDocument(id, { status: "uploading", pages: read.pages, note: undefined });
            const saved = await uploadDocument(
              read,
              (documentId) => patchDocument(id, { documentId }),
              (progress) => patchDocument(id, { progress }),
              controller.signal,
            );
            patchDocument(id, { status: "ready", documentId: saved.id, progress: 1, pages: saved.pages, chars: saved.charCount });
          } catch (error) {
            if (controller.signal.aborted) return;
            const message = documentErrorMessage(error);
            if (message) toast(`${file.name}: ${message}`);
            setDocFiles((list) => list.filter((d) => d.id !== id));
          } finally {
            docJobs.current.delete(id);
          }
        })();
      }
    },
    [features, selection, maxDocuments, docFiles.length, chatDocuments, documentToolsOff, settings.toolsEnabled, patchDocument, toast],
  );

  /** Every picked, dropped or pasted file: images, spreadsheets and documents each go to their own list. */
  const addFiles = useCallback(
    (files: File[]) => {
      const on = { images: imagesOn, tables: tablesOn, documents: documentsOn };
      const routed = routeFiles(files, on);
      if (routed.rejected[0]) toast(rejectedFileMessage(routed.rejected[0], on));
      if (routed.images.length) addImages(routed.images);
      if (routed.tables.length) addTables(routed.tables);
      if (routed.documents.length) addDocuments(routed.documents);
    },
    [imagesOn, tablesOn, documentsOn, addImages, addTables, addDocuments, toast],
  );

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
      stopSpeaking();
      const conversation = await chat.load(id);
      if (!conversation) {
        setArchivedChat(null);
        window.history.replaceState(null, "", "/");
        return;
      }
      setArchivedChat(conversation.archivedAt ? conversation : null);
      setSelection(conversation.model ?? settings.defaultModel);
    },
    [chat, settings.defaultModel],
  );

  const chatRef = useRef(chat);
  chatRef.current = chat;
  const openConversationRef = useRef(openConversation);
  openConversationRef.current = openConversation;

  const newChat = useCallback(
    (push = true) => {
      chat.reset();
      setArchivedChat(null);
      stopSpeaking();
      setSelection(settings.defaultModel);
      setInput("");
      setAttachments([]);
      dropTables(tableFiles);
      dropDocuments(docFiles);
      setResearchMode(false);
      setSidebarOpen(false);
      if (push && window.location.pathname !== "/") window.history.pushState(null, "", "/");
    },
    [chat, settings.defaultModel, dropTables, tableFiles, dropDocuments, docFiles],
  );

  // VESPER Agent (v0.17.0): its own chat state; its conversations join the sidebar like any other chat.
  // Opening adds a history entry (same address), so Back closes the agent instead of moving the chat behind it.
  const agentEntry = useRef(false);
  /** Set just before our own history.back(): the popstate it causes is ignored by the chat. */
  const ignorePop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextPop = () => {
    if (ignorePop.current) clearTimeout(ignorePop.current);
    ignorePop.current = setTimeout(() => (ignorePop.current = null), 1000);
  };
  const openAgent = (briefing = false, briefingDay: string | null = null) => {
    const rect = launcher.current?.getBoundingClientRect();
    setAgentOrigin(rect && rect.width > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
    setSidebarOpen(false);
    // Already open (a notification clicked meanwhile): it keeps its history entry.
    if (!agentOpenRef.current) {
      window.history.pushState({ vesperAgent: true }, "", window.location.href);
      agentEntry.current = true;
    }
    setAgentBriefing(briefing);
    setAgentBriefingDay(briefing ? briefingDay : null);
    setAgentRun((n) => n + 1);
    setAgentReady(agentModule !== null);
    setAgentOpen(true);
  };
  /**
   * A notification's link (v0.18.0), by its query: "?agent=briefing&day=YYYY-MM-DD" starts the briefing (about that
   * day), "?agent=1" opens VESPER Agent.
   */
  const openFromLink = (search: string) => {
    const link = agentLink(search);
    if (link === "briefing") openAgent(true, briefingDayOf(search));
    else if (link && !agentOpenRef.current) openAgent();
  };
  const openFromLinkRef = useRef(openFromLink);
  openFromLinkRef.current = openFromLink;
  // A notification clicked while VESPER is open in this tab: the service worker brings the tab forward and says what to open.
  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== "vesper:open" || typeof data.url !== "string") return;
      try {
        const url = new URL(data.url, window.location.origin);
        if (url.origin === window.location.origin) openFromLinkRef.current(url.search);
      } catch {
        // not a link of ours
      }
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, []);
  /** Closed with ✕ or Esc: its history entry goes again. */
  const closeAgent = useCallback(() => {
    setAgentOpen(false);
    if (!agentEntry.current) return;
    agentEntry.current = false;
    skipNextPop();
    window.history.back();
  }, []);
  /** "Open in chat": the agent's history entry becomes the conversation's, so Back returns to where you were. */
  const openAgentChat = useCallback(
    (id: string) => {
      setAgentOpen(false);
      if (!agentEntry.current) {
        void openConversation(id);
        return;
      }
      agentEntry.current = false;
      window.history.replaceState(null, "", `/c/${id}`);
      void openConversation(id, false);
    },
    [openConversation],
  );
  // Closing puts the focus back on the launcher.
  const agentWasOpen = useRef(false);
  useEffect(() => {
    if (agentOpen) {
      agentWasOpen.current = true;
      return;
    }
    if (!agentWasOpen.current) return;
    agentWasOpen.current = false;
    launcher.current?.focus();
  }, [agentOpen]);
  /** VESPER Agent's launcher, placed by the screen it is on (welcome screen or conversation). */
  // The studio voice's audio output is started by the tap itself (Safari and phones allow it only then), even while
  // Agent mode is still downloading; Agent mode then uses that one.
  const studioVoice = Boolean(features?.voice.enabled && features.voice.studio?.enabled);
  const agentLauncher = (className = "") => (
    <AgentLauncher
      ref={launcher}
      onClick={() => {
        if (studioVoice) agentAudio(true);
        openAgent();
      }}
      onPrepare={preloadAgentMode}
      hidden={agentOpen}
      className={className}
    />
  );
  const agentConversationCreated = useCallback(
    (conversation: ConversationDto) => setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]),
    [],
  );
  const agentConversationActivity = useCallback(
    (id: string) => {
      setConversations((list) => {
        const found = list.find((c) => c.id === id);
        return found ? [{ ...found, updatedAt: Date.now() }, ...list.filter((c) => c.id !== id)] : list;
      });
      void loadModels();
    },
    [loadModels],
  );

  // URL routing: /c/<id> opens a conversation; back/forward work.
  useEffect(() => {
    // Back from GitHub (v0.12.0): open Settings → Connections and say how it went.
    const github = new URLSearchParams(window.location.search).get("github");
    if (github) {
      const outcomes: Record<string, [string, "info" | "error"]> = {
        connected: ["GitHub connected. If you haven't yet, choose which repositories VESPER may read.", "info"],
        installed: ["Your repository choice was saved on GitHub.", "info"],
        // GitHub changes with approval (v0.13.0): the separate Actions app.
        "actions-connected": ["GitHub changes connected. If you haven't yet, choose which repositories VESPER may change.", "info"],
        "actions-installed": ["Your repository choice for GitHub changes was saved.", "info"],
        denied: ["GitHub wasn't connected (you cancelled on GitHub).", "error"],
        failed: ["Couldn't connect GitHub. Please try again.", "error"],
        not_available: ["GitHub isn't available for your account.", "error"],
      };
      const [message, kind] = outcomes[github] ?? outcomes.failed!;
      toast(message, kind);
      setSettingsTab("connections");
    }
    // Back from Google (v0.15.0), likewise.
    const google = new URLSearchParams(window.location.search).get("google");
    if (google) {
      const outcomes: Record<string, [string, "info" | "error"]> = {
        connected: ["Google connected. Ask about your calendar, or ask VESPER to prepare an event or an email.", "info"],
        "none-allowed": ["Nothing was connected: tick Calendar and/or Gmail on Google's screen to allow them.", "error"],
        denied: ["Google wasn't connected (you cancelled on Google).", "error"],
        failed: ["Couldn't connect Google. Please try again.", "error"],
        not_available: ["Google Calendar and Gmail aren't available for your account.", "error"],
      };
      const [message, kind] = outcomes[google] ?? outcomes.failed!;
      toast(message, kind);
      setSettingsTab("connections");
    }
    // From a notification (v0.18.0): /?agent=briefing or /?agent=1 opens VESPER Agent (below, once the address is clean).
    const search = window.location.search;
    const initial = conversationIdFromPath();
    if (initial) {
      if (agentLink(search)) window.history.replaceState(null, "", window.location.pathname);
      void openConversation(initial, false);
    } else if (search) window.history.replaceState(null, "", "/");
    openFromLink(search);
    const onPop = (event: PopStateEvent) => {
      // VESPER Agent (v0.17.0): none of these move the chat. Our own step back after closing the agent; Back while it
      // is open (closes it); Forward into an earlier agent entry (stepped back over).
      if (ignorePop.current) {
        clearTimeout(ignorePop.current);
        ignorePop.current = null;
        return;
      }
      if (agentOpenRef.current) {
        agentEntry.current = false;
        setAgentOpen(false);
        return;
      }
      if ((event.state as { vesperAgent?: boolean } | null)?.vesperAgent) {
        skipNextPop();
        window.history.back();
        return;
      }
      const id = conversationIdFromPath();
      if (id) void openConversation(id, false);
      else newChat(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const researchOn = Boolean(features?.research.enabled);
  const send = async (text = input) => {
    // Files whose feature the admin switched off meanwhile can't be sent: remove them (and what was uploaded).
    if (!documentsOn && docFiles.length > 0) dropDocuments(docFiles);
    if (!tablesOn && tableFiles.length > 0) dropTables(tableFiles);
    const message = text.trim();
    const images = imagesOn ? attachments : [];
    const sheets = tablesOn ? tableFiles : [];
    const docs = documentsOn ? docFiles : [];
    const research = researchOn && researchMode;
    // A message may be only documents (e.g. "summarise this" is then implied), without text.
    if ((!message && images.length === 0 && sheets.length === 0 && docs.length === 0) || chat.streaming || preparing > 0) return;
    if (sheets.some((t) => t.status !== "ready") || docs.some((d) => d.status !== "ready")) return;
    if (images.length > 0 && selection.startsWith("ollama:")) {
      toast("Images work with the cloud models only. Remove the images or choose a cloud model.");
      return;
    }
    if (sheets.length > 0 && selection.startsWith("ollama:")) {
      toast("Spreadsheets work with the cloud models only. Remove the spreadsheet or choose a cloud model.");
      return;
    }
    if (docs.length > 0 && selection.startsWith("ollama:")) {
      toast("Documents work with the cloud models only. Remove the documents or choose a cloud model.");
      return;
    }
    if (research && (images.length > 0 || sheets.length > 0 || docs.length > 0 || !message)) {
      // Without text there is always something attached (an empty message isn't sent at all).
      const attached = [images.length ? "images" : "", sheets.length ? "spreadsheet" : "", docs.length ? "documents" : ""].filter(Boolean);
      toast(`Deep research works with text questions only. Remove the ${orList(attached)}, or turn Research off.`);
      return;
    }
    if (research && selection.startsWith("ollama:")) {
      toast("Deep research needs a cloud model. Choose Auto or another cloud model, or turn Research off.");
      return;
    }
    setInput("");
    setAttachments([]);
    setTableFiles([]);
    setDocFiles([]);
    setResearchMode(false);
    stopSpeaking();
    const accepted = await chat.send(
      message,
      selection,
      images.map(({ data, thumb }) => ({ data, thumb })),
      research,
      sheets.map(messageFile),
      docs.map(messageDocument),
    );
    if (!accepted) {
      // Put everything back, keeping files added while the message was on its way.
      setInput(message);
      setAttachments((list) => [...images, ...list]);
      setTableFiles((list) => [...sheets, ...list]);
      setDocFiles((list) => [...docs, ...list]);
      setResearchMode(research);
    }
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
  const heroBox = useRef<HTMLDivElement>(null);
  const launcherLift = useLauncherLift(heroBox, empty);
  const openArchived = archivedChat && archivedChat.id === chat.conversationId ? archivedChat : null;
  const activeTitle = conversations.find((c) => c.id === chat.conversationId)?.title ?? openArchived?.title ?? null;
  const firstName = (user.name ?? "").trim().split(/\s+/)[0] || null;
  const capabilities = Object.keys(CAPABILITY_LABELS).filter((name) => activeNames.has(name));
  const mediaChips = [
    ...(researchOn ? [{ key: "research", label: "Deep research", Icon: Telescope }] : []),
    ...(imagesOn ? [{ key: "images", label: "Understands images", Icon: Paperclip }] : []),
    ...(tablesOn ? [{ key: "tables", label: "Analyses spreadsheets", Icon: FileSpreadsheet }] : []),
    ...(documentsOn ? [{ key: "documents", label: "Reads documents", Icon: FileText }] : []),
    ...(features?.voice.speechToText ? [{ key: "voice", label: "Voice input", Icon: Mic }] : []),
  ];

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
      {researchOn ? <ResearchToggle on={researchMode} onChange={setResearchMode} runsPerDay={features!.research.runsPerDay} /> : null}
    </>
  );
  // 📎 and 🎤 appear only when the admin has them switched on and a service that can do them is set up.
  const composerMedia = {
    onFiles: addFiles,
    ...(imagesOn
      ? {
          attachments: {
            items: attachments,
            preparing,
            max: maxImages,
            onRemove: (id: string) => setAttachments((list) => list.filter((a) => a.id !== id)),
          },
        }
      : {}),
    ...(tablesOn
      ? {
          tables: {
            items: tableFiles,
            max: maxTables,
            onRemove: (id: string) => dropTables(tableFiles.filter((t) => t.id === id)),
          },
        }
      : {}),
    ...(documentsOn
      ? {
          documents: {
            items: docFiles,
            max: maxDocuments,
            onRemove: (id: string) => dropDocuments(docFiles.filter((d) => d.id === id)),
          },
        }
      : {}),
    ...(features?.voice.speechToText
      ? { voice: { maxSeconds: features.voice.maxRecordingSeconds, language: settings.speechLanguage, onError: (m: string) => toast(m) } }
      : {}),
  };

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
        onArchive={async (id) => {
          const target = conversations.find((c) => c.id === id);
          if (!target) return;
          // Out of the sidebar at once (an open chat goes to a new one); put back if the server says no.
          const wasOpen = chat.conversationId === id;
          setConversations((list) => list.filter((c) => c.id !== id));
          if (wasOpen) newChat();
          const archiving = api.archiveConversation(id, true);
          toast("Chat archived", "info", {
            label: "Undo",
            // After the archiving has gone through (if it failed, the chat is back already).
            run: () =>
              void archiving.then(
                () =>
                  api.archiveConversation(id, false).then(
                    ({ conversation }) => {
                      restoreToSidebar(conversation);
                      // Open again only if the view is still the empty new chat it went to (never over a new chat
                      // the user started meanwhile).
                      const now = chatRef.current;
                      if (wasOpen && !now.conversationId && now.messages.length === 0 && !now.streaming && !now.loading) {
                        void openConversationRef.current(id);
                      }
                    },
                    (e: unknown) => toast(e instanceof ApiError ? e.message : "Couldn't restore the chat."),
                  ),
                () => {},
              ),
          });
          try {
            await archiving;
          } catch (e) {
            restoreToSidebar(target);
            toast(e instanceof ApiError ? e.message : "Couldn't archive the chat.");
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
          await forgetPushDevice();
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
              <>
                <h2 className="truncate text-[15px] font-medium text-[var(--text)]" title={activeTitle}>
                  {activeTitle}
                </h2>
                {openArchived ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-soft)]"
                    title="This chat is archived. Sending a message moves it back to your chats."
                  >
                    <Archive size={11} aria-hidden="true" /> Archived
                  </span>
                ) : null}
              </>
            ) : (
              <span className="flex items-center gap-2 md:hidden">
                <VesperMark className="h-6 w-6" />
                <span className="font-[family-name:var(--font-display)] font-semibold tracking-[0.16em]">{appName}</span>
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
                <VesperMark full className="h-14 w-14 rounded-2xl shadow-[var(--shadow-md)]" />
                <h1 className="mt-5 font-[family-name:var(--font-display)] text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px]">
                  <span className="dusk-text">{greeting()}</span>
                  {firstName ? `, ${firstName}` : ""}
                </h1>
                <p className="mt-2 max-w-md text-[15px] text-[var(--text-soft)]">What would you like to explore today?</p>
              </div>

              <div ref={heroBox} className="rise-in mt-7">
                <Composer
                  variant="hero"
                  value={input}
                  onChange={setInput}
                  onSend={() => void send()}
                  onStop={chat.stop}
                  streaming={chat.streaming}
                  disabled={chat.loading}
                  placeholder={researchOn && researchMode ? "What should I research? (a few searches, then a report with sources)" : `Ask ${appName} anything…`}
                  controls={composerControls}
                  {...composerMedia}
                />
              </div>

              {activeTools !== null && capabilities.length + mediaChips.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5" aria-label="What Vesper can do">
                  {[
                    ...capabilities.map((name) => ({ key: name, label: CAPABILITY_LABELS[name]!, Icon: TOOL_ICONS[name] ?? Sparkles })),
                    ...mediaChips,
                  ].map(({ key, label, Icon }) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs text-[var(--text-soft)]"
                    >
                      <Icon size={12} className="text-[var(--accent)]" />
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}

            </div>
            {/* The message box is in the middle here, so the launcher sits in the corner (moved when the box reaches it). */}
            <div className="fixed bottom-6 right-4 z-20 flex sm:right-6" style={launcherLift === null ? undefined : { bottom: launcherLift }}>
              {agentLauncher()}
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
                      readAloud={voiceOn}
                      answerCheck={Boolean(features?.answerCheck?.enabled)}
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
                placeholder={researchOn && researchMode ? "What should I research?" : `Message ${appName}…`}
                controls={composerControls}
                {...composerMedia}
              />
              {/* Just above the message box, however tall it grows (so never over Send); bottom-right on wide screens. */}
              {agentLauncher("absolute bottom-full right-3 z-20 mb-2 sm:right-4 xl:fixed xl:bottom-6 xl:right-6 xl:mb-0")}
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
          features={features}
          onClose={() => setSettingsOpen(false)}
          onOpenConversation={(conversation) => {
            setSettingsOpen(false);
            void openConversation(conversation.id);
          }}
          onConversationRestored={(conversation) => {
            restoreToSidebar(conversation);
            if (archivedChatRef.current?.id === conversation.id) setArchivedChat(null);
          }}
          onConversationDeleted={(id) => {
            setConversations((list) => list.filter((c) => c.id !== id));
            if (chat.conversationId === id) newChat();
          }}
          onSaved={(saved) => {
            onSettings(saved);
            if (!chat.conversationId) setSelection(saved.defaultModel);
            setSettingsOpen(false);
            toast("Settings saved.", "info");
          }}
        />
      ) : null}
      {agentOpen ? (
        <LoadBoundary
          parts={[LazyAgentMode]}
          onError={() => {
            closeAgent();
            toast(LOAD_FAILED);
          }}
        >
          {() => {
            const props = {
              briefing: agentBriefing,
              briefingDay: agentBriefingDay,
              firstName,
              settings,
              features,
              origin: agentOrigin,
              onClose: closeAgent,
              onOpenInChat: openAgentChat,
              onConversationCreated: agentConversationCreated,
              onConversationActivity: agentConversationActivity,
            };
            const Ready = agentReady ? agentModule?.AgentMode : undefined;
            return Ready ? (
              <Ready key={agentRun} {...props} />
            ) : (
              <Suspense fallback={<DialogLoading label="Opening VESPER Agent…" agent />}>
                <LazyAgentMode.Component key={agentRun} {...props} />
              </Suspense>
            );
          }}
        </LoadBoundary>
      ) : null}
      {adminOpen && user.role === "admin" ? (
        <LoadBoundary
          parts={[AdminDialog]}
          onError={() => {
            setAdminOpen(false);
            toast(LOAD_FAILED);
          }}
        >
          {() => (
            <Suspense fallback={<DialogLoading label="Opening the admin panel…" />}>
              <AdminDialog.Component
                currentUserId={user.id}
                models={models}
                refreshingModels={refreshing}
                onRefreshModels={() => void loadModels(true)}
                onClose={() => setAdminOpen(false)}
                onNotice={toast}
              />
            </Suspense>
          )}
        </LoadBoundary>
      ) : null}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
