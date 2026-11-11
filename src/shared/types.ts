/** Types shared by the Worker API and the web client. */

export type ProviderId = "groq" | "gemini" | "openrouter" | "mistral" | "workers-ai";
export const PROVIDER_IDS: readonly ProviderId[] = ["groq", "gemini", "openrouter", "mistral", "workers-ai"];

/** "auto" lets the server pick a free provider; otherwise "<provider>:<model id>" or "ollama:<model>". */
export type ModelSelection = string;
export const AUTO_MODEL = "auto";

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "partial" | "error";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "blocked";

export interface UserDto {
  id: string;
  /** GitHub username, or the email address for Google-only accounts. */
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  role: UserRole;
}

/** A user as listed in the admin panel. */
export interface AdminUserDto extends UserDto {
  status: UserStatus;
  /** Personal daily message limit; null = the app-wide default. */
  dailyLimit: number | null;
  todayMessages: number;
  conversations: number;
  github: boolean;
  google: boolean;
  createdAt: number;
  lastLoginAt: number;
}

/** App-wide settings managed by the admin. */
export interface AppSettingsDto {
  /** When false, new accounts can't be created (existing users keep working). */
  signupsOpen: boolean;
  /** Messages per user per day (admins are unlimited). */
  defaultDailyLimit: number;
  /** Instructions added to every user's system prompt. */
  botInstructions: string;
  /** Tools switched off for everyone. */
  disabledTools: string[];
  /** Let regular users see the model's thinking notes ("Reasoning"). Admins always see them. */
  showReasoningToUsers: boolean;
  /** Models regular users may pick (besides Auto), with friendly names. Admins can pick any model. */
  userModels: UserModelOption[];
  /** Web searches allowed per UTC day for the whole app (protects the free search quota). 0 = web search off. */
  webSearchDailyLimit: number;
}

/** A model the admin made available to users, e.g. { value: "groq:openai/gpt-oss-120b", label: "Smart" }. */
export interface UserModelOption {
  value: string;
  label: string;
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
  /** Master switch for tool use (calculator, memory, …). */
  toolsEnabled: boolean;
  /** Names of individual tools the user switched off. */
  disabledTools: string[];
  /** Include saved memories in every conversation and allow the assistant to save new ones. */
  memoryEnabled: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultModel: AUTO_MODEL,
  fallback: true,
  systemPrompt: "",
  ollamaEnabled: false,
  ollamaUrl: "http://localhost:11434",
  toolsEnabled: true,
  disabledTools: [],
  memoryEnabled: true,
};

/** One tool call made while producing a reply. */
export interface ToolEventDto {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  /** Short human-readable outcome shown in the UI. */
  summary: string | null;
  /** Where the information came from (web pages, Wikipedia, weather/currency services). Shown to everyone. */
  sources?: SourceDto[];
}

/** A cited source: shown as a numbered link under the answer. */
export interface SourceDto {
  title: string;
  url: string;
}

/** A tool as listed in Settings. */
export interface ToolInfoDto {
  name: string;
  label: string;
  description: string;
  /** "read": only looks things up. "write": changes data in your own account. */
  risk: "read" | "write";
  requiresMemory: boolean;
  /** False when the server lacks what it needs (e.g. web search without TAVILY_API_KEY). */
  available: boolean;
}

export interface MemoryDto {
  id: string;
  content: string;
  source: "assistant" | "user";
  createdAt: number;
}

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
  tools: ToolEventDto[] | null;
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
  /**
   * Regular users: the models the admin made available (besides Auto), with friendly names; the
   * model menu shows only these. Admins: null (they get the full list).
   */
  userModels: UserModelOption[] | null;
}

export interface PublicConfigDto {
  appName: string;
  githubLogin: boolean;
  googleLogin: boolean;
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
  | { type: "tool"; tool: ToolEventDto }
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
