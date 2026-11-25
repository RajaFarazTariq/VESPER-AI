import { SseParser } from "../../shared/sse";
import type {
  AdminUserDto,
  ApiErrorBody,
  AppSettingsDto,
  ChatDocumentDto,
  ChatDocumentKind,
  ChatImageInput,
  ChatStreamEvent,
  ConnectionsDto,
  ConversationDto,
  FeaturesDto,
  FeedbackItemDto,
  FeedbackReason,
  FeedbackSummaryDto,
  GithubActionDto,
  GoogleActionDto,
  KnowledgeChunkInput,
  KnowledgeCollectionDto,
  KnowledgeDocKind,
  KnowledgeDocumentDto,
  KnowledgeUsageDto,
  LocalPrepareResponse,
  MemoryDto,
  MessageDto,
  MessageFeedbackDto,
  ModelsResponse,
  NotificationPrefsDto,
  NotificationsDto,
  PushDeviceDto,
  PublicConfigDto,
  TableChunkInput,
  TableFileDto,
  TableFileKind,
  TableSheetInput,
  SpeechLanguage,
  StorageDto,
  ToolInfoDto,
  TranscriptionDto,
  UserDto,
  UserSettings,
  VerificationDto,
} from "../../shared/types";

export type ChatRequestBody = {
  conversationId?: string;
  message?: string;
  model: string;
  regenerate?: boolean;
  edit?: boolean;
  images?: ChatImageInput[];
  /** Deep research (v0.9.8). */
  research?: boolean;
  /** Spreadsheets added through api.files, sent with this message (v0.14.0). */
  files?: string[];
  /** Documents added through api.documents, sent with this message (v0.16.0). */
  documents?: string[];
  /** VESPER Agent (v0.17.0): short spoken replies; tasks are done with the tools and confirmed in a sentence. */
  agent?: boolean;
  /** VESPER Agent's daily briefing (v0.18.0), only with `agent`: a short spoken briefing for today or tomorrow. */
  briefing?: boolean;
  /** The day the briefing is about ("YYYY-MM-DD"), from the notification's link. */
  briefingDay?: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `Request failed (${response.status}).`;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    if (response.status >= 500) message = "The server is unavailable. Please try again shortly.";
  }
  return new ApiError(response.status, code, message);
}

