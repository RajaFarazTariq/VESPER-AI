import type { ProviderId, ToolEventDto } from "../../shared/types";
import type { ProviderHealth, ProviderStateStore } from "../db/provider-state";
import { ToolInputError, type AgentTool, type ToolContext } from "../tools/registry";
import { executeRoute, type RouteError, type RouteTarget, type RouterEvents } from "./router";
import type { ChatMessage, Provider, ToolCall, ToolSpec } from "./types";

/** Model ↔ tool rounds per user message. Every round is one request against a free quota. */
export const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 8_000;
/**
 * Web look-ups that also search the knowledge base (same query, at the same time) when the documents haven't been
 * checked yet in this reply, so the model can compare both instead of ignoring the admin's documents.
 * read_page is left out: the user asked for one specific page.
 */
const PAIRED_WEB_TOOLS = new Set(["web_search", "wikipedia"]);
const PAIRED_KNOWLEDGE_RESULTS = 3;

/** The knowledge-base search to run alongside a web look-up, or null when it isn't needed. */
function pairedKnowledgeCall(call: ToolCall, tools: Map<string, AgentTool>): ToolCall | null {
  if (!PAIRED_WEB_TOOLS.has(call.name) || !tools.has("search_knowledge")) return null;
  let query: unknown;
  try {
    query = (parseArguments(call.arguments) as { query?: unknown }).query;
  } catch {
    return null; // the web tool reports the bad input itself
  }
  if (typeof query !== "string" || query.trim().length < 2) return null;
  return {
    id: `${call.id}-kb`,
    name: "search_knowledge",
    arguments: JSON.stringify({ query: query.trim().slice(0, 300), limit: PAIRED_KNOWLEDGE_RESULTS }),
  };
}

export interface AgentEvents extends RouterEvents {
  tool(event: ToolEventDto): void | Promise<void>;
}

export interface AgentResult {
  status: "complete" | "partial" | "error" | "aborted";
  target: RouteTarget | null;
  text: string;
  reasoning: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  tools: ToolEventDto[];
  error: RouteError | null;
}

