import { Hono, type Context } from "hono";
import { z } from "zod";
import { formatSse } from "../../shared/sse";
import type {
  ChatImageInput,
  ChatStreamEvent,
  ConversationDto,
  LocalPrepareResponse,
  MessageDto,
  MessageFileDto,
  ProviderId,
  ToolEventDto,
  VerificationDto,
} from "../../shared/types";
import type { AppEnv } from "../app-env";
import {
  createConversation,
  deleteTrailingAssistantMessages,
  deriveTitle,
  getConversation,
  getConversationSummary,
  insertMessage,
  lastUserMessageImages,
  listMessages,
  saveConversationSummary,
  updateConversation,
  updateLastUserMessage,
} from "../db/conversations";
import { searchableCollections } from "../db/knowledge";
import { conversationFileCount, conversationHasTables, conversationTables, linkTableFiles, unsentReadyFiles } from "../db/tables";
import { TABLE_LIMITS } from "../../shared/tables";
import { listMemories, selectMemories } from "../db/memories";
import { D1ProviderStateStore, utcDay } from "../db/provider-state";
import { getAppSettings, holdResearchSearches, releaseResearchSearches, userMayUseModel, type SearchHold } from "../db/app-settings";
import {
  consumeDailyImages,
  consumeDailyMessage,
  consumeDailyResearch,
  refundDailyMessage,
  refundDailyResearch,
  type SessionUser,
} from "../db/users";
import { getConfig } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { CHAT_BODY_LIMIT, chatImageSchema, MAX_IMAGES_PER_MESSAGE } from "../lib/images";
import { parseJson } from "../lib/validation";
import { getProviderModels } from "../llm/catalog";
import { buildContext, buildSystemPrompt, messageChars, normalizeTimeZone, oldestFitting, usableMessage } from "../llm/context";
import { KEEP_SHARE, MAX_SUMMARY_CHARS, summarizeEarlier, summaryEvent } from "../llm/summary";
import { presentEvent, presentMessage, viewerOf } from "../lib/present";
import { getProviders } from "../llm/registry";
import { runAgent, type AgentResult } from "../llm/agent";
import { planPrefetch } from "../llm/prefetch";
import { MAX_RESEARCH_SEARCHES, MIN_RESEARCH_SEARCHES, runResearch, type ResearchResult } from "../llm/research";
import { planRoute } from "../llm/router";
import { factCheckEvent, sourcesOfTools, verifyAnswer } from "../llm/verify";
import { enabledTools, webToolContext, type AgentTool } from "../tools/registry";
import { githubAccess, githubConnected, githubWriter } from "../tools/github-client";
import { conversationGithubActions, expireGithubActions } from "../db/github";
import { conversationGoogleActions, expireGoogleActions } from "../db/google";
import { googleAccess, googleConnection } from "../tools/google-client";
import { githubActionsAllowed, githubAllowed, googleAllowed } from "./connections";
import { tablesAllowed } from "./files";
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
    /** Replace the last user message with `message` and answer it again. */
    edit: z.boolean().optional(),
    /** The browser's IANA time zone, e.g. "Asia/Karachi". Unknown values are ignored (UTC is used). */
    timeZone: z.string().max(64).optional(),
    /** Up to 3 images, resized in the browser (only with a new message). */
    images: z.array(chatImageSchema).max(MAX_IMAGES_PER_MESSAGE, `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`).optional(),
    /** Deep research: plan → several searches → read pages → a written brief. */
    research: z.boolean().optional(),
    /** A spreadsheet added beforehand through /api/files (only with a new message, v0.14.0). */
    files: z.array(z.uuid()).max(TABLE_LIMITS.perMessage, "Attach one spreadsheet per message.").optional(),
  })
  .refine((d) => !(d.research && d.images?.length), { message: "Deep research works with text questions only. Remove the images." })
  .refine((d) => !(d.research && d.files?.length), { message: "Deep research works with text questions only. Remove the spreadsheet." })
  .refine((d) => !d.files?.length || (!d.regenerate && !d.edit), { message: "Spreadsheets can only be attached to a new message." })
  .refine((d) => (d.regenerate ? Boolean(d.conversationId) : Boolean(d.message?.trim()) || Boolean(d.images?.length) || Boolean(d.files?.length)), {
    message: "A non-empty message is required (or conversationId with regenerate).",
  })
  .refine((d) => !d.edit || (Boolean(d.conversationId) && !d.regenerate && Boolean(d.message?.trim())), {
    message: "Editing needs a conversationId and the new text (and can't be combined with regenerate).",
  })
  .refine((d) => !d.images?.length || (!d.regenerate && !d.edit), {
    message: "Images can only be attached to a new message.",
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
 * What the user typed in this chat (their messages in the prompt). A prepared email or invitation points out the
 * addresses VESPER chose that aren't in it (v0.15.0).
 */
function userTextOf(messages: { role: string; content: string }[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n")
    .slice(-50_000);
}

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

/** Same idea for attached images (admins counted, never limited). Returns false when they don't fit today. */
async function consumeImages(db: D1Database, user: SessionUser, count: number, perDay: number): Promise<boolean> {
  return consumeDailyImages(db, user.id, count, user.role === "admin" ? Number.MAX_SAFE_INTEGER : perDay);
}

/**
 * Shared first half of a chat turn: find/create the conversation and store the user message
 * (or, for regenerate, drop the previous answer). Returns the prompt context.
 */
async function prepareTurn(
  c: Context<AppEnv>,
  user: SessionUser,
  input: { conversationId?: string; message?: string; regenerate?: boolean; edit?: boolean; images?: ChatImageInput[]; files?: MessageFileDto[] },
  selection: string,
  extras: {
    tools: AgentTool[];
    adminInstructions: string;
    timeZone: string | undefined;
    knowledge?: { name: string; description: string }[];
    /** Images the model gets with the question (new images, or the stored previews for Regenerate/Edit). */
    sendImages?: string[];
    /** Deep research: the system prompt gets the research rules instead of tool lines. */
    research?: boolean;
    /** May ask a model to summarise the older part of a long chat (cloud turns; not local models). */
    summarize?: boolean;
    /** GitHub changes are offered: the prompt lists what happened to the ones prepared in this chat (v0.13.0). */
    githubChanges?: boolean;
    /** Google is connected: the prompt names the account and lists the emails and events prepared in this chat (v0.15.0). */
    google?: { email: string } | null;
  },
): Promise<{
  conversation: ConversationDto;
  isNew: boolean;
  userMessage: MessageDto;
  context: ReturnType<typeof buildContext>;
  /** The chat outgrew the prompt: these older messages should be summarised (then `withSummary` builds the prompt). */
  pendingSummary: { previous: string | null; older: MessageDto[]; withSummary: (summary: string) => ReturnType<typeof buildContext> } | null;
}> {
  const db = c.env.DB;
  const config = getConfig(c.env);
  const text = input.message?.trim() ?? "";
  let conversation: ConversationDto | null = null;
  let isNew = false;
  if (input.conversationId) {
    conversation = await getConversation(db, user.id, input.conversationId);
    if (!conversation) throw notFound("Conversation");
  } else {
    const attachedName = input.files?.[0]?.name ?? (input.images?.length ? "Image" : "");
    conversation = await createConversation(db, user.id, deriveTitle(text || attachedName), selection);
    isNew = true;
  }

  let userMessage: MessageDto;
  if (input.regenerate) {
    await deleteTrailingAssistantMessages(db, conversation.id);
    const history = await listMessages(db, conversation.id, 1);
    const last = history[history.length - 1];
    if (!last || last.role !== "user") throw badRequest("There is no user message to regenerate a reply for.");
    userMessage = last;
    await expireGithubActions(db, user.id, { conversationId: conversation.id, since: last.createdAt });
    await expireGoogleActions(db, user.id, { conversationId: conversation.id, since: last.createdAt });
  } else if (input.edit) {
    // Edit: the last user message gets the new text and the old reply is replaced.
    await deleteTrailingAssistantMessages(db, conversation.id);
    const edited = await updateLastUserMessage(db, conversation.id, text);
    if (!edited) throw badRequest("There is no message to edit in this conversation.");
    userMessage = edited;
    await expireGithubActions(db, user.id, { conversationId: conversation.id, since: edited.createdAt });
    await expireGoogleActions(db, user.id, { conversationId: conversation.id, since: edited.createdAt });
  } else {
    // Only the small previews are kept; the full images go to the model once.
    userMessage = await insertMessage(db, conversation.id, {
      role: "user",
      content: text,
      images: input.images?.map((i) => i.thumb) ?? null,
      files: input.files?.length ? input.files : null,
    });
    // The spreadsheets now belong to this chat (deleted with it).
    if (input.files?.length) await linkTableFiles(db, user.id, input.files.map((f) => f.id), conversation.id);
  }
  if (conversation.model !== selection) {
    await updateConversation(db, user.id, conversation.id, { model: selection });
    conversation = { ...conversation, model: selection };
  }

  const [history, memories, earlier, githubChanges, tables, googleActions] = await Promise.all([
    listMessages(db, conversation.id, HISTORY_LIMIT),
    user.settings.memoryEnabled ? listMemories(db, user.id) : Promise.resolve(undefined),
    getConversationSummary(db, conversation.id),
    extras.githubChanges && !isNew ? conversationGithubActions(db, user.id, conversation.id) : Promise.resolve([]),
    // Spreadsheets in this chat (v0.14.0): their overviews go into the prompt.
    extras.research ? Promise.resolve([]) : conversationTables(db, user.id, conversation.id),
    extras.google && !isNew ? conversationGoogleActions(db, user.id, conversation.id) : Promise.resolve([]),
  ]);
  // Memories: pinned ones plus those related to this message and the last few things the user said (v0.10.0).
  const about = history
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content)
    .join("\n");
  const picked = memories ? selectMemories(memories, about || userMessage.content) : null;
  const systemWith = (summary: string | undefined) =>
    buildSystemPrompt({
      appName: config.appName,
      customInstructions: user.settings.systemPrompt,
      adminInstructions: extras.adminInstructions,
      ...(picked ? { memories: picked.selected, memoryTotal: picked.total } : {}),
      tools: extras.tools.map((t) => t.name),
      ...(extras.timeZone ? { timeZone: extras.timeZone } : {}),
      ...(extras.knowledge ? { knowledge: extras.knowledge } : {}),
      ...(extras.sendImages?.length ? { images: true } : {}),
      ...(extras.research ? { research: true } : {}),
      ...(summary ? { summary } : {}),
      ...(githubChanges.length ? { githubChanges } : {}),
      ...(tables.length ? { tables } : {}),
      ...(extras.google ? { google: { account: extras.google.email, actions: googleActions } } : {}),
    });

  // Long chats: messages already covered by the running notes aren't sent again in full.
  const recent = (earlier ? history.filter((m) => m.createdAt > earlier.until) : history).filter(usableMessage);
  const system = systemWith(earlier?.summary);
  const room = config.maxContextChars - system.length - (earlier ? 0 : MAX_SUMMARY_CHARS);
  const size = recent.reduce((n, m) => n + messageChars(m), 0);
  let pendingSummary = null;
  if (extras.summarize && size > room && recent.length > 2) {
    // Summarise everything but the newest ~60% of the room, so the next summary is only needed several turns later.
    const cut = Math.min(oldestFitting(recent, Math.floor(room * KEEP_SHARE)), recent.length - 1);
    if (cut >= 2) {
      const keep = recent.slice(cut);
      pendingSummary = {
        previous: earlier?.summary ?? null,
        older: recent.slice(0, cut),
        withSummary: (summary: string) => buildContext(systemWith(summary), keep, config.maxContextChars, extras.sendImages),
      };
    }
  }
  // Until (or unless) a new summary is made: the old way, with any earlier notes.
  return { conversation, isNew, userMessage, context: buildContext(system, recent, config.maxContextChars, extras.sendImages), pendingSummary };
}

export const chatRoutes = new Hono<AppEnv>()
  .use(requireUser)

  /** Stream a reply from the free provider chain as Server-Sent Events. */
  .post("/", chatLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, chatSchema, CHAT_BODY_LIMIT);
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
    // Images the model sees with this question: new ones, or (Regenerate/Edit) the previews kept with the message.
    const newImages = body.images ?? [];
    if (newImages.length > 0 && !appSettings.imagesEnabled) {
      throw new AppError(403, "images_off", "Image attachments are switched off. Send the question as text.");
    }
    let sendImages = newImages.map((i) => i.data);
    const research = Boolean(body.research);
    if (newImages.length === 0 && !research && (body.regenerate || body.edit) && body.conversationId && appSettings.imagesEnabled) {
      if (!(await getConversation(c.env.DB, user.id, body.conversationId))) throw notFound("Conversation");
      sendImages = await lastUserMessageImages(c.env.DB, body.conversationId);
    }

    // Spreadsheets (v0.14.0): a new one must be the user's own, finished and not sent yet; a chat holds up to 5.
    const newFileIds = body.files ?? [];
    let newFiles: MessageFileDto[] = [];
    if (newFileIds.length > 0) {
      if (!tablesAllowed(appSettings)) throw new AppError(403, "tables_off", "Spreadsheets are switched off. Send the question as text.");
      newFiles = await unsentReadyFiles(c.env.DB, user.id, newFileIds);
      if (newFiles.length !== newFileIds.length) {
        throw new AppError(409, "file_not_ready", "That spreadsheet isn't ready to send (or was already sent). Remove it and attach it again.");
      }
      if (body.conversationId && (await conversationFileCount(c.env.DB, user.id, body.conversationId)) + newFiles.length > TABLE_LIMITS.perChat) {
        throw new AppError(409, "chat_files_full", `A chat can have up to ${TABLE_LIMITS.perChat} spreadsheets. Start a new chat to add more.`);
      }
    }

    const web = webToolContext(c.env, config.appName, new URL(c.req.url).origin, appSettings);
    if (research) {
      if (!appSettings.researchEnabled) throw new AppError(403, "research_off", "Deep research is switched off.");
      if (!web.tavilyApiKey || appSettings.disabledTools.includes("web_search") || appSettings.webSearchDailyLimit <= appSettings.researchSearchReserve) {
        throw new AppError(503, "research_unavailable", "Deep research needs web search, which isn't available right now. Ask normally instead.");
      }
    }

    const providers = getProviders(c.env);
    const store = new D1ProviderStateStore(c.env.DB);
    const health = await store.getHealth();

    // Warm OpenRouter's model list so it can pick a default free model (and, for image questions, one that sees images).
    const openrouter = providers.get("openrouter");
    if (openrouter?.isConfigured() && (!c.env.OPENROUTER_MODEL || sendImages.length > 0)) await getProviderModels(c.env.DB, openrouter);

    // Plan before writing anything, so configuration errors don't leave half-created chats.
    const planned = await planRoute({
      selection,
      providers,
      order: config.providerOrder,
      health,
      fallback: user.settings.fallback,
      images: sendImages.length > 0,
    });
    if (!planned.ok) {
      const status = ["no_providers", "provider_not_configured", "no_image_model"].includes(planned.error.code) ? 503 : 400;
      throw new AppError(status, planned.error.code, planned.error.message);
    }

    // Count the message against the daily limit only once the request is known to be valid,
    // and before anything is written, so a refused message leaves no half-created chat.
    await enforceDailyLimit(c.env.DB, user, appSettings.defaultDailyLimit);
    if (!(await consumeImages(c.env.DB, user, newImages.length, appSettings.imagesPerDay))) {
      await refundDailyMessage(c.env.DB, user.id);
      const perDay = appSettings.imagesPerDay;
      throw new AppError(
        429,
        "image_limit",
        perDay <= 0
          ? "Image attachments are paused for your account. Send the question as text."
          : `That would go over your ${perDay} images for today. The limit resets at 00:00 UTC; you can still send text.`,
      );
    }

    // Deep research: count the run (given back if it fails or is stopped), then set its searches aside so two runs
    // at the same time can't both go over. Not enough left: say so before starting, and count nothing.
    let hold: SearchHold | null = null;
    const researchDay = utcDay();
    if (research) {
      const runsPerDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : appSettings.researchRunsPerDay;
      if (!(await consumeDailyResearch(c.env.DB, user.id, runsPerDay))) {
        await refundDailyMessage(c.env.DB, user.id);
        throw new AppError(
          429,
          "research_limit",
          runsPerDay <= 0
            ? "Deep research is paused for your account. You can still ask normally."
            : `You've used all ${runsPerDay} deep-research runs for today. They reset at 00:00 UTC; you can still ask normally.`,
        );
      }
      const held = await holdResearchSearches(c.env.DB, {
        cap: appSettings.webSearchDailyLimit,
        keep: appSettings.researchSearchReserve,
        want: MAX_RESEARCH_SEARCHES,
        min: MIN_RESEARCH_SEARCHES,
      });
      if (held.granted < MIN_RESEARCH_SEARCHES) {
        await refundDailyResearch(c.env.DB, user.id, researchDay);
        await refundDailyMessage(c.env.DB, user.id);
        const left = held.available === 0 ? "none are" : `only ${held.available} is`;
        throw new AppError(
          429,
          "research_no_searches",
          `Deep research needs at least ${MIN_RESEARCH_SEARCHES} web searches, and ${left} left for research today ` +
            `(the last ${appSettings.researchSearchReserve} of the day's ${appSettings.webSearchDailyLimit} are kept for normal questions). ` +
            "Try again tomorrow, or ask normally.",
        );
      }
      hold = held;
    }
    const settleResearch = async (result: ResearchResult | null) => {
      if (!hold) return;
      await releaseResearchSearches(c.env.DB, hold, hold.granted - (result?.searchesUsed ?? 0)).catch(() => {});
      // Only a finished report counts as a run.
      if (result?.status !== "complete") await refundDailyResearch(c.env.DB, user.id, researchDay).catch(() => {});
    };

    const knowledge = await searchableCollections(c.env.DB);
    // The user's own GitHub (read-only, v0.12.0): offered when the app is set up, allowed and connected.
    const githubOn = !research && githubAllowed(c.env, user, appSettings) && (await githubConnected(c.env.DB, user.id));
    // GitHub changes with approval (v0.13.0): offered when the Actions app is set up, allowed and connected.
    const githubActionsOn =
      !research && githubActionsAllowed(c.env, user, appSettings) && (await githubConnected(c.env.DB, user.id, "actions"));
    // Google Calendar and Gmail with approval (v0.15.0): offered when set up, allowed and connected, per what the user allowed.
    const google = !research && googleAllowed(c.env, user, appSettings) ? await googleConnection(c.env.DB, user.id) : null;
    // Spreadsheets (v0.14.0): the Table analysis tool is offered in chats that have one (while the admin allows it).
    const hasTables =
      newFiles.length > 0 || (body.conversationId !== undefined && (await conversationHasTables(c.env.DB, user.id, body.conversationId)));
    const tools = enabledTools(user.settings, appSettings.disabledTools, {
      web,
      knowledgeReady: knowledge.length > 0,
      github: githubOn,
      githubActions: githubActionsOn,
      tables: hasTables && !research && tablesAllowed(appSettings),
      googleCalendar: google?.calendar === true,
      gmailSend: google?.gmailSend === true,
    });
    const timeZone = normalizeTimeZone(body.timeZone);
    let turn: Awaited<ReturnType<typeof prepareTurn>>;
    try {
      turn = await prepareTurn(c, user, { ...body, files: newFiles }, selection, {
        // Research writes from collected material: no tools in its prompt (it uses the knowledge base itself).
        tools: research ? [] : tools,
        adminInstructions: appSettings.botInstructions,
        timeZone,
        ...(!research && tools.some((t) => t.name === "search_knowledge") ? { knowledge } : {}),
        sendImages,
        research,
        summarize: true,
        githubChanges: githubActionsOn,
        google: google ? { email: google.email } : null,
      });
    } catch (error) {
      await settleResearch(null);
      throw error;
    }
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
      let researchResult: ResearchResult | null = null;
      try {
        if (turn.isNew) await send({ type: "conversation", conversation: turn.conversation });
        await send({ type: "user_message", message: turn.userMessage });

        const toolContext = {
          db: c.env.DB,
          userId: user.id,
          settings: user.settings,
          now: new Date(),
          // The question lets web search recognise the organisation it's about (its own site counts as official).
          web: { ...web, question: turn.userMessage.content.slice(0, 2_000) },
          signal: abort.signal,
          ...(timeZone ? { timeZone } : {}),
          ...(c.env.AI ? { ai: c.env.AI } : {}),
          ...(githubOn ? { github: githubAccess({ env: c.env, db: c.env.DB, userId: user.id, userAgent: web.userAgent, signal: abort.signal }) } : {}),
          ...(githubActionsOn
            ? { githubWriter: githubWriter({ env: c.env, db: c.env.DB, userId: user.id, userAgent: web.userAgent, signal: abort.signal }) }
            : {}),
          conversationId: turn.conversation.id,
          tables: { rowsPerDay: appSettings.tablesRowsPerDay },
          ...(google ? { google: googleAccess({ env: c.env, db: c.env.DB, userId: user.id, signal: abort.signal }), userText: userTextOf(turn.context) } : {}),
        };
        const events = {
          attempt: (t: { provider: ProviderId; model: string }) => send({ type: "attempt", provider: t.provider, model: t.model }),
          fallback: (from: { provider: ProviderId; model: string }, reason: string) => send({ type: "fallback", from, reason }),
          text: (text: string) => send({ type: "delta", text }),
          reasoning: (text: string) => send({ type: "reasoning", text }),
          tool: (tool: ToolEventDto) => send({ type: "tool", tool }),
        };

        // Long chat: summarise the older part once (1 model request), keep the notes, then answer with them.
        let context = turn.context;
        const extraTools: ToolEventDto[] = [];
        if (turn.pendingSummary && !abort.signal.aborted) {
          const pending = turn.pendingSummary;
          await events.tool(summaryEvent("running", pending.older.length));
          const notes = await summarizeEarlier({
            appName: config.appName,
            previous: pending.previous,
            messages: pending.older,
            plan: planned.plan,
            providers,
            signal: abort.signal,
            store,
            health,
            events,
          });
          if (notes) {
            await saveConversationSummary(c.env.DB, turn.conversation.id, notes, pending.older.at(-1)!.createdAt);
            context = pending.withSummary(notes);
          }
          const done = summaryEvent(notes ? "done" : "error", pending.older.length);
          extraTools.push(done);
          await events.tool(done);
        }

        let result: AgentResult;
        if (hold) {
          researchResult = await runResearch({
            plan: planned.plan,
            providers,
            messages: context,
            question: turn.userMessage.content,
            tools,
            toolContext,
            maxTokens: config.maxOutputTokens,
            signal: abort.signal,
            store,
            health,
            events,
            searches: hold.granted,
          });
          result = researchResult;
        } else {
          result = await runAgent({
            plan: planned.plan,
            providers,
            messages: context,
            tools,
            toolContext,
            maxTokens: config.maxOutputTokens,
            signal: abort.signal,
            store,
            health,
            // Questions that clearly need a look-up are searched first, so the model answers in one request. Not in chats
            // with a spreadsheet: "sales in 2026" is about the file, not the web (the model can still search itself).
            prefetch: hasTables ? null : planPrefetch(turn.userMessage.content, new Set(tools.map((t) => t.name))),
            events,
          });
        }

        if (result.status === "aborted") {
          // Stopped before any output: nothing is saved, so changes prepared on the way have no card to approve them.
          const prepared = result.tools.flatMap((t) => (t.action ? [t.action.id] : []));
          if (prepared.length) await expireGithubActions(c.env.DB, user.id, { ids: prepared }).catch(() => {});
          const googlePrepared = result.tools.flatMap((t) => (t.google ? [t.google.id] : []));
          if (googlePrepared.length) await expireGoogleActions(c.env.DB, user.id, { ids: googlePrepared }).catch(() => {});
          return;
        }

        // Deep research: the finished report is checked against its sources (1 more model request; admin switch).
        let verification: VerificationDto | null = null;
        const laterTools: ToolEventDto[] = [];
        if (researchResult && result.status === "complete" && result.evidence && appSettings.researchAutoCheck && !abort.signal.aborted) {
          await events.tool(factCheckEvent("running", null));
          verification = await verifyAnswer({
            appName: config.appName,
            question: turn.userMessage.content,
            answer: result.text,
            evidence: result.evidence,
            sources: sourcesOfTools(result.tools),
            trigger: "auto",
            plan: planned.plan,
            providers,
            signal: abort.signal,
            store,
            health,
            events,
          }).catch(() => null);
          const step = factCheckEvent(verification ? "done" : "error", verification);
          laterTools.push(step);
          await events.tool(step);
        }

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
          tools: [...extraTools, ...result.tools, ...laterTools],
          // What the sources said, so the answer can be checked later ("Check this answer").
          evidence: result.evidence ?? null,
          verification,
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
        // Unused searches go back; a failed or stopped research run isn't counted.
        await settleResearch(researchResult);
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
    if (body.images?.length) throw badRequest("Images work with the cloud models only. Choose Auto or another cloud model.");
    if (body.files?.length) throw badRequest("Spreadsheets work with the cloud models only. Choose Auto or another cloud model.");
    if (body.research) throw badRequest("Deep research needs a cloud model. Choose Auto or another cloud model.");
    // Local models run on the user's own computer, so they don't count against the daily limit.
    const { botInstructions, localModelsForUsers } = await getAppSettings(c.env.DB, getConfig(c.env));
    if (user.role !== "admin" && !localModelsForUsers) {
      throw new AppError(403, "local_models_off", "Local models aren't available. Choose Auto or another model.");
    }
    const turn = await prepareTurn(c, user, { ...body, files: undefined }, selection, {
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
