/** Shared tool types, in their own module so tool files and the registry don't import each other. */
import type { z } from "zod";
import type { GithubActionRefDto, SourceDto, TableResultDto, UserSettings } from "../../shared/types";
import type { GithubWriter } from "./github-client";

/** What happened so far in this answer (filled in by the agent loop), for tools that need to know. */
export interface TurnState {
  /** Names of the tools that ran, in order. */
  used: string[];
  /** Private repository content was read in this answer. */
  privateRead: boolean;
  /** GitHub changes prepared in this answer (v0.13.0). */
  prepared: number;
}

export interface ToolContext {
  db: D1Database;
  userId: string;
  settings: UserSettings;
  now: Date;
  /** The user's IANA time zone from their browser (validated), used as the default for date/time. */
  timeZone?: string;
  /** Live-information tools (web search, weather…): keys, limits and request identity. */
  web?: WebToolContext;
  /** The chat's abort signal (Stop button / closed tab), so slow lookups stop too. */
  signal?: AbortSignal;
  /** Workers AI binding (the knowledge base uses its re-ranker); absent in local dev and tests. */
  ai?: Ai;
  /** The user's own GitHub access (read-only), when they connected GitHub and may use it (v0.12.0). */
  github?: GithubAccess;
  /** The user's Actions-app access, for preparing GitHub changes they approve (v0.13.0). */
  githubWriter?: GithubWriter;
  /** The chat the answer belongs to (a prepared change is filed under it). */
  conversationId?: string;
  /** Set by the agent loop: what this answer has done so far. */
  turn?: TurnState;
  /** Spreadsheet calculations (v0.14.0): the app-wide daily budget of rows the database may read for them. */
  tables?: { rowsPerDay: number };
}

/** What the GitHub tools need from the per-user GitHub client (tools/github-client.ts). */
export interface GithubAccess {
  /** A GitHub API GET (path like "/repos/o/r"), through the short cache, within the per-message call limit. */
  get(path: string, options?: { accept?: string; fresh?: number }): Promise<{ body: string; headers: Headers | null }>;
  /** Why a repo can't be read (not installed, needs the org owner's approval, not chosen…), in plain words. */
  explainNoAccess(repo: string): Promise<string>;
  /** github.com page where the user picks the repos VESPER may read. */
  installUrl: string;
  /** Same repo/commit look-ups within one message are made once. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/** What the server has right now, for tools that depend on it (a key, a daily quota, documents). */
export interface ToolServerState {
  web?: WebToolContext;
  /** At least one knowledge-base document is ready to search. */
  knowledgeReady?: boolean;
  /** This user has a working GitHub connection (v0.12.0). */
  github?: boolean;
  /** This user has a working connection for GitHub changes (v0.13.0). */
  githubActions?: boolean;
  /** Spreadsheets (v0.14.0): in a chat, it has one; in the tool lists, the admin has spreadsheets switched on. */
  tables?: boolean;
}

export interface WebToolContext {
  /** Sent with every outbound request, e.g. "VESPER/0.7.0 (+https://ai-assistant.vesper-ai.workers.dev)". */
  userAgent: string;
  tavilyApiKey?: string;
  /** Web searches allowed per UTC day for the whole app (0 = web search off). */
  webSearchDailyLimit: number;
  /** Admin's trusted websites (ranked first) and blocked websites (never used), e.g. "who.int". */
  trustedSites?: string[];
  blockedSites?: string[];
  /** The user's question: names in it (e.g. "GitHub") mark that organisation's own site as official. */
  question?: string;
}

export interface ToolOutput {
  /** What the model sees. */
  content: string;
  /** One line for the UI (admin view). */
  summary: string;
  /** Pages/services the result came from, shown as source links under the answer (to everyone). */
  sources?: SourceDto[];
  /** Full text behind a clipped result (e.g. whole knowledge-base passages), used only by the number check. */
  evidence?: string;
  /**
   * What is kept with the answer for "Check this answer" instead of the content (v0.12.0): GitHub tools keep only
   * references (repo, commit, file, lines), which the check reads again, so no repository text is stored.
   */
  keep?: string;
  /** The result holds private repository content: no more web pages may be opened in this answer (leak guard). */
  private?: boolean;
  /** A GitHub change was prepared and waits for the user's approval (shown as a card). */
  action?: GithubActionRefDto;
  /** A spreadsheet calculation's whole result, shown under the answer as a chart or table (v0.14.1). */
  table?: TableResultDto;
}

/** A tool the model may call. Parameters are plain JSON Schema (portable across providers). */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  /** read: looks up. write: changes the user's own VESPER data. approval: prepares a change the user approves first. */
  risk: "read" | "write" | "approval";
  requiresMemory: boolean;
  /** Needs something on the server (web search: TAVILY_API_KEY; knowledge base: documents); omitted = always available. */
  isAvailable?(server: ToolServerState): boolean;
  parameters: Record<string, unknown>;
  schema: z.ZodType;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

/** A tool failure the model should see and can recover from (bad input, not found, service down…). */
export class ToolInputError extends Error {}

export function define<S extends z.ZodType>(
  tool: Omit<AgentTool, "schema" | "run"> & {
    schema: S;
    run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
  },
): AgentTool {
  return tool as unknown as AgentTool;
}
