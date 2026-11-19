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
  /** Images attached and seconds of speech turned into text today (UTC). */
  todayImages: number;
  todaySpeechSeconds: number;
  /** Deep-research runs that finished today (failed or stopped runs aren't counted). */
  todayResearch: number;
  /** "Check this answer" checks that finished today. */
  todayAnswerChecks: number;
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
  /** Websites the admin trusts (e.g. "who.int"; subdomains included): ranked first in web search results. */
  trustedSites: string[];
  /** Websites never used in web search results (e.g. spammy statistics sites). */
  blockedSites: string[];
  /** Image attachments in chat (sent only to models that can see images). */
  imagesEnabled: boolean;
  /** Images each user may attach per UTC day (admins unlimited). */
  imagesPerDay: number;
  /** Voice: the microphone button (speech to text) and "Read aloud" on answers. */
  voiceEnabled: boolean;
  /** Minutes of speech each user may turn into text per UTC day (admins unlimited). */
  speechMinutesPerDay: number;
  /** Deep research: several searches, a few pages read, one written report. */
  researchEnabled: boolean;
  /** Research runs each user may finish per UTC day (admins unlimited). */
  researchRunsPerDay: number;
  /** The last N of the day's web searches are kept for normal chat: research can't use them. */
  researchSearchReserve: number;
  /** Let regular users run local models through Ollama on their own computer (admins always can). */
  localModelsForUsers: boolean;
  /** "Check this answer" under answers that used sources: one extra model request rates the key claims. */
  answerCheckEnabled: boolean;
  /** Checks each user may run per UTC day (admins unlimited). */
  answerChecksPerDay: number;
  /** Deep-research reports are checked against their sources automatically (one extra model request per run). */
  researchAutoCheck: boolean;
}

/** What the chat screen may offer right now (admin switches + whether a capable service is set up). */
export interface FeaturesDto {
  images: { enabled: boolean; perDay: number; maxPerMessage: number };
  /**
   * enabled: the admin's Voice switch (covers "Read aloud", which runs on the device).
   * speechToText: the microphone button can be offered (Voice on + Groq or Workers AI available).
   */
  voice: { enabled: boolean; speechToText: boolean; minutesPerDay: number; maxRecordingSeconds: number };
  /** The Research button: switch on, web search set up, and the daily cap above the searches kept for chat. */
  research: { enabled: boolean; runsPerDay: number };
  /** Settings → Local models (Ollama): always for admins; for users only when the admin allows it. */
  localModels: boolean;
  /** "Check this answer" under answers that used sources (v0.11.0). */
  answerCheck: { enabled: boolean; perDay: number };
}

export interface TranscriptionDto {
  text: string;
  /** Seconds of speech counted against today's limit. */
  seconds: number;
}

/** Speech language for the microphone: auto-detect, English or Urdu. */
export type SpeechLanguage = "auto" | "en" | "ur";

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
  /** Language spoken into the microphone ("auto" lets the speech service detect it). */
  speechLanguage: SpeechLanguage;
  /** Read each new answer aloud with the device's built-in voice. */
  readAloud: boolean;
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
  speechLanguage: "auto",
  readAloud: false,
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

/**
 * A cited source, shown under the answer: a numbered link for web pages, or a document chip such as
 * "Handbook.pdf · page 12" for knowledge-base documents (their files aren't stored, so no link).
 */
export interface SourceDto {
  title: string;
  /** http(s) link. Absent for knowledge-base files. */
  url?: string;
  /** Where in a document, e.g. "page 12" (knowledge-base sources). */
  location?: string;
}

// ------------------------------------------------------------------ Knowledge base (admin panel → Knowledge)

export type KnowledgeDocKind = "pdf" | "docx" | "txt" | "md" | "csv" | "web";

