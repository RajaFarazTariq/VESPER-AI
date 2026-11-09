import type { MessageDto } from "../../shared/types";
import type { ChatMessage } from "./types";

export function buildSystemPrompt(appName: string, customInstructions: string, now = new Date()): string {
  const lines = [
    `You are ${appName}, a helpful, knowledgeable and honest AI assistant.`,
    `Current date: ${now.toISOString().slice(0, 10)} (UTC).`,
    "Guidelines:",
    "- Answer directly and accurately. Be concise by default and go deeper when asked.",
    "- Use Markdown when it helps: headings, lists, tables, and fenced code blocks with a language tag.",
    "- If you are unsure or lack information, say so instead of guessing.",
    "- You cannot browse the internet in this version. For recent events, say your knowledge may be out of date.",
  ];
  const custom = customInstructions.trim();
  if (custom) {
    lines.push("", "The user's custom instructions (follow them unless they conflict with being safe and honest):", custom);
  }
  return lines.join("\n");
}

const TRUNCATION_NOTE = "\n\n[…message truncated to fit the model's context window…]";

/**
 * Build the prompt: system message + as many recent messages as fit in `budgetChars`.
 * - Error messages and empty replies are skipped.
 * - The newest message is always included (truncated if it alone exceeds the budget).
 * - Consecutive same-role messages are merged, and the window never starts with an
 *   assistant turn, because some providers require strict user/assistant alternation.
 */
export function buildContext(system: string, history: MessageDto[], budgetChars: number): ChatMessage[] {
  const usable = history.filter((m) => m.status !== "error" && m.content.trim().length > 0);
  const selected: ChatMessage[] = [];
  let used = system.length;

  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]!;
    const remaining = budgetChars - used;
    if (m.content.length <= remaining) {
      selected.push({ role: m.role, content: m.content });
      used += m.content.length;
      continue;
    }
    if (selected.length === 0) {
      // The newest message alone is too long: keep its beginning.
      const keep = Math.max(500, remaining - TRUNCATION_NOTE.length);
      selected.push({ role: m.role, content: m.content.slice(0, keep) + TRUNCATION_NOTE });
    }
    break;
  }
  selected.reverse();

  while (selected.length > 0 && selected[0]!.role === "assistant") selected.shift();

  const merged: ChatMessage[] = [];
  for (const m of selected) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return [{ role: "system", content: system }, ...merged];
}
