/** Types shared by the Worker API and the web client. */

export type ProviderId = "groq" | "gemini" | "openrouter" | "mistral" | "workers-ai";
export const PROVIDER_IDS: readonly ProviderId[] = ["groq", "gemini", "openrouter", "mistral", "workers-ai"];

/** "auto" lets the server pick a free provider; otherwise "<provider>:<model id>" or "ollama:<model>". */
export type ModelSelection = string;
export const AUTO_MODEL = "auto";

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "partial" | "error";

export interface UserDto {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface UserSettings {
  defaultModel: ModelSelection;
  /** When a manually selected model fails, try the automatic free chain instead of stopping. */
  fallback: boolean;
  /** Extra instructions appended to the system prompt. */
  systemPrompt: string;
  /** Optional local models through the browser (the cloud server never calls this URL). */
  ollamaEnabled: boolean;
  ollamaUrl: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultModel: AUTO_MODEL,
  fallback: true,
  systemPrompt: "",
  ollamaEnabled: false,
  ollamaUrl: "http://localhost:11434",
};

export interface ConversationDto {
  id: string;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDto {
  id: string;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  provider: string | null;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextLength?: number;
}

export interface ProviderStatusDto {
  id: ProviderId;
  label: string;
  configured: boolean;
  defaultModel: string | null;
  models: ModelInfo[];
  cooldownUntil: number | null;
  lastError: string | null;
  today: { requests: number; failures: number };
  freeTier: string;
  notes: string[];
  signupUrl: string;
}

export interface ModelsResponse {
  providers: ProviderStatusDto[];
  order: ProviderId[];
}

export interface PublicConfigDto {
  appName: string;
  githubLogin: boolean;
  devLogin: boolean;
}

/** Events streamed from POST /api/chat. */
export type ChatStreamEvent =
  | { type: "conversation"; conversation: ConversationDto }
  | { type: "user_message"; message: MessageDto }
  | { type: "attempt"; provider: ProviderId; model: string }
  | { type: "fallback"; from: { provider: ProviderId; model: string }; reason: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; message: MessageDto }
  | { type: "error"; code: string; message: string; retryable: boolean; assistantMessage?: MessageDto };

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface LocalPrepareResponse {
  conversation: ConversationDto;
  userMessage: MessageDto;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}
