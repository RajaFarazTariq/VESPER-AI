import { z } from "zod";
import type { AppSettingsDto, ToolInfoDto, UserSettings } from "../../shared/types";
import { VERSION } from "../version";
import { addMemory, deleteMemory, MemoryLimitError } from "../db/memories";
import { CalcError, evaluate } from "./calculator";
import { define, ToolInputError, type AgentTool, type WebToolContext } from "./types";
import { WEB_TOOLS } from "./web";

// Shared types live in ./types; re-exported so existing imports keep working.
export { ToolInputError, type AgentTool, type ToolContext, type ToolOutput, type WebToolContext } from "./types";

const calculator = define({
  name: "calculator",
  label: "Calculator",
  description:
    "Evaluate a math expression exactly. Use it for any arithmetic beyond the trivial instead of calculating in your head. " +
    "Supports + - * / % ^ !, parentheses, pi, e, and functions like sqrt, ln, log, sin, cos, round(x, digits), min, max. " +
    "Trigonometry uses radians (use rad(x) to convert degrees).",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: 'The expression, e.g. "(1250 * 0.18) + 2^10"' } },
    required: ["expression"],
  },
  schema: z.object({ expression: z.string().min(1).max(500) }),
  async run({ expression }) {
    try {
      const result = evaluate(expression);
      return { content: JSON.stringify({ expression, result }), summary: `${expression} = ${result}` };
    } catch (error) {
      if (error instanceof CalcError) throw new ToolInputError(error.message);
      throw error;
    }
  },
});

const datetime = define({
  name: "current_datetime",
  label: "Date & time",
  description:
    "Get the current date and time, optionally in a specific IANA timezone (e.g. Asia/Karachi, Europe/London, America/New_York).",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { timezone: { type: "string", description: "IANA timezone name. Defaults to the user's own time zone." } },
  },
  schema: z.object({ timezone: z.string().max(64).optional() }),
  async run({ timezone }, ctx) {
    const timeZone = timezone?.trim() || ctx.timeZone || "UTC";
    let formatted: string;
    let offset = "";
    try {
      formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        dateStyle: "full",
        timeStyle: "short",
        hourCycle: "h23",
      }).format(ctx.now);
      offset =
        new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
          .formatToParts(ctx.now)
          .find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      throw new ToolInputError(`Unknown timezone "${timeZone}". Use an IANA name such as Asia/Karachi.`);
    }
    const summary = `${formatted} (${timeZone}${offset ? `, ${offset}` : ""})`;
    return { content: JSON.stringify({ timezone: timeZone, utcOffset: offset, local: formatted, iso: ctx.now.toISOString() }), summary };
  },
});

const remember = define({
  name: "remember",
  label: "Save to memory",
  description:
    "Save a lasting fact or preference about the user so you remember it in future conversations. " +
    "Only use when the user asks you to remember something, or clearly shares a stable personal preference. " +
    "Never store passwords, API keys, financial or other sensitive data. Write it as a short third-person sentence.",
  risk: "write",
  requiresMemory: true,
  parameters: {
    type: "object",
    properties: { fact: { type: "string", description: 'e.g. "Prefers Python examples over JavaScript."' } },
    required: ["fact"],
  },
  schema: z.object({ fact: z.string().trim().min(3).max(500) }),
  async run({ fact }, ctx) {
    if (/(api[_ -]?key|password|passwd|\bsecret\b|github_pat_|\bgsk_\w|\bAIza\w{10}|\bsk-[A-Za-z0-9]{8})/i.test(fact)) {
      throw new ToolInputError("Refusing to store something that looks like a credential.");
    }
    try {
      const memory = await addMemory(ctx.db, ctx.userId, fact, "assistant");
      return { content: JSON.stringify({ saved: true, id: memory.id }), summary: `Remembered: ${memory.content}` };
    } catch (error) {
      if (error instanceof MemoryLimitError) throw new ToolInputError(error.message);
      throw error;
    }
  },
});

const forget = define({
  name: "forget",
  label: "Delete a memory",
  description: "Delete one saved memory by its id (ids are listed with the saved memories in your instructions).",
  risk: "write",
  requiresMemory: true,
  parameters: {
    type: "object",
    properties: { memory_id: { type: "string", description: "The id of the memory to delete." } },
    required: ["memory_id"],
  },
  schema: z.object({ memory_id: z.string().trim().min(1).max(64) }),
  async run({ memory_id }, ctx) {
    const deleted = await deleteMemory(ctx.db, ctx.userId, memory_id);
    if (!deleted) throw new ToolInputError(`No memory with id "${memory_id}".`);
    return { content: JSON.stringify({ deleted: true }), summary: "Deleted a memory" };
  },
});

export const ALL_TOOLS: AgentTool[] = [calculator, datetime, remember, forget, ...WEB_TOOLS];

const isAvailable = (t: AgentTool, web: WebToolContext | undefined) => (t.isAvailable ? t.isAvailable(web) : true);

/** What the live-information tools need: request identity, the search key (if set) and today's cap. */
export function webToolContext(
  env: { TAVILY_API_KEY?: string },
  appName: string,
  origin: string,
  settings: Pick<AppSettingsDto, "webSearchDailyLimit">,
): WebToolContext {
  const key = env.TAVILY_API_KEY?.trim();
  return {
    userAgent: `${appName.replace(/[^\w.-]/g, "") || "Assistant"}/${VERSION} (+${origin})`,
    ...(key ? { tavilyApiKey: key } : {}),
    webSearchDailyLimit: settings.webSearchDailyLimit,
  };
}

/** Every tool, with whether it can run on this server (e.g. web search needs TAVILY_API_KEY). */
export const toolInfo = (web?: WebToolContext): ToolInfoDto[] =>
  ALL_TOOLS.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    risk: t.risk,
    requiresMemory: t.requiresMemory,
    available: isAvailable(t, web),
  }));

/** Tools offered this turn: the user's choices, minus any the admin switched off, minus unavailable ones. */
export function enabledTools(settings: UserSettings, disabledForEveryone: readonly string[] = [], web?: WebToolContext): AgentTool[] {
  if (!settings.toolsEnabled) return [];
  const disabled = new Set([...settings.disabledTools, ...disabledForEveryone]);
  return ALL_TOOLS.filter(
    (t) => !disabled.has(t.name) && (!t.requiresMemory || settings.memoryEnabled) && isAvailable(t, web),
  );
}
