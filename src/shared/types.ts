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
  /** Connected their GitHub through the VESPER GitHub App (v0.12.0). */
  githubConnected?: boolean;
  /** Connected the Actions app for GitHub changes (v0.13.0). */
  githubActionsConnected?: boolean;
  /** GitHub changes they approved today that went through (v0.13.0). */
  todayGithubActions?: number;
  /** Spreadsheets (CSV/Excel) they added today (v0.14.0). */
  todayTables?: number;
  /** Connected Google Calendar and/or Gmail (v0.15.0). */
  googleConnected?: boolean;
  /** Emails sent and calendar events added today after their approval (v0.15.0). */
  todayEmails?: number;
  todayEvents?: number;
  /** Documents (PDF, Word, text) they added to chats today (v0.16.0). */
  todayDocuments?: number;
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
  /** Regular users may connect their own GitHub (read-only, v0.12.0). Admins always can when the app is set up. */
  githubForUsers: boolean;
  /**
   * Regular users may let VESPER prepare GitHub changes (issues, comments, pull requests) that they approve one by one
   * (v0.13.0, the separate "Actions" GitHub App). Admins always can when that app is set up.
   */
  githubActionsForUsers: boolean;
  /** Approved GitHub changes each user may make per UTC day (admins unlimited). */
  githubActionsPerDay: number;
  /** Spreadsheets (CSV and Excel) in chat: attach a file and ask questions; exact figures are calculated (v0.14.0). */
  tablesEnabled: boolean;
  /** Spreadsheets each user may add per UTC day (admins unlimited). */
  tablesPerDay: number;
  /**
   * Spreadsheet rows the database may read for calculations per UTC day, for the whole app. Cloudflare's free D1
   * allows 5 million rows read a day for everything, and every database request fails once that is used up, so
   * calculations get their own share (a question reads each row of its table about once or twice).
   */
  tablesRowsPerDay: number;
  /**
   * Regular users may connect Google Calendar and Gmail (v0.15.0): VESPER reads their calendar, and prepares events
   * and emails that they approve one by one. Admins always can when Google is set up.
   */
  googleForUsers: boolean;
  /** Approved emails each user may send per UTC day (admins unlimited). */
  emailsPerDay: number;
  /** Approved calendar events each user may add per UTC day (admins unlimited). */
  eventsPerDay: number;
  /** Documents in chat (v0.16.0): attach a PDF, Word, text or Markdown file and ask about it, with page citations. */
  documentsEnabled: boolean;
  /** Documents each user may add per UTC day (admins unlimited). */
  documentsPerDay: number;
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
  /** Settings → Connections → GitHub: the GitHub App is set up and this account may use it (v0.12.0). */
  github: { available: boolean };
  /** Settings → Connections → GitHub changes: the Actions app is set up and this account may use it (v0.13.0). */
  githubActions: { available: boolean };
  /**
   * Spreadsheets in chat (v0.14.0): the admin's switch, with the Table analysis tool not switched off for everyone.
   * The limits are shown in the message box and checked again by the server.
   */
  tables: { enabled: boolean; perDay: number; perChat: number; maxRows: number; maxMegabytes: number };
  /** Settings → Connections → Google: Google is set up and this account may use it (v0.15.0). */
  google: { available: boolean };
  /**
   * Documents in chat (v0.16.0): the admin's switch, with the document tools not switched off for everyone.
   * The limits are shown in the message box and checked again by the server.
   */
  documents: { enabled: boolean; perDay: number; perChat: number; perMessage: number; maxPages: number; maxMegabytes: number };
}

// ------------------------------------------------------------------ Connections: GitHub, read-only (v0.12.0)

export interface GithubInstallationDto {
  /** The user or organisation VESPER is installed on. */
  account: string;
  type: "User" | "Organization";
  /** true: every repo of that account; false: only the repos chosen on GitHub. */
  allRepos: boolean;
  /** Where to change the choice on GitHub. */
  manageUrl: string | null;
}

export interface GithubConnectionDto {
  /** The GitHub App is set up and this account may use it. */
  available: boolean;
  /** none: never connected (or disconnected); reconnect: GitHub removed or expired the access. */
  status: "none" | "connected" | "reconnect";
  login: string | null;
  /** github.com page to choose which repos VESPER may read. */
  installUrl: string | null;
  installations: GithubInstallationDto[];
  /** Repos VESPER can read (up to 100). */
  repos: { fullName: string; private: boolean }[];
  reposTruncated: boolean;
  /** Couldn't ask GitHub right now (the connection itself is fine). */
  error: string | null;
}