/** The user's time zone name (e.g. "Asia/Karachi"), so "today" means their today, not UTC's. */
function browserTimeZone(): { timeZone?: string } {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone ? { timeZone } : {};
  } catch {
    return {};
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

export const api = {
  config: () => request<PublicConfigDto>("/api/auth/config"),
  me: () => request<{ user: UserDto; settings: UserSettings }>("/api/auth/me"),
  devLogin: (login: string) => request<{ user: UserDto }>("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST", body: "{}" }),

  listConversations: (before?: number) =>
    request<{ conversations: ConversationDto[]; hasMore: boolean }>(
      `/api/conversations?limit=50${before ? `&before=${before}` : ""}`,
    ),
  getConversation: (id: string) =>
    request<{ conversation: ConversationDto; messages: MessageDto[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: ConversationDto }>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    request<{ ok: true }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  models: (refresh = false) => request<ModelsResponse>(`/api/models${refresh ? "?refresh=1" : ""}`),
  updateSettings: (patch: Partial<UserSettings>) =>
    request<{ settings: UserSettings }>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  tools: () => request<{ tools: ToolInfoDto[] }>("/api/tools"),
  features: () => request<FeaturesDto>("/api/media/features"),
  /** rating 0 takes a 👍/👎 back. */
  feedback: (messageId: string, body: { rating: 1 | -1 | 0; reason?: FeedbackReason | null; note?: string | null }) =>
    request<{ feedback: MessageFeedbackDto | null }>(`/api/feedback/${encodeURIComponent(messageId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /**
   * Settings → Connections (v0.12.0; GitHub changes v0.13.0). Connecting is a normal link to
   * /api/connections/github/start (reading) or /api/connections/github-actions/start (changes).
   */
  connections: () => request<ConnectionsDto>("/api/connections"),
  disconnectGithub: () => request<ConnectionsDto>("/api/connections/github/disconnect", { method: "POST", body: "{}" }),
  disconnectGithubActions: () => request<ConnectionsDto>("/api/connections/github-actions/disconnect", { method: "POST", body: "{}" }),
  /** A GitHub change waiting for (or given) the user's decision (v0.13.0). */
  githubAction: (id: string) => request<{ action: GithubActionDto }>(`/api/github-actions/${encodeURIComponent(id)}`),
  approveGithubAction: (id: string) =>
    request<{ action: GithubActionDto }>(`/api/github-actions/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  rejectGithubAction: (id: string) =>
    request<{ action: GithubActionDto }>(`/api/github-actions/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" }),
  /** Google Calendar and Gmail (v0.15.0). Connecting is a normal link to /api/connections/google/start. */
  disconnectGoogle: () => request<ConnectionsDto>("/api/connections/google/disconnect", { method: "POST", body: "{}" }),
  /** An email or calendar event waiting for (or given) the user's decision. */
  googleAction: (id: string) => request<{ action: GoogleActionDto }>(`/api/google-actions/${encodeURIComponent(id)}`),
  /** Approve; for an email, the version the user may have edited on the card. */
  approveGoogleAction: (id: string, email?: { to: string[]; cc: string[]; subject: string; body: string }) =>
    request<{ action: GoogleActionDto }>(`/api/google-actions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(email ? { email } : {}),
    }),
  rejectGoogleAction: (id: string) =>
    request<{ action: GoogleActionDto }>(`/api/google-actions/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" }),
  /** "Check this answer" (v0.11.0): the answer's key claims rated against its sources (saved; asking again is free). */
  checkAnswer: (messageId: string) =>
    request<{ verification: VerificationDto }>(`/api/answer-check/${encodeURIComponent(messageId)}`, { method: "POST", body: "{}" }),
  transcribe: (body: { audio: string; mimeType: string; seconds: number; language?: SpeechLanguage }) =>
    request<TranscriptionDto>("/api/media/transcribe", { method: "POST", body: JSON.stringify(body) }),
  /**
   * VESPER Agent's studio voice (v0.17.1): the text read by the server's natural voice, as MP3 bytes. Errors are the
   * server's ApiError (e.g. 429 studio_voice_limit: today's characters are used up).
   */
  speech: async (text: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    let response: Response;
    try {
      response = await fetch("/api/media/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text }),
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
    }
    if (!response.ok) throw await toApiError(response);
    return response.arrayBuffer();
  },
  /** Spreadsheets (v0.14.0): the overview first, then the rows in blocks, then ready. Removing works until it's sent. */
  files: {
    create: (body: { name: string; kind: TableFileKind; bytes: number; tables: TableSheetInput[] }, signal?: AbortSignal) =>
      request<{ file: TableFileDto }>("/api/files", { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) }),
    addChunks: (fileId: string, table: string, chunks: TableChunkInput[], signal?: AbortSignal) =>
      request<{ stored: number; expected: number }>(`/api/files/${encodeURIComponent(fileId)}/chunks`, {
        method: "POST",
        body: JSON.stringify({ table, chunks }),
        ...(signal ? { signal } : {}),
      }),
    complete: (fileId: string, signal?: AbortSignal) =>
      request<{ file: TableFileDto }>(`/api/files/${encodeURIComponent(fileId)}/complete`, { method: "POST", body: "{}", ...(signal ? { signal } : {}) }),
    remove: (fileId: string) => request<{ ok: true }>(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }),
  },
  /**
   * Documents in chat (v0.16.0): the document's details first, then its passages in batches, then ready. Only the
   * text is sent (the file is read in the browser). Removing works until it's sent.
   */
  documents: {
    create: (body: { name: string; kind: ChatDocumentKind; bytes: number; pages: number | null; expectedChunks: number; totalChars: number }) =>
      request<{ document: ChatDocumentDto }>("/api/documents", { method: "POST", body: JSON.stringify(body) }),
    addChunks: (documentId: string, chunks: KnowledgeChunkInput[], signal?: AbortSignal) =>
      request<{ document: ChatDocumentDto }>(`/api/documents/${encodeURIComponent(documentId)}/chunks`, {
        method: "POST",
        body: JSON.stringify({ chunks }),
        ...(signal ? { signal } : {}),
      }),
    complete: (documentId: string, signal?: AbortSignal) =>
      request<{ document: ChatDocumentDto }>(`/api/documents/${encodeURIComponent(documentId)}/complete`, {
        method: "POST",
        body: "{}",
        ...(signal ? { signal } : {}),
      }),
    remove: (documentId: string) => request<{ ok: true }>(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  },
  /**
   * Settings → Notifications (v0.18.0): this user's devices with notifications on, the briefing and meeting-alert
   * settings, and pending reminders. Every change sends the browser's time zone.
   */
  notifications: {
    get: () => request<NotificationsDto>("/api/notifications"),
    /** Saves this browser's push subscription (the same endpoint again updates it). */
    addDevice: (body: { endpoint: string; keys: { p256dh: string; auth: string }; label: string; timeZone: string }) =>
      request<{ device: PushDeviceDto }>("/api/notifications/devices", { method: "POST", body: JSON.stringify(body) }),
    removeDevice: (id: string) => request<{ ok: true }>(`/api/notifications/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** "VESPER notifications are on" to every device: how many it reached. */
    test: () => request<{ sent: number; failed: number }>("/api/notifications/test", { method: "POST", body: "{}" }),
    updatePrefs: (patch: { briefingEnabled?: boolean; briefingTime?: string; meetingAlerts?: boolean; meetingMinutes?: number }) =>
      request<{ prefs: NotificationPrefsDto }>("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ ...patch, ...browserTimeZone() }) }),
  },
  /** Cancels a pending reminder (it won't be sent). */
  cancelReminder: (id: string) => request<{ ok: true }>(`/api/reminders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listMemories: () => request<{ memories: MemoryDto[] }>("/api/memories"),
  addMemory: (content: string) => request<{ memory: MemoryDto }>("/api/memories", { method: "POST", body: JSON.stringify({ content }) }),
  /** Edit the text and/or pin ("always use") a memory. */
  updateMemory: (id: string, patch: { content?: string; pinned?: boolean }) =>
    request<{ memory: MemoryDto }>(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMemory: (id: string) => request<{ ok: true }>(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAllMemories: () => request<{ deleted: number }>("/api/memories", { method: "DELETE" }),

  admin: {
    users: () => request<{ users: AdminUserDto[] }>("/api/admin/users"),
    updateUser: (id: string, patch: { status?: "active" | "blocked"; dailyLimit?: number | null }) =>
      request<{ user: AdminUserDto }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
    settings: () =>
      request<{
        settings: AppSettingsDto;
        tools: ToolInfoDto[];
        webSearch: { keyConfigured: boolean; usedToday: number };
        github?: { configured: boolean };
        githubActions?: { configured: boolean };
        google?: { configured: boolean };
        tables?: { rowsReadToday: number };
        /** How full the database is (v0.16.0). */
        storage?: StorageDto;
        /** Characters the studio voice read today for the whole app (v0.17.1). */
        studioVoice?: { charsToday: number };
      }>(
        "/api/admin/settings",
      ),
    updateSettings: (patch: Partial<AppSettingsDto>) =>
      request<{ settings: AppSettingsDto }>("/api/admin/settings", { method: "PUT", body: JSON.stringify(patch) }),
    feedback: (rating: "up" | "down" | "all", before?: number) =>
      request<{ items: FeedbackItemDto[]; hasMore: boolean; summary: FeedbackSummaryDto }>(
        `/api/admin/feedback?rating=${rating}${before ? `&before=${before}` : ""}`,
      ),

    knowledge: {
      list: () => request<{ collections: KnowledgeCollectionDto[]; usage: KnowledgeUsageDto }>("/api/admin/knowledge"),
      createCollection: (body: { name: string; description: string }) =>
        request<{ collection: KnowledgeCollectionDto }>("/api/admin/knowledge/collections", { method: "POST", body: JSON.stringify(body) }),
      updateCollection: (id: string, patch: { name?: string; description?: string }) =>
        request<{ ok: true }>(`/api/admin/knowledge/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
      deleteCollection: (id: string) =>
        request<{ ok: true }>(`/api/admin/knowledge/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
      createDocument: (body: {
        collectionId: string;
        title: string;
        kind: Exclude<KnowledgeDocKind, "web">;
        pages: number | null;
        expectedChunks: number;
        totalChars: number;
      }) => request<{ document: KnowledgeDocumentDto }>("/api/admin/knowledge/documents", { method: "POST", body: JSON.stringify(body) }),
      addChunks: (documentId: string, chunks: KnowledgeChunkInput[]) =>
        request<{ document: KnowledgeDocumentDto }>(`/api/admin/knowledge/documents/${encodeURIComponent(documentId)}/chunks`, {
          method: "POST",
          body: JSON.stringify({ chunks }),
        }),
      completeDocument: (documentId: string) =>
        request<{ document: KnowledgeDocumentDto }>(`/api/admin/knowledge/documents/${encodeURIComponent(documentId)}/complete`, {
          method: "POST",
          body: "{}",
        }),
      deleteDocument: (documentId: string) =>
        request<{ ok: true }>(`/api/admin/knowledge/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
      addWebPage: (collectionId: string, url: string) =>
        request<{ document: KnowledgeDocumentDto }>("/api/admin/knowledge/web", { method: "POST", body: JSON.stringify({ collectionId, url }) }),
    },
  },

  localPrepare: (body: { conversationId?: string; message?: string; regenerate?: boolean; edit?: boolean; model: string }) =>
    request<LocalPrepareResponse>("/api/chat/local/prepare", {
      method: "POST",
      body: JSON.stringify({ ...body, ...browserTimeZone() }),
    }),
  localComplete: (body: {
    conversationId: string;
    model: string;
    content: string;
    reasoning?: string;
    status: "complete" | "partial" | "error";
    error?: string;
  }) => request<{ message: MessageDto }>("/api/chat/local/complete", { method: "POST", body: JSON.stringify(body) }),
};

/**
 * POST /api/chat and consume the Server-Sent Events stream.
 * Throws ApiError if the request is rejected before streaming starts.
 */
export async function streamChat(
  body: ChatRequestBody,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, ...browserTimeZone() }),
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  if (!response.ok || !response.body) throw await toApiError(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let sawTerminal = false;
  const dispatch = (data: string) => {
    try {
      const event = JSON.parse(data) as ChatStreamEvent;
      if (event.type === "done" || event.type === "error") sawTerminal = true;
      onEvent(event);
    } catch {
      // ignore malformed frames
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) dispatch(event.data);
    }
    for (const event of parser.flush()) dispatch(event.data);
  } catch (error) {
    if (signal.aborted) return;
    throw new ApiError(0, "stream_interrupted", "The connection dropped while the reply was streaming.");
  }
  if (!sawTerminal && !signal.aborted) {
    throw new ApiError(0, "stream_interrupted", "The reply ended unexpectedly. Please retry.");
  }
}