export interface KnowledgeDocumentDto {
  id: string;
  collectionId: string;
  title: string;
  kind: KnowledgeDocKind;
  sourceUrl: string | null;
  /** "uploading" = not finished (an interrupted upload); only "ready" documents are searched. */
  status: "uploading" | "ready";
  pages: number | null;
  chunkCount: number;
  charCount: number;
  createdAt: number;
}

export interface KnowledgeCollectionDto {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  documents: KnowledgeDocumentDto[];
}

export interface KnowledgeUsageDto {
  /** Characters of stored text, and the free-tier budget for the whole knowledge base. */
  chars: number;
  maxChars: number;
  documents: number;
}

/** One passage of a document, prepared in the browser (files) or on the server (web pages). */
export interface KnowledgeChunkInput {
  seq: number;
  /** e.g. "page 12", "section “Leave policy”", "rows 2–41" (may be empty). */
  location: string;
  text: string;
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
  /** Always given to the assistant; unpinned memories are given only when related to the message (v0.10.0). */
  pinned?: boolean;
  /** When the text was last edited (null = never). */
  updatedAt?: number | null;
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
  /** Small previews (JPEG data URLs) of images attached to a user message. The full images are not kept. */
  images?: string[] | null;
  /** The user's 👍/👎 on this answer (assistant messages only). */
  feedback?: MessageFeedbackDto | null;
  /** The answer used sources that were kept, so it can be checked against them ("Check this answer", v0.11.0). */
  checkable?: boolean;
  /** The result of checking the answer against its sources (null = not checked). */
  verification?: VerificationDto | null;
  createdAt: number;
}

// ------------------------------------------------------------------ Answer verification (v0.11.0)

/** supported: a source states it; contradicted: a source says something different; not_found: no source says it. */
export type ClaimVerdict = "supported" | "contradicted" | "not_found";
export const CLAIM_VERDICTS: readonly ClaimVerdict[] = ["supported", "contradicted", "not_found"];

export interface VerifiedClaimDto {
  /** The claim, in short, as the answer states it. */
  claim: string;
  verdict: ClaimVerdict;
  /** The source that supports or contradicts it (only sources the answer really used). */
  source: SourceDto | null;
  /** For a contradicted claim: what the source says instead. */
  note: string | null;
}

export interface VerificationDto {
  /** The key claims, in the order the answer makes them (empty: nothing specific to check). */
  claims: VerifiedClaimDto[];
  /** "user": Check this answer; "auto": a deep-research report checked automatically. */
  trigger: "user" | "auto";
  checkedAt: number;
  /** Which model checked it, e.g. "gemini:gemini-2.5-flash-lite" (admins only; removed for users). */
  by?: string | null;
}

// ------------------------------------------------------------------ Answer feedback (👍/👎, v0.9.7)

export type FeedbackReason = "wrong" | "outdated" | "unanswered" | "other";
export const FEEDBACK_REASONS: readonly FeedbackReason[] = ["wrong", "outdated", "unanswered", "other"];

export interface MessageFeedbackDto {
  /** 1 = 👍, -1 = 👎 */
  rating: 1 | -1;
  reason: FeedbackReason | null;
  note: string | null;
}

/** One rating as the admin sees it (Admin panel → Feedback), with its own copy of the question and answer. */
export interface FeedbackItemDto extends MessageFeedbackDto {
  messageId: string;
  user: { login: string; name: string | null };
  question: string;
  answer: string;
  provider: string | null;
  model: string | null;
  sources: SourceDto[];
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackSummaryDto {
  up: number;
  down: number;
  /** Ratings per model (most rated first). */
  byModel: { provider: string | null; model: string | null; up: number; down: number }[];
}

/** An image attached to a chat message: the resized image for the model and a small preview to keep. */
export interface ChatImageInput {
  /** data:image/jpeg;base64,… (resized in the browser, ~1280 px). */
  data: string;
  /** data:image/jpeg;base64,… (~384 px preview, stored with the message). */
  thumb: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextLength?: number;
  /** The model accepts images (from the provider's model list, where it says so). */
  vision?: boolean;
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
