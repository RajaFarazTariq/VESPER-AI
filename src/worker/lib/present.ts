/**
 * What each viewer is shown of an assistant reply.
 *
 * Admins see everything (thinking notes, tool inputs/results, provider and model) for troubleshooting.
 * Regular users get a clean, ChatGPT-like view: no thinking notes (unless the admin turns them on),
 * tools only by name (no technical inputs/results), and no provider/model names. Nothing is deleted:
 * the full reply stays in the database; this only filters what is sent to the browser.
 * Local (Ollama) replies come from the user's own computer, so they are shown as they are.
 */
import type { AppSettingsDto, ChatStreamEvent, MessageDto, ToolEventDto } from "../../shared/types";
import type { SessionUser } from "../db/users";

export interface Viewer {
  admin: boolean;
  showReasoning: boolean;
}

export const viewerOf = (user: Pick<SessionUser, "role">, settings: Pick<AppSettingsDto, "showReasoningToUsers">): Viewer => ({
  admin: user.role === "admin",
  showReasoning: user.role === "admin" || settings.showReasoningToUsers,
});

export function presentTool(tool: ToolEventDto, viewer: Viewer): ToolEventDto {
  return viewer.admin ? tool : { ...tool, args: {}, summary: null };
}

export function presentMessage(message: MessageDto, viewer: Viewer): MessageDto {
  if (viewer.admin || message.role === "user" || message.provider === "ollama") return message;
  return {
    ...message,
    reasoning: viewer.showReasoning ? message.reasoning : null,
    provider: null,
    model: null,
    tools: message.tools ? message.tools.map((t) => presentTool(t, viewer)) : null,
  };
}

/** Returns the event to send to this viewer, or null to skip it. */
export function presentEvent(event: ChatStreamEvent, viewer: Viewer): ChatStreamEvent | null {
  if (viewer.admin) return event;
  switch (event.type) {
    case "attempt":
    case "fallback":
      return null; // provider switching is an admin concern
    case "reasoning":
      return viewer.showReasoning ? event : null;
    case "tool":
      return { ...event, tool: presentTool(event.tool, viewer) };
    case "done":
      return { ...event, message: presentMessage(event.message, viewer) };
    case "error":
      return event.assistantMessage ? { ...event, assistantMessage: presentMessage(event.assistantMessage, viewer) } : event;
    default:
      return event;
  }
}
