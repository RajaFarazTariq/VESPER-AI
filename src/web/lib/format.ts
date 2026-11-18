import type { ConversationDto, ModelsResponse, ProviderId, SourceDto } from "../../shared/types";

/** Some models (e.g. gpt-oss) cite in 【 】 brackets: show those as normal round brackets. */
export const tidyCitations = (text: string) => text.replace(/【([^【】\n]{1,300})】/g, "($1)");

const plainText = (s: string) => s.replace(/[    ]/g, " ").toLowerCase();

/** Page numbers an answer mentions: "page 6", "page6", "pages 2 and 14", "pages 2, 14", "pp. 3–5", "p. 7". */
function mentionedPages(text: string): Set<number> {
  const pages = new Set<number>();
  for (const m of text.matchAll(/\b(?:pages?|pp?\.)\s*(\d+(?:\s*(?:,|and|&|or|–|-|to)\s*\d+)*)/g)) {
    for (const part of m[1]!.split(/\s*(?:,|and|&|or)\s*/)) {
      const [from, to] = part.split(/\s*(?:–|-|to)\s*/).map(Number);
      if (from === undefined || !Number.isFinite(from)) continue;
      const end = to !== undefined && Number.isFinite(to) && to >= from && to - from <= 50 ? to : from;
      for (let n = from; n <= end; n++) pages.add(n);
    }
  }
  return pages;
}

/**
 * The sources to list under an answer. Web links are always kept. A knowledge-base page or section is kept only when
 * the answer cites it, so passages the assistant read but didn't use don't look like sources (an answer saying "the
 * document doesn't cover this" lists none). With one document a bare "(page 6)" counts; with several, it must be named.
 */
export function citedSources(sources: SourceDto[], answer: string): SourceDto[] {
  const text = plainText(tidyCitations(answer));
  const documents = new Set(sources.filter((s) => !s.url).map((s) => s.title));
  const pages = mentionedPages(text);
  return sources.filter((s) => {
    if (s.url) return true;
    const title = plainText(s.title);
    const bare = title.replace(/\.[a-z0-9]{2,5}$/, "").trim(); // "Handbook" for "Handbook.pdf"
    const named = text.includes(title) || (bare.length >= 4 && text.includes(bare));
    if (!named && documents.size > 1) return false;
    const location = plainText(s.location ?? "").trim();
    if (!location) return named;
    const page = /^page (\d+)$/.exec(location);
    if (page) return pages.has(Number(page[1]));
    const section = location.replace(/^section\s*/, "").replace(/[“”"]/g, "").trim();
    return section.length > 0 && text.includes(section);
  });
}

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
