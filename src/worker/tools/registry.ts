import { z } from "zod";
import type { ToolInfoDto, UserSettings } from "../../shared/types";
import { addMemory, deleteMemory, MemoryLimitError } from "../db/memories";
import { CalcError, evaluate } from "./calculator";

export interface ToolContext {
  db: D1Database;
  userId: string;
  settings: UserSettings;
  now: Date;
}

export interface ToolOutput {
  /** What the model sees. */
  content: string;
  /** One line for the UI. */
  summary: string;
}

/** A tool the model may call. Parameters are plain JSON Schema (portable across providers). */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  risk: "read" | "write";
  requiresMemory: boolean;
  parameters: Record<string, unknown>;
  schema: z.ZodType;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

/** A tool failure the model should see and can recover from (bad input, not found…). */
export class ToolInputError extends Error {}

function define<S extends z.ZodType>(tool: Omit<AgentTool, "schema" | "run"> & {
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}): AgentTool {
  return tool as unknown as AgentTool;
}

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
    properties: { timezone: { type: "string", description: "IANA timezone name. Defaults to UTC." } },
  },
  schema: z.object({ timezone: z.string().max(64).optional() }),
  async run({ timezone }, ctx) {
    const timeZone = timezone?.trim() || "UTC";
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

export const ALL_TOOLS: AgentTool[] = [calculator, datetime, remember, forget];

export const toolInfo = (): ToolInfoDto[] =>
  ALL_TOOLS.map((t) => ({ name: t.name, label: t.label, description: t.description, risk: t.risk, requiresMemory: t.requiresMemory }));

/** Tools available for this user's settings. */
export function enabledTools(settings: UserSettings): AgentTool[] {
  if (!settings.toolsEnabled) return [];
  const disabled = new Set(settings.disabledTools);
  return ALL_TOOLS.filter((t) => !disabled.has(t.name) && (!t.requiresMemory || settings.memoryEnabled));
}