export const toToolSpecs = (tools: AgentTool[]): ToolSpec[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ToolInputError("Arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Run one tool call. Never throws: failures become a result the model can read and recover from. */
async function runTool(
  call: ToolCall,
  tools: Map<string, AgentTool>,
  ctx: ToolContext,
): Promise<{ event: ToolEventDto; content: string }> {
  const tool = tools.get(call.name);
  const base = { id: call.id, name: call.name, label: tool?.label ?? call.name };
  let args: Record<string, unknown> = {};
  try {
    if (!tool) throw new ToolInputError(`Unknown tool "${call.name}". Available: ${[...tools.keys()].join(", ") || "none"}`);
    args = parseArguments(call.arguments);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      throw new ToolInputError(parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
    }
    const output = await tool.run(parsed.data, ctx);
    // Web sources need an http(s) link; knowledge-base documents have a title (and location) instead.
    const sources = (output.sources ?? [])
      .filter((s) => (s.url ? /^https?:\/\//i.test(s.url) : s.title.trim().length > 0))
      .slice(0, 10)
      .map((s) => ({
        title: s.title.slice(0, 200),
        ...(s.url ? { url: s.url.slice(0, 2000) } : {}),
        ...(s.location ? { location: s.location.slice(0, 120) } : {}),
      }));
    return {
      event: {
        ...base,
        args,
        status: "done",
        summary: output.summary.slice(0, 300),
        ...(sources.length ? { sources } : {}),
      },
      content: output.content.slice(0, MAX_TOOL_RESULT_CHARS),
    };
  } catch (error) {
    const known = error instanceof ToolInputError || error instanceof SyntaxError;
    const message = known ? (error as Error).message : "The tool failed unexpectedly.";
    if (!known) console.error(JSON.stringify({ msg: "tool crashed", tool: call.name, error: String(error) }));
    return {
      event: { ...base, args, status: "error", summary: message.slice(0, 300) },
      content: JSON.stringify({ error: message }),
    };
  }
}

/**
 * The agent loop: ask the model (with free-provider fallback), run any tools it requests,
 * feed the results back, and repeat until it answers in plain text or the round limit is hit.
 */
export async function runAgent(input: {
  plan: RouteTarget[];
  providers: Map<ProviderId, Provider>;
  messages: ChatMessage[];
  tools: AgentTool[];
  toolContext: ToolContext;
  maxTokens: number;
  signal: AbortSignal;
  store: ProviderStateStore;
  health: Map<ProviderId, ProviderHealth>;
  events: AgentEvents;
  maxRounds?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AgentResult> {
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS;
  const toolMap = new Map(input.tools.map((t) => [t.name, t]));
  const specs = toToolSpecs(input.tools);
  const messages = [...input.messages];
  let plan = input.plan;
  let knowledgeChecked = false; // has the knowledge base been searched in this reply?
  const result: AgentResult = {
    status: "error",
    target: null,
    text: "",
    reasoning: "",
    usage: { inputTokens: null, outputTokens: null },
    tools: [],
    error: null,
  };
  const addUsage = (u: { inputTokens: number | null; outputTokens: number | null }) => {
    if (u.inputTokens !== null) result.usage.inputTokens = (result.usage.inputTokens ?? 0) + u.inputTokens;
    if (u.outputTokens !== null) result.usage.outputTokens = (result.usage.outputTokens ?? 0) + u.outputTokens;
  };

  for (let round = 0; round <= maxRounds; round++) {
    // The final round offers no tools, forcing a written answer.
    const offerTools = round < maxRounds && specs.length > 0;
    let roundText = "";
    const separator = result.text.trim() ? "\n\n" : "";
    let separated = false;
    const route = await executeRoute({
      plan,
      providers: input.providers,
      messages,
      maxTokens: input.maxTokens,
      signal: input.signal,
      store: input.store,
      health: input.health,
      sleep: input.sleep,
      ...(offerTools ? { tools: specs } : {}),
      events: {
        attempt: input.events.attempt,
        fallback: input.events.fallback,
        reasoning: input.events.reasoning,
        text: async (text) => {
          if (separator && !separated) {
            separated = true;
            await input.events.text(separator);
          }
          roundText += text;
          await input.events.text(text);
        },
      },
    });
    if (separated) result.text += separator;
    result.text += roundText;
    result.reasoning += route.reasoning;
    result.target = route.target;
    addUsage(route.usage);

    if (route.status !== "complete") {
      result.status = route.status === "aborted" && result.text ? "partial" : route.status;
      result.error = route.error;
      return result;
    }
    // Stick with the provider that worked for the rest of this task.
    if (route.target) plan = [route.target, ...plan.filter((t) => t.provider !== route.target!.provider)];

    if (route.toolCalls.length === 0) {
      result.status = "complete";
      return result;
    }

    messages.push({ role: "assistant", content: roundText || null, tool_calls: route.toolCalls });
    if (route.toolCalls.some((c) => c.name === "search_knowledge")) knowledgeChecked = true;
    for (const call of route.toolCalls) {
      if (input.signal.aborted) break;
      const running = (c: ToolCall): ToolEventDto => ({
        id: c.id,
        name: c.name,
        label: toolMap.get(c.name)?.label ?? c.name,
        args: {},
        status: "running",
        summary: null,
      });
      const paired = knowledgeChecked ? null : pairedKnowledgeCall(call, toolMap);
      if (paired) knowledgeChecked = true;
      await input.events.tool(running(call));
      if (paired) await input.events.tool(running(paired));
      const [main, extra] = await Promise.all([
        runTool(call, toolMap, input.toolContext),
        paired ? runTool(paired, toolMap, input.toolContext) : null,
      ]);
      result.tools.push(main.event);
      await input.events.tool(main.event);
      let content = main.content;
      if (extra) {
        result.tools.push(extra.event);
        await input.events.tool(extra.event);
        // One tool result per call id (providers require it), so the documents ride along with the web results.
        content =
          `${main.content}\n\n` +
          "The knowledge base (the administrator's documents) was also searched automatically with the same query. " +
          "Use these passages only if they are relevant, and compare them with the web results:\n" +
          extra.content;
      }
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    }
    if (input.signal.aborted) {
      result.status = result.text ? "partial" : "aborted";
      result.error = { code: "aborted", message: "Generation stopped.", retryable: true };
      return result;
    }
  }
  // Unreachable in practice: the last round offers no tools, so it ends with text or an error.
  result.status = result.text ? "complete" : "error";
  if (!result.text) result.error = { code: "no_answer", message: "The model didn't produce an answer.", retryable: true };
  return result;
}
