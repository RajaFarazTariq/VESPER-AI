import type { MemoryDto, MessageDto } from "../../shared/types";
/** Plain text messages (no tool calls): what conversation history is made of. */
export type PlainMessage = { role: "system" | "user" | "assistant"; content: string };

export interface SystemPromptInput {
  appName: string;
  customInstructions: string;
  /** Saved long-term memories (only when memory is enabled). */
  memories?: MemoryDto[];
  /** Names of tools offered this turn. */
  tools?: string[];
  now?: Date;
}

const MAX_MEMORY_PROMPT_CHARS = 6_000;

export function buildSystemPrompt(input: SystemPromptInput): string {
  const now = input.now ?? new Date();
  const lines = [
    `You are ${input.appName}, a helpful, knowledgeable and honest AI assistant.`,
    `Current date: ${now.toISOString().slice(0, 10)} (UTC).`,
    "Guidelines:",
    "- Answer directly and accurately. Be concise by default and go deeper when asked.",
    "- Use Markdown when it helps: headings, lists, tables, and fenced code blocks with a language tag.",
    "- If you are unsure or lack information, say so instead of guessing.",
    "- You cannot browse the internet in this version. For recent events, say your knowledge may be out of date.",
  ];
  const tools = input.tools ?? [];
  if (tools.length > 0) {
    lines.push(
      "",
      `Tools available: ${tools.join(", ")}.`,
      "- Call a tool whenever it gives a more reliable answer.",
      ...(tools.includes("calculator")
        ? ["- Use the calculator for every calculation beyond simple whole-number arithmetic (percentages, decimals, money, multi-step sums). Don't do it in your head."]
        : []),
      "- Never claim you used a tool, saved something or got a result unless a tool call actually returned it.",
      "- After using tools, answer the user in normal prose; don't paste raw tool output.",
      "- For math notation, use LaTeX between $$ … $$ (single $ is reserved for currency).",
    );
  }
  if (input.memories) {
    lines.push("", "Long-term memory (facts the user asked you to remember; use them when relevant, don't recite them unprompted):");
    if (input.memories.length === 0) {
      lines.push("- (nothing saved yet)");
    } else {
      let used = 0;
      for (const m of [...input.memories].reverse()) {
        const line = `- [${m.id}] ${m.content}`;
        if (used + line.length > MAX_MEMORY_PROMPT_CHARS) break;
        lines.push(line);
        used += line.length;
      }
    }
    if (tools.includes("remember")) {
      lines.push("Use the remember tool when the user asks you to remember something; use forget with the [id] to remove one.");
    }
  }
  const custom = input.customInstructions.trim();
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
export function buildContext(system: string, history: MessageDto[], budgetChars: number): PlainMessage[] {
  const usable = history.filter((m) => m.status !== "error" && m.content.trim().length > 0);
  const selected: PlainMessage[] = [];
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

  const merged: PlainMessage[] = [];
  for (const m of selected) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return [{ role: "system", content: system }, ...merged];
}
