import { SseParser } from "../../shared/sse";
import type {
  AdminUserDto,
  ApiErrorBody,
  AppSettingsDto,
  ChatStreamEvent,
  ConversationDto,
  LocalPrepareResponse,
  MemoryDto,
  MessageDto,
  ModelsResponse,
  PublicConfigDto,
  ToolInfoDto,
  UserDto,
  UserSettings,
} from "../../shared/types";

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
  listMemories: () => request<{ memories: MemoryDto[] }>("/api/memories"),
  addMemory: (content: string) => request<{ memory: MemoryDto }>("/api/memories", { method: "POST", body: JSON.stringify({ content }) }),
  deleteMemory: (id: string) => request<{ ok: true }>(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAllMemories: () => request<{ deleted: number }>("/api/memories", { method: "DELETE" }),

  admin: {
    users: () => request<{ users: AdminUserDto[] }>("/api/admin/users"),
    updateUser: (id: string, patch: { status?: "active" | "blocked"; dailyLimit?: number | null }) =>
      request<{ user: AdminUserDto }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
    settings: () =>
      request<{ settings: AppSettingsDto; tools: ToolInfoDto[]; webSearch: { keyConfigured: boolean; usedToday: number } }>(
        "/api/admin/settings",
      ),
    updateSettings: (patch: Partial<AppSettingsDto>) =>
      request<{ settings: AppSettingsDto }>("/api/admin/settings", { method: "PUT", body: JSON.stringify(patch) }),
  },

  localPrepare: (body: { conversationId?: string; message?: string; regenerate?: boolean; model: string }) =>
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
  body: { conversationId?: string; message?: string; model: string; regenerate?: boolean },
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
