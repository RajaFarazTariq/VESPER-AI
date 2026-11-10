import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStreamEvent, ConversationDto, MessageDto } from "../../shared/types";
import { api, ApiError, streamChat } from "../api/client";
import { providerLabel } from "../lib/format";
import { explainOllamaError, streamOllamaChat } from "../lib/ollama";

export interface UiMessage extends MessageDto {
  streaming?: boolean;
  notices?: string[];
}

interface Options {
  ollamaUrl: string;
  onConversationCreated: (conversation: ConversationDto) => void;
  onConversationActivity: (id: string) => void;
  onError: (message: string) => void;
}

const placeholder = (id: string, provider: string | null = null, model: string | null = null): UiMessage => ({
  id,
  role: "assistant",
  content: "",
  reasoning: null,
  provider,
  model,
  status: "complete",
  error: null,
  tools: null,
  createdAt: Date.now(),
  streaming: true,
  notices: [],
});

/** Drop assistant replies after the last user message (what "regenerate" replaces). */
function withoutTrailingAssistant(messages: UiMessage[]): UiMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === "assistant") end--;
  return messages.slice(0, end);
}

export function useChat(options: Options) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Batch streamed text per animation frame to keep long replies smooth.
  const pending = useRef<{ id: string; text: string; reasoning: string } | null>(null);
  const frame = useRef<number | null>(null);

  const patch = useCallback((id: string, fn: (m: UiMessage) => UiMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const flush = useCallback(() => {
    frame.current = null;
    const p = pending.current;
    if (!p || (!p.text && !p.reasoning)) return;
    const { id, text, reasoning } = p;
    pending.current = { id, text: "", reasoning: "" };
    patch(id, (m) => ({ ...m, content: m.content + text, reasoning: reasoning ? (m.reasoning ?? "") + reasoning : m.reasoning }));
  }, [patch]);

  const queue = useCallback(
    (id: string, kind: "text" | "reasoning", value: string) => {
      if (!pending.current || pending.current.id !== id) pending.current = { id, text: "", reasoning: "" };
      if (kind === "text") pending.current.text += value;
      else pending.current.reasoning += value;
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const settle = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    flush();
  }, [flush]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
  }, []);

  const load = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setLoading(true);
    setConversationId(id);
    setMessages([]);
    try {
      const data = await api.getConversation(id);
      setMessages(data.messages);
      return data.conversation;
    } catch (error) {
      optionsRef.current.onError(error instanceof ApiError ? error.message : "Could not load this conversation.");
      setConversationId(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Cloud providers: stream through our API. Returns false if the message was rejected outright. */
  const runRemote = useCallback(
    async (body: { conversationId?: string; message?: string; model: string; regenerate?: boolean }): Promise<boolean> => {
      const tempUserId = `local-user-${Date.now()}`;
      const assistantId = `local-assistant-${Date.now()}`;
      setMessages((prev) => {
        const base = body.regenerate ? withoutTrailingAssistant(prev) : prev;
        const user: UiMessage[] = body.message
          ? [{ ...placeholder(tempUserId), role: "user", content: body.message, streaming: false }]
          : [];
        return [...base, ...user, placeholder(assistantId)];
      });
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      let activeConversation = body.conversationId ?? null;
      let started = false;

      const onEvent = (event: ChatStreamEvent) => {
        started = true;
        switch (event.type) {
          case "conversation":
            activeConversation = event.conversation.id;
            setConversationId(event.conversation.id);
            optionsRef.current.onConversationCreated(event.conversation);
            break;
          case "user_message":
            setMessages((prev) => prev.map((m) => (m.id === tempUserId ? event.message : m)));
            break;
          case "attempt":
            patch(assistantId, (m) => ({ ...m, provider: event.provider, model: event.model }));
            break;
          case "fallback":
            patch(assistantId, (m) => ({
              ...m,
              notices: [...(m.notices ?? []), `${providerLabel(event.from.provider)}: ${event.reason}. Switched to the next free provider.`],
            }));
            break;
          case "tool":
            settle();
            patch(assistantId, (m) => {
              const tools = [...(m.tools ?? [])];
              const index = tools.findIndex((t) => t.id === event.tool.id);
              if (index >= 0) tools[index] = event.tool;
              else tools.push(event.tool);
              return { ...m, tools };
            });
            break;
          case "delta":
            queue(assistantId, "text", event.text);
            break;
          case "reasoning":
            queue(assistantId, "reasoning", event.text);
            break;
          case "done":
            settle();
            patch(assistantId, (m) => ({ ...event.message, notices: m.notices }));
            break;
          case "error":
            settle();
            patch(assistantId, (m) => ({
              ...(event.assistantMessage ?? m),
              status: event.assistantMessage?.status ?? "error",
              error: event.message,
              notices: m.notices,
              streaming: false,
            }));
            break;
        }
      };

      try {
        await streamChat(body, onEvent, controller.signal);
        settle();
        if (controller.signal.aborted) {
          setMessages((prev) =>
            prev.flatMap((m) => {
              if (m.id !== assistantId) return [m];
              return m.content ? [{ ...m, streaming: false, status: "partial" as const }] : [];
            }),
          );
        }
        return true;
      } catch (error) {
        settle();
        const message = error instanceof ApiError ? error.message : "Something went wrong.";
        if (!started) {
          // Rejected before anything was stored: undo the optimistic messages.
          setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== tempUserId));
          optionsRef.current.onError(message);
          return false;
        }
        patch(assistantId, (m) => ({ ...m, streaming: false, status: m.content ? "partial" : "error", error: message }));
        return true;
      } finally {
        abortRef.current = null;
        setStreaming(false);
        if (activeConversation) optionsRef.current.onConversationActivity(activeConversation);
      }
    },
    [patch, queue, settle],
  );

  /** Local Ollama models: the browser talks to Ollama, the server stores the turn. */
  const runLocal = useCallback(
    async (body: { conversationId?: string; message?: string; model: string; regenerate?: boolean }): Promise<boolean> => {
      let prepared;
      try {
        prepared = await api.localPrepare(body);
      } catch (error) {
        optionsRef.current.onError(error instanceof ApiError ? error.message : "Could not start the local chat.");
        return false;
      }
      const modelName = body.model.replace(/^ollama:/, "");
      const assistantId = `local-assistant-${Date.now()}`;
      if (!body.conversationId) {
        setConversationId(prepared.conversation.id);
        optionsRef.current.onConversationCreated(prepared.conversation);
      }
      setMessages((prev) => {
        const base = body.regenerate ? withoutTrailingAssistant(prev) : [...prev, prepared.userMessage];
        return [...base, placeholder(assistantId, "ollama", modelName)];
      });

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      let content = "";
      let reasoning = "";
      let status: "complete" | "partial" | "error" = "complete";
      let errorMessage: string | undefined;
      try {
        await streamOllamaChat(
          optionsRef.current.ollamaUrl,
          modelName,
          prepared.messages,
          (t) => {
            content += t;
            queue(assistantId, "text", t);
          },
          (t) => {
            reasoning += t;
            queue(assistantId, "reasoning", t);
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) status = content ? "partial" : "error";
        else {
          status = content ? "partial" : "error";
          errorMessage = explainOllamaError(error);
        }
      }
      settle();
      try {
        const { message } = await api.localComplete({
          conversationId: prepared.conversation.id,
          model: body.model,
          content,
          ...(reasoning ? { reasoning } : {}),
          status,
          ...(errorMessage ? { error: errorMessage } : controller.signal.aborted && !content ? { error: "Stopped." } : {}),
        });
        patch(assistantId, () => message);
      } catch {
        patch(assistantId, (m) => ({ ...m, streaming: false, status, error: errorMessage ?? "Reply could not be saved." }));
      } finally {
        abortRef.current = null;
        setStreaming(false);
        optionsRef.current.onConversationActivity(prepared.conversation.id);
      }
      return true;
    },
    [patch, queue, settle],
  );

  const send = useCallback(
    (text: string, model: string) => {
      const body = { ...(conversationId ? { conversationId } : {}), message: text, model };
      return model.startsWith("ollama:") ? runLocal(body) : runRemote(body);
    },
    [conversationId, runLocal, runRemote],
  );

  const regenerate = useCallback(
    (model: string) => {
      if (!conversationId) return Promise.resolve(false);
      const body = { conversationId, regenerate: true, model };
      return model.startsWith("ollama:") ? runLocal(body) : runRemote(body);
    },
    [conversationId, runLocal, runRemote],
  );

  return { conversationId, messages, loading, streaming, send, regenerate, stop, load, reset };
}