/** Settings → Connections: reading (VESPER AI Reader) and changes with approval (the Actions app, v0.13.0). */
export interface ConnectionsDto {
  github: GithubConnectionDto;
  githubActions: GithubConnectionDto;
  /** The user's latest GitHub changes (newest first, up to 20), for the log under "Changes". */
  recentActions: GithubActionDto[];
  /** Google Calendar and Gmail (v0.15.0). */
  google: GoogleConnectionDto;
  /** The user's latest emails and events prepared by VESPER (newest first, up to 20). */
  recentGoogleActions: GoogleActionDto[];
}

// ------------------------------------------------------------------ Google Calendar and Gmail (v0.15.0)

export interface GoogleConnectionDto {
  /** Google is set up and this account may use it. */
  available: boolean;
  /** none: never connected (or disconnected); reconnect: Google ended the access (every 7 days while in testing). */
  status: "none" | "connected" | "reconnect";
  /** The Google account that was connected (it may differ from the one used to sign in). */
  email: string | null;
  /** What the user allowed on Google's screen. */
  calendar: boolean;
  gmailSend: boolean;
}

export type GoogleActionKind = "email" | "event";

/** What a chat step carries: enough to draw the card's heading; the card loads the rest. */
export interface GoogleActionRefDto {
  id: string;
  kind: GoogleActionKind;
  /** The email's subject or the event's title. */
  title: string;
}

export interface GoogleEmailPreviewDto {
  to: string[];
  cc: string[];
  subject: string;
  /** Plain text. */
  body: string;
  /** The Google account it is sent from. */
  from: string;
}

export interface GoogleEventPreviewDto {
  title: string;
  /** "2026-12-02T10:00" (timed) or "2026-12-02" (all day), in `timeZone`. */
  start: string;
  /** Timed: the end time. All day: the LAST day (inclusive). */
  end: string;
  allDay: boolean;
  timeZone: string;
  /** The calendar's own time zone, when it differs from `timeZone`. */
  calendarTimeZone: string | null;
  location: string;
  description: string;
  /** Guests who get an invitation email from Google. */
  attendees: string[];
  /** Add a Google Meet link. */
  meet: boolean;
  /** Events already in the calendar at that time (up to 5). */
  clashes: { title: string; start: string; end: string; allDay: boolean }[];
  /**
   * Pop-up reminders (v0.15.1): when each fires (local time in `timeZone`, "2026-11-25T23:00") and the minutes before
   * the start that Google stores. Absent: the calendar's default reminders.
   */
  reminders?: { at: string; minutes: number }[];
  /** The Google account whose calendar it goes in. */
  account: string;
}

/**
 * pending: waiting for Approve/Reject. running: being sent. done: sent / added (resultUrl). failed: Google refused
 * (error). rejected: the user said no. expired: not decided within 24 hours.
 */
export type GoogleActionStatus = "pending" | "running" | "done" | "failed" | "rejected" | "expired";

export interface GoogleActionDto extends GoogleActionRefDto {
  status: GoogleActionStatus;
  /** Who it goes to ("to ann@example.com") or when the event is ("Tue 2 Dec, 10:00–11:00"): kept for the log. */
  target: string;
  /** Plain-language cautions shown on the card. */
  warnings: string[];
  /** Exactly what will be sent; null once decided. */
  email: GoogleEmailPreviewDto | null;
  event: GoogleEventPreviewDto | null;
  resultUrl: string | null;
  error: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
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
  /** A GitHub change this step prepared, waiting for the user's approval (v0.13.0). The card loads its details. */
  action?: GithubActionRefDto;
  /** A spreadsheet calculation's whole result: the chart or table under the answer, with a CSV download (v0.14.1). */
  table?: TableResultDto;
  /** An email or calendar event this step prepared, waiting for the user's approval (v0.15.0). */
  google?: GoogleActionRefDto;
}

// ------------------------------------------------------------------ GitHub changes with approval (v0.13.0)

export type GithubActionKind = "issue" | "comment" | "pull_request";
/**
 * pending: waiting for Approve/Reject. running: being sent right now. done: sent (resultUrl). failed: GitHub refused
 * or something changed (error). rejected: the user said no. expired: not decided within 24 hours.
 */
export type GithubActionStatus = "pending" | "running" | "done" | "failed" | "rejected" | "expired";

/** What a chat step carries: enough to draw the card's heading; the card loads the rest. */
export interface GithubActionRefDto {
  id: string;
  kind: GithubActionKind;
  repo: string;
  title: string;
}

