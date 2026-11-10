import type { ConversationDto, ModelsResponse, ProviderId } from "../../shared/types";

const PROVIDER_LABELS: Record<string, string> = {
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  "workers-ai": "Workers AI",
  ollama: "Ollama (local)",
};

export const providerLabel = (id: string | null | undefined) => (id ? (PROVIDER_LABELS[id] ?? id) : "");

/** Short human label for a model selection like "groq:openai/gpt-oss-120b". */
export function selectionLabel(selection: string, models?: ModelsResponse | null): string {
  if (selection === "auto") return "Auto (free)";
  const friendly = models?.userModels?.find((m) => m.value === selection);
  if (friendly) return friendly.label;
  const index = selection.indexOf(":");
  if (index < 0) return selection;
  const provider = selection.slice(0, index);
  const model = selection.slice(index + 1);
  const known = models?.providers
    .find((p) => p.id === (provider as ProviderId))
    ?.models.find((m) => m.id === model);
  const name = known?.label ?? model.split("/").pop() ?? model;
  return `${name} · ${providerLabel(provider)}`;
}

export function groupConversations(conversations: ConversationDto[], now = new Date()): [string, ConversationDto[]][] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups: Record<string, ConversationDto[]> = {};
  const order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
  for (const c of conversations) {
    const t = c.updatedAt;
    const label =
      t >= startOfToday
        ? "Today"
        : t >= startOfToday - day
          ? "Yesterday"
          : t >= startOfToday - 7 * day
            ? "Previous 7 days"
            : t >= startOfToday - 30 * day
              ? "Previous 30 days"
              : "Older";
    (groups[label] ??= []).push(c);
  }
  return order.filter((label) => groups[label]?.length).map((label) => [label, groups[label]!]);
}

export function formatRelative(until: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((until - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
