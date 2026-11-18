/** Shared tool types, in their own module so tool files and the registry don't import each other. */
import type { z } from "zod";
import type { SourceDto, UserSettings } from "../../shared/types";

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
}

/** What the server has right now, for tools that depend on it (a key, a daily quota, documents). */
export interface ToolServerState {
  web?: WebToolContext;
  /** At least one knowledge-base document is ready to search. */
  knowledgeReady?: boolean;
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
}

/** A tool the model may call. Parameters are plain JSON Schema (portable across providers). */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  risk: "read" | "write";
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
