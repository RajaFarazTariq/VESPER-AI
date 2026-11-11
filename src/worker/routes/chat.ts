import { Hono, type Context } from "hono";
import { z } from "zod";
import { formatSse } from "../../shared/sse";
import type { ChatStreamEvent, ConversationDto, LocalPrepareResponse, MessageDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import {
  createConversation,
  deleteTrailingAssistantMessages,
  deriveTitle,
  getConversation,
  insertMessage,
  listMessages,
  updateConversation,
} from "../db/conversations";
import { listMemories } from "../db/memories";
import { D1ProviderStateStore } from "../db/provider-state";
import { getAppSettings, userMayUseModel } from "../db/app-settings";
import { consumeDailyMessage, type SessionUser } from "../db/users";
import { getConfig } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { getProviderModels } from "../llm/catalog";
import { buildContext, buildSystemPrompt, normalizeTimeZone } from "../llm/context";
import { presentEvent, presentMessage, viewerOf } from "../lib/present";
import { getProviders } from "../llm/registry";
import { runAgent } from "../llm/agent";
import { planRoute } from "../llm/router";
import { enabledTools, webToolContext, type AgentTool } from "../tools/registry";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";

export const MAX_MESSAGE_CHARS = 32_000;
const HISTORY_LIMIT = 200;
const HEARTBEAT_MS = 15_000;

const chatSchema = z
  .object({
    conversationId: z.uuid().optional(),
    message: z.string().max(MAX_MESSAGE_CHARS, `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`).optional(),
    model: z.string().trim().min(1).max(250).optional(),
    regenerate: z.boolean().optional(),
    /** The browser's IANA time zone, e.g. "Asia/Karachi". Unknown values are ignored (UTC is used). */
    timeZone: z.string().max(64).optional(),
  })
  .refine((d) => (d.regenerate ? Boolean(d.conversationId) : Boolean(d.message?.trim())), {
    message: "A non-empty message is required (or conversationId with regenerate).",
  });

const localCompleteSchema = z.object({
  conversationId: z.uuid(),
  model: z.string().trim().min(1).max(250),
  content: z.string().max(200_000),
  reasoning: z.string().max(200_000).optional(),
  status: z.enum(["complete", "partial", "error"]),
  error: z.string().max(1_000).optional(),
});

const chatLimiter = rateLimit(
  "chat",
  (c) => getConfig(c.env).chatRateLimitPerMinute,
  60_000,
  (c) => c.get("user").id,
);

/** Admins are counted (for the usage view) but never limited; everyone else gets their personal limit or the default. */
async function enforceDailyLimit(db: D1Database, user: SessionUser, defaultLimit: number): Promise<void> {
  if (user.role === "admin") {
    await consumeDailyMessage(db, user.id, Number.MAX_SAFE_INTEGER);
    return;
  }
  const limit = user.dailyLimit ?? defaultLimit;
  if (await consumeDailyMessage(db, user.id, limit)) return;
  if (limit <= 0) {
    throw new AppError(429, "daily_limit", "Sending messages is paused for your account. Please contact the administrator.");
  }
  const now = new Date();
  const msLeft = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
  const hours = Math.floor(msLeft / 3_600_000);
  const minutes = Math.max(1, Math.ceil((msLeft % 3_600_000) / 60_000));
  const wait = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  throw new AppError(
    429,
    "daily_limit",
    `You've used all ${limit} messages for today. Your limit resets at 00:00 UTC (in about ${wait}).`,
  );
}

/**
 * Shared first half of a chat turn: find/create the conversation and store the user message
 * (or, for regenerate, drop the previous answer). Returns the prompt context.
 */
async function prepareTurn(
  c: Context<AppEnv>,
  user: SessionUser,
  input: { conversationId?: string; message?: string; regenerate?: boolean },
  selection: string,
  extras: { tools: AgentTool[]; adminInstructions: string; timeZone: string | undefined },
): Promise<{ conversation: ConversationDto; isNew: boolean; userMessage: MessageDto; context: ReturnType<typeof buildContext> }> {
  const db = c.env.DB;
  const config = getConfig(c.env);
  let conversation: ConversationDto | null = null;
  let isNew = false;
  if (input.conversationId) {
    conversation = await getConversation(db, user.id, input.conversationId);
    if (!conversation) throw notFound("Conversation");
  } else {
    conversation = await createConversation(db, user.id, deriveTitle(input.message ?? ""), selection);
    isNew = true;
  }

  let userMessage: MessageDto;
  if (input.regenerate) {
    await deleteTrailingAssistantMessages(db, conversation.id);
    const history = await listMessages(db, conversation.id, 1);
    const last = history[history.length - 1];
    if (!last || last.role !== "user") throw badRequest("There is no user message to regenerate a reply for.");
    userMessage = last;
  } else {
    userMessage = await insertMessage(db, conversation.id, { role: "user", content: input.message!.trim() });
  }
  if (conversation.model !== selection) {
    await updateConversation(db, user.id, conversation.id, { model: selection });
    conversation = { ...conversation, model: selection };
  }

  const [history, memories] = await Promise.all([
    listMessages(db, conversation.id, HISTORY_LIMIT),
    user.settings.memoryEnabled ? listMemories(db, user.id) : Promise.resolve(undefined),
  ]);
  const system = buildSystemPrompt({
    appName: config.appName,
    customInstructions: user.settings.systemPrompt,
    adminInstructions: extras.adminInstructions,
    ...(memories ? { memories } : {}),
    tools: extras.tools.map((t) => t.name),
    ...(extras.timeZone ? { timeZone: extras.timeZone } : {}),
  });
  return { conversation, isNew, userMessage, context: buildContext(system, history, config.maxContextChars) };
}

export const chatRoutes = new Hono<AppEnv>()
  .use(requireUser)

  /** Stream a reply from the free provider chain as Server-Sent Events. */
  .post("/", chatLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, chatSchema);
    const config = getConfig(c.env);
    const appSettings = await getAppSettings(c.env.DB, config);
    let selection = body.model ?? user.settings.defaultModel;
    // Regular users may only use Auto or the models the admin listed (admin panel → Models).
    if (user.role !== "admin" && !userMayUseModel(appSettings, selection)) {
      if (body.model) {
        throw new AppError(403, "model_not_allowed", "That model isn't available. Choose one from the model menu, or use Auto.");
      }
      selection = "auto"; // their saved default is no longer on the list
    }
    const providers = getProviders(c.env);
    const store = new D1ProviderStateStore(c.env.DB);
    const health = await store.getHealth();

    // Warm OpenRouter's model list so it can pick a default free model.
    const openrouter = providers.get("openrouter");
    if (openrouter?.isConfigured() && !c.env.OPENROUTER_MODEL) await getProviderModels(c.env.DB, openrouter);

    // Plan before writing anything, so configuration errors don't leave half-created chats.
    const planned = await planRoute({
      selection,
      providers,
      order: config.providerOrder,
      health,
      fallback: user.settings.fallback,
    });
    if (!planned.ok) {
      const status = planned.error.code === "no_providers" || planned.error.code === "provider_not_configured" ? 503 : 400;
      throw new AppError(status, planned.error.code, planned.error.message);
    }

    // Count the message against the daily limit only once the request is known to be valid,
    // and before anything is written, so a refused message leaves no half-created chat.
    await enforceDailyLimit(c.env.DB, user, appSettings.defaultDailyLimit);

    const web = webToolContext(c.env, config.appName, new URL(c.req.url).origin, appSettings);
    const tools = enabledTools(user.settings, appSettings.disabledTools, web);
    const timeZone = normalizeTimeZone(body.timeZone);
    const turn = await prepareTurn(c, user, body, selection, { tools, adminInstructions: appSettings.botInstructions, timeZone });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const abort = new AbortController();
    let clientGone = false;

    const writeRaw = async (text: string) => {
      if (clientGone) return;
      try {
        await writer.write(encoder.encode(text));
      } catch {
        clientGone = true; // browser closed the connection or pressed Stop
        abort.abort();
      }
    };
    // Users get the clean view (see lib/present.ts); the admin gets every detail.
    const viewer = viewerOf(user, appSettings);
    const send = async (event: ChatStreamEvent) => {
      const shown = presentEvent(event, viewer);
      if (shown) await writeRaw(formatSse(shown.type, shown));
    };

    const pump = async () => {
      const heartbeat = setInterval(() => void writeRaw(": keep-alive\n\n"), HEARTBEAT_MS);
      try {
        if (turn.isNew) await send({ type: "conversation", conversation: turn.conversation });
        await send({ type: "user_message", message: turn.userMessage });

        const result = await runAgent({
          plan: planned.plan,
          providers,
          messages: turn.context,
          tools,
          toolContext: {
            db: c.env.DB,
            userId: user.id,
            settings: user.settings,
            now: new Date(),
            web,
            signal: abort.signal,
            ...(timeZone ? { timeZone } : {}),
          },
          maxTokens: config.maxOutputTokens,
          signal: abort.signal,
          store,
          health,
          events: {
            attempt: (t) => send({ type: "attempt", provider: t.provider, model: t.model }),
            fallback: (from, reason) => send({ type: "fallback", from, reason }),
            text: (text) => send({ type: "delta", text }),
            reasoning: (text) => send({ type: "reasoning", text }),
            tool: (tool) => send({ type: "tool", tool }),
          },
        });

        if (result.status === "aborted") return; // stopped before any output: nothing to save
        const saved = await insertMessage(c.env.DB, turn.conversation.id, {
          role: "assistant",
          content: result.text,
          reasoning: result.reasoning || null,
          provider: result.target?.provider ?? null,
          model: result.target?.model ?? null,
          status: result.status === "complete" ? "complete" : result.status === "partial" ? "partial" : "error",
          error: result.error?.message ?? null,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          tools: result.tools,
          notBefore: turn.userMessage.createdAt,
        });
        if (result.status === "complete") {
          await send({ type: "done", message: saved });
        } else {
          await send({
            type: "error",
            code: result.error?.code ?? "error",
            message: result.error?.message ?? "Something went wrong.",
            retryable: result.error?.retryable ?? true,
            assistantMessage: saved,
          });
        }
      } catch (error) {
        console.error(JSON.stringify({ msg: "chat stream failed", requestId: c.get("requestId"), error: String(error) }));
        await send({ type: "error", code: "internal", message: "The server hit an unexpected error. Please try again.", retryable: true });
      } finally {
        clearInterval(heartbeat);
        await writer.close().catch(() => {});
      }
    };
    c.executionCtx.waitUntil(pump());

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  })

  /**
   * Local models (Ollama) run in the user's browser. The server stores the turn and
   * hands back the prompt; the browser streams from Ollama and then calls /local/complete.
   */
  .post("/local/prepare", chatLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, chatSchema);
    const selection = body.model ?? "";
    if (!selection.startsWith("ollama:") || !/^ollama:[\w.:\-/]{1,150}$/.test(selection)) {
      throw badRequest("Local chat requires an ollama:<model> selection.");
    }
    // Local models run on the user's own computer, so they don't count against the daily limit.
    const { botInstructions } = await getAppSettings(c.env.DB, getConfig(c.env));
    const turn = await prepareTurn(c, user, body, selection, {
      tools: [],
      adminInstructions: botInstructions,
      timeZone: normalizeTimeZone(body.timeZone),
    });
    const response: LocalPrepareResponse = {
      conversation: turn.conversation,
      userMessage: turn.userMessage,
      messages: turn.context,
    };
    return c.json(response);
  })

  .post("/local/complete", async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, localCompleteSchema);
    const conversation = await getConversation(c.env.DB, user.id, body.conversationId);
    if (!conversation) throw notFound("Conversation");
    const last = (await listMessages(c.env.DB, conversation.id, 1))[0];
    const message = await insertMessage(c.env.DB, conversation.id, {
      role: "assistant",
      content: body.content,
      reasoning: body.reasoning ?? null,
      provider: "ollama",
      model: body.model.replace(/^ollama:/, ""),
      status: body.status,
      error: body.error ?? null,
      notBefore: last?.createdAt,
    });
    return c.json({ message });
  });
