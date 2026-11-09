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
import { D1ProviderStateStore } from "../db/provider-state";
import type { SessionUser } from "../db/users";
import { getConfig } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { getProviderModels } from "../llm/catalog";
import { buildContext, buildSystemPrompt } from "../llm/context";
import { getProviders } from "../llm/registry";
import { executeRoute, planRoute } from "../llm/router";
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

/**
 * Shared first half of a chat turn: find/create the conversation and store the user message
 * (or, for regenerate, drop the previous answer). Returns the prompt context.
 */
async function prepareTurn(
  c: Context<AppEnv>,
  user: SessionUser,
  input: { conversationId?: string; message?: string; regenerate?: boolean },
  selection: string,
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

  const history = await listMessages(db, conversation.id, HISTORY_LIMIT);
  const system = buildSystemPrompt(config.appName, user.settings.systemPrompt);
  return { conversation, isNew, userMessage, context: buildContext(system, history, config.maxContextChars) };
}

export const chatRoutes = new Hono<AppEnv>()
  .use(requireUser)

  /** Stream a reply from the free provider chain as Server-Sent Events. */
  .post("/", chatLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, chatSchema);
    const config = getConfig(c.env);
    const selection = body.model ?? user.settings.defaultModel;
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

    const turn = await prepareTurn(c, user, body, selection);
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
    const send = (event: ChatStreamEvent) => writeRaw(formatSse(event.type, event));

    const pump = async () => {
      const heartbeat = setInterval(() => void writeRaw(": keep-alive\n\n"), HEARTBEAT_MS);
      try {
        if (turn.isNew) await send({ type: "conversation", conversation: turn.conversation });
        await send({ type: "user_message", message: turn.userMessage });

        const result = await executeRoute({
          plan: planned.plan,
          providers,
          messages: turn.context,
          maxTokens: config.maxOutputTokens,
          signal: abort.signal,
          store,
          health,
          events: {
            attempt: (t) => send({ type: "attempt", provider: t.provider, model: t.model }),
            fallback: (from, reason) => send({ type: "fallback", from, reason }),
            text: (text) => send({ type: "delta", text }),
            reasoning: (text) => send({ type: "reasoning", text }),
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
    const turn = await prepareTurn(c, user, body, selection);
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