export interface GithubActionFileDto {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  /** Unified diff lines ("@@ …", " context", "-removed", "+added"), possibly shortened for display. */
  diff: string;
}

/** Exactly what will be sent to GitHub. Kept only while the card waits for a decision. */
export interface GithubActionPreviewDto {
  /** Issue / pull request title. */
  title?: string;
  /** Issue, comment or pull request text (Markdown, shown as plain text on the card). */
  body: string;
  /** Comment: the issue or pull request it goes on. */
  target?: { number: number; kind: "issue" | "pr"; title: string; url: string };
  /** Pull request: the branch it goes into and the new branch VESPER creates. */
  base?: string;
  branch?: string;
  files?: GithubActionFileDto[];
}

export interface GithubActionDto extends GithubActionRefDto {
  status: GithubActionStatus;
  /** The repository is public: whatever is sent can be read by anyone. */
  publicRepo: boolean;
  /** Plain-language cautions shown on the card (text written by others was read; private code read before a public change). */
  warnings: string[];
  preview: GithubActionPreviewDto | null;
  resultUrl: string | null;
  error: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

/**
 * A cited source, shown under the answer: a numbered link for web pages, or a document chip such as
 * "Handbook.pdf · page 12" for knowledge-base documents (their files aren't stored, so no link).
 */
export interface SourceDto {
  title: string;
  /** http(s) link. Absent for knowledge-base files. */
  url?: string;
  /** Where in a document, e.g. "page 12" (knowledge-base sources), or what was calculated from a spreadsheet. */
  location?: string;
  /**
   * "table": a calculation on a spreadsheet the user attached (v0.14.0); always listed under the answer.
   * "document": a passage of a document the user attached to the chat (v0.16.0); the chip shows `excerpt` when opened.
   */
  kind?: "table" | "document";
  /** Documents in chat (v0.16.0): the start of the passage that was used (at most 600 characters). */
  excerpt?: string;
}

// ------------------------------------------------------------------ Spreadsheets in chat (data analysis, v0.14.0)

export type TableFileKind = "csv" | "tsv" | "xlsx" | "xlsm" | "xls" | "ods";
export type TableColumnType = "number" | "date" | "text" | "boolean";
/** One stored cell: numbers, dates as "YYYY-MM-DD" (or "YYYY-MM-DDTHH:MM:SS"), text, true/false, or null when empty. */
export type TableCell = string | number | boolean | null;

/** One column of an attached spreadsheet, with an overview worked out over every row when the file was read. */
export interface TableColumnDto {
  name: string;
  type: TableColumnType;
  /** Empty cells, including values that didn't fit the column's type (see `invalid`). */
  blanks: number;
  /** How many different values (exact). */
  distinct: number;
  /** Number and date columns: the lowest and highest value. */
  min?: number | string;
  max?: number | string;
  /** Number columns: "%" (45% is stored as 45) or a currency such as "$", "€" or "PKR". */
  unit?: string;
  /** Date columns: some values have a time of day (then every value is stored as YYYY-MM-DDTHH:MM:SS). */
  hasTime?: boolean;
  /** Date columns read as day/month/year or month/day/year, when the file's dates were written with slashes. */
  dateOrder?: "dmy" | "mdy";
  /** Text and yes/no columns with few different values: every value with how often it appears (most common first). */
  top?: { value: string; count: number }[];
  /** Text columns with many different values: a few examples. */
  examples?: string[];
  /** Values that didn't fit the column's type and were left empty, e.g. "abc" in a number column. */
  invalid?: number;
}

/** One sheet (or a CSV file) as the browser read it: its overview, sent before its rows. */
export interface TableSheetInput {
  /** The sheet's name (Excel and OpenDocument); null for CSV. */
  sheet: string | null;
  rows: number;
  /** Spreadsheet row numbers of the first and last data row (the header row comes before them). */
  firstRow: number;
  lastRow: number;
  columns: TableColumnDto[];
  /** Plain-language notes about how the file was read (e.g. a "Total" row left out). */
  notes: string[];
  /** A few example rows (cells in column order). */
  samples: TableCell[][];
  /** How many blocks of rows will be uploaded. */
  chunks: number;
}

/** A spreadsheet the user added (one per file; each non-empty sheet is a table). */
export interface TableFileDto {
  id: string;
  name: string;
  kind: TableFileKind;
  status: "uploading" | "ready";
  tables: { id: string; sheet: string | null; rows: number; columns: number }[];
  createdAt: number;
}

/** One block of rows for upload: each row is [spreadsheet row number, cell 1, cell 2, …]. */
export interface TableChunkInput {
  seq: number;
  rows: TableCell[][];
}

/** A spreadsheet attached to a user message, shown as a chip on the message. */
export interface MessageFileDto {
  id: string;
  name: string;
  /** Tables read from it (sheets with data). */
  sheets: number;
  /** Data rows in all its tables. */
  rows: number;
}

// ------------------------------------------------------------------ Storage meter (admin, v0.16.0)

/** The free plan's limit for one D1 database (5 GB is the whole account's total, across up to 10 databases). */
export const D1_FREE_DATABASE_BYTES = 500 * 1024 * 1024;

/** Admin → App settings: how full the database is, and the text each file feature keeps against its own cap. */
export interface StorageDto {
  /** Size of the whole database in bytes, as D1 reports it (null when it couldn't be read). */
  bytes: number | null;
  /** The free plan's limit for one database. */
  maxBytes: number;
  /** Characters of stored text (the search indexes come on top, about the same again for documents). */
  knowledge: { chars: number; maxChars: number };
  spreadsheets: { chars: number; maxChars: number };
  documents: { chars: number; maxChars: number };
}

// ------------------------------------------------------------------ Documents in chat (v0.16.0)

export type ChatDocumentKind = "pdf" | "docx" | "txt" | "md";

/** A document the user added to a chat (only its text is stored, in passages). */
export interface ChatDocumentDto {
  id: string;
  name: string;
  kind: ChatDocumentKind;
  status: "uploading" | "ready";
  /** PDFs only. */
  pages: number | null;
  chunkCount: number;
  charCount: number;
  createdAt: number;
}

/** A document attached to a user message, shown as a chip on the message. */
export interface MessageDocumentDto {
  id: string;
  name: string;
  kind: ChatDocumentKind;
  /** PDFs only. */
  pages: number | null;
  /** Characters of text read from it. */
  chars: number;
}

/** How a date column is grouped in a calculation ("value": by its own values). */
export type TableBucket = "value" | "year" | "quarter" | "month" | "week" | "day" | "weekday" | "hour";
export type TableMetricOp = "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "median";

/** One column of a calculation's result (v0.14.1). */
export interface TableResultColumnDto {
  /** As the model sees it, e.g. "Region", "Date (month)", "sum of Amount (USD)", "row". */
  label: string;
  /** group: what the rows are grouped by; metric: a calculated figure; row: the spreadsheet row number; column: a listed column. */
  kind: "group" | "metric" | "row" | "column";
  /**
   * The values' type. Counts, sums, averages and medians are numbers; a lowest/highest value has its column's type;
   * a date grouped by a period is text in a fixed form (see `by`).
   */
  type: TableColumnType;
  /**
   * Groups: how they were made. year "2026", quarter "2026-Q1", month "2026-03", week "2026-03-02" (its Monday),
   * day "2026-03-05", weekday "1 Monday" … "7 Sunday", hour "00" … "23".
   */
  by?: TableBucket;
  op?: TableMetricOp;
  /** Number values: "%" or a currency such as "$" or "PKR" (from the spreadsheet column). */
  unit?: string;
}

/**
 * A calculation's whole result, kept with the answer and shown under it as a chart or table that the user can
 * download as CSV (v0.14.1). The model may have seen only the first part of a long result.
 */
export interface TableResultDto {
  /** The file (› sheet) it was calculated from. */
  table: string;
  /** What was calculated, e.g. "sum of Amount by Region · where Date in 2026". */
  title: string;
  mode: "aggregate" | "rows";
  columns: TableResultColumnDto[];
  /** In the result's order; an empty group is null. */
  rows: TableCell[][];
  /** Result rows in all (groups, or matching rows when listing): more than `rows` when only the first ones are kept. */
  total: number;
  /** Spreadsheet rows that matched the filters. */
  matched: number;
  /** How the figures were worked out, e.g. "Amount has empty cells; they are left out of the sum." */
  notes?: string[];
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
  /**
   * "read": only looks things up. "write": changes data in your own account. "approval": prepares a change elsewhere
   * (GitHub) that is sent only after you approve it on a card.
   */
  risk: "read" | "write" | "approval";
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
  /** Spreadsheets attached to a user message (v0.14.0). */
  files?: MessageFileDto[] | null;
  /** Documents (PDF, Word, text, Markdown) attached to a user message (v0.16.0). */
  documents?: MessageDocumentDto[] | null;
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
