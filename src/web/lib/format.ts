import type { ConversationDto, FeedbackReason, ModelsResponse, ProviderId, SourceDto, ToolEventDto } from "../../shared/types";

/** What a 👎 can say was wrong (same words for users and the admin). */
export const FEEDBACK_LABELS: Record<FeedbackReason, string> = {
  wrong: "Wrong facts",
  outdated: "Out of date",
  unanswered: "Didn't answer the question",
  other: "Other",
};

/** Some models (e.g. gpt-oss) cite in 【 】 brackets: show those as normal round brackets. */
export const tidyCitations = (text: string) => text.replace(/【([^【】\n]{1,300})】/g, "($1)");

/**
 * Document citations are plain text, never links: a Markdown link whose text names one of the answer's knowledge-base
 * documents, or whose target isn't a real web address, is shown as its text only. Real web links (including web PDFs
 * such as https://…/report.pdf) stay links.
 */
export function plainDocumentLinks(text: string, documentTitles: readonly string[]): string {
  const names = documentTitles
    .map((t) => t.toLowerCase())
    .flatMap((t) => {
      const bare = t.replace(/\.[a-z0-9]{2,5}$/, "").trim();
      return bare.length >= 4 && bare !== t ? [t, bare] : [t];
    });
  // The target may contain spaces ("](AI in Software Engineering.pdf)"): not a valid link, but models write it.
  return text.replace(/\[([^\]\n]{1,300})\]\(([^)\n]*)\)/g, (link, label: string, target: string) => {
    const lower = label.toLowerCase();
    const namesDocument = names.some((n) => lower.includes(n));
    const href = target.trim().replace(/\s+"[^"]*"$/, "");
    return namesDocument || !/^https?:\/\/\S+$/i.test(href) ? label : link;
  });
}

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

// ------------------------------------------------------------------ sources under an answer (v0.12.4)

/** Tools that return a list of search results: an answer may use some of them, or none. */
const RESULT_LIST_TOOLS = new Set(["web_search", "github_search"]);

/**
 * A web address for comparing: no scheme, "www.", tracking parameters or trailing slash, so the same page written two
 * ways matches. The #part is kept only when asked (GitHub line ranges are different sources).
 */
function urlKey(url: string, keepHash: boolean): string {
  try {
    const u = new URL(url.trim());
    for (const name of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(name)) u.searchParams.delete(name);
    const query = u.searchParams.toString();
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}${keepHash ? u.hash : ""}`;
  } catch {
    return url.trim();
  }
}

const count = (text: string, char: string) => text.split(char).length - 1;

/** Every web address an answer links to or writes out (Markdown links, <…> links and bare addresses), as urlKey. */
export function linkedUrls(answer: string): Set<string> {
  const out = new Set<string>();
  for (const m of answer.matchAll(/https?:\/\/[^\s<>"\]`]+/gi)) {
    let url = m[0];
    // A Markdown link's closing ")" and sentence punctuation aren't part of the address; "(…)" inside it is (Wikipedia).
    while (/[.,;:!?*_~']$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
    out.add(urlKey(url, false));
  }
  return out;
}

export interface AnswerSources {
  /** The numbered chips under the answer. */
  shown: SourceDto[];
  /** Search results the answer didn't link to: listed only when the user asks ("+N other results checked"). */
  unused: SourceDto[];
}

/**
 * Which sources to show under an answer. Pages the answer actually used are shown: the search results it links to,
 * and everything from tools that fetch one thing (a page it read, Wikipedia, weather, currency, a GitHub file or
 * issue, a research report's cited sources). Search results it never linked are set aside as `unused`. An answer
 * that links none of its sources keeps them all, so nothing is hidden without a reason. Document pages follow
 * citedSources (only the pages the answer cites). The same page found twice is listed once.
 */
export function answerSources(tools: ToolEventDto[] | null | undefined, answer: string): AnswerSources {
  const found = new Map<string, { source: SourceDto; fromResults: boolean }>();
  for (const tool of tools ?? []) {
    const fromResults = RESULT_LIST_TOOLS.has(tool.name);
    for (const source of tool.sources ?? []) {
      // Web pages need an http(s) link; knowledge-base documents are identified by title + location.
      if (source.url !== undefined && !/^https?:\/\//i.test(source.url)) continue;
      const key = source.url
        ? `${urlKey(source.url, hostOf(source.url) === "github.com")}|${source.location ?? ""}`
        : `doc:${source.title}|${source.location ?? ""}`;
      const known = found.get(key);
      if (!known) found.set(key, { source, fromResults });
      else if (!fromResults) known.fromResults = false; // a search result that was also read is a used page
    }
  }
  const all = [...found.values()];
  const linked = linkedUrls(answer);
  const isLinked = (s: SourceDto) => Boolean(s.url && linked.has(urlKey(s.url, false)));
  const linksAny = all.some((f) => isLinked(f.source));
  const cited = new Set(citedSources(all.map((f) => f.source), answer));
  const shown: SourceDto[] = [];
  const unused: SourceDto[] = [];
  for (const { source, fromResults } of all) {
    if (!cited.has(source)) continue; // a document page the answer doesn't cite
    if (source.url && fromResults && linksAny && !isLinked(source)) unused.push(source);
    else shown.push(source);
  }
  return { shown, unused };
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A page title without its site-name ending ("Census 2023 | Pakistan Bureau of Statistics" → "Census 2023"). */
function pageTitle(title: string): string {
  const parts = title.split(/\s+[|–—·]\s+|\s+-\s+/);
  const first = (parts[0] ?? "").trim();
  const short = first.length >= 6 ? first : title.trim();
  return short.length > 60 ? `${short.slice(0, 59).trimEnd()}…` : short;
}

/** The last part of a page's path as words ("/census/final-results-2023.html" → "final results 2023"). */
function pathWords(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * The text on each chip. Web pages show their site; when the same site is listed more than once, its chips also show
 * the page title (or the page's address when the titles are the same) so they can be told apart. GitHub chips show the
 * repository, file and lines; documents show their name and page.
 */
export function chipLabels(sources: SourceDto[]): string[] {
  const hosts = sources.map((s) => (s.url ? hostOf(s.url) : ""));
  const perHost = new Map<string, number>();
  for (const h of hosts) if (h) perHost.set(h, (perHost.get(h) ?? 0) + 1);
  const titles = sources.map((s) => pageTitle(s.title));
  return sources.map((s, i) => {
    const host = hosts[i]!;
    if (!s.url) return s.location ? `${s.title} · ${s.location}` : s.title;
    if (host === "github.com") return s.title;
    if ((perHost.get(host) ?? 0) < 2) return host;
    const sameTitle = titles.some((t, j) => j !== i && hosts[j] === host && t === titles[i]);
    const detail = (sameTitle && pathWords(s.url)) || titles[i];
    return detail ? `${host} · ${detail}` : host;
  });
}

// ------------------------------------------------------------------ GitHub line links (v0.12.4)

const GITHUB_BLOB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{7,40}\/([^#?]+)/i;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Files of the user's repositories that this answer read: path (and unique file name) → address without "#L…". */
function githubFilesRead(tools: ToolEventDto[] | null | undefined): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const tool of tools ?? []) {
    if (tool.name !== "github_file") continue;
    for (const s of tool.sources ?? []) {
      const m = s.url ? GITHUB_BLOB.exec(s.url) : null;
      if (!m) continue;
      try {
        byPath.set(decodeURIComponent(m[1]!), s.url!.replace(/[#?].*$/, ""));
      } catch {
        // a malformed address: leave it out
      }
    }
  }
  const names = new Map(byPath);
  const base = (p: string) => p.split("/").pop() ?? p;
  for (const path of byPath.keys()) {
    const name = base(path);
    if (name !== path && [...byPath.keys()].filter((p) => base(p) === name).length === 1) names.set(name, byPath.get(path)!);
  }
  return names;
}

// Code blocks, links and bare addresses are never changed (split() keeps them at odd positions).
const UNTOUCHED = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]*>|https?:\/\/[^\s<>()\]]+)/g;
const LINES = String.raw`(?:L|lines?\s+)(\d{1,6})(?:\s*[-–—]\s*L?(\d{1,6}))?`;
// A bare "L9–13" right after some other file's name ("other.ts L9–13") belongs to that file, not the one read.
const NOT_AFTER_A_FILE = String.raw`(?<!\.[A-Za-z0-9]{1,8}\`?[,:]?\s*\(?\s*)`;

/**
 * GitHub line links in an answer. GitHub highlights lines only for "#L9-L13"; models sometimes shorten it to
 * "#L9-13", which is repaired. A plain line reference next to a file the answer read ("src/app.ts L9–13",
 * "`src/app.ts` (lines 9-13)", "src/app.ts:9-13"; a bare "L9–13" or "(L9)" when only one file was read) becomes a link
 * to those lines at the exact commit the file was read at. Code, inline code and existing links are left alone.
 */
export function githubLineLinks(text: string, tools: ToolEventDto[] | null | undefined): string {
  const repaired = text.replace(/(https:\/\/github\.com\/[^\s()<>\]]+\/blob\/[^\s()<>#\]]+#L\d+)[-–](\d+)(?!\d)/gi, "$1-L$2");
  const files = githubFilesRead(tools);
  if (!files.size) return repaired;
  const oneFile = new Set(files.values()).size === 1 ? [...files.values()][0]! : null;
  const paths = [...files.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const pattern = new RegExp(
    [
      // 1 tick, 2 path, then "(L9–13)" 3–4 | " L9–13" / ", lines 9-13" 5–6 | ":9-13" 7–8
      String.raw`(?<![\w./-])(\`?)(${paths})\1(?:\s*,?\s*\(\s*${LINES}\s*\)|\s*,?\s+${LINES}(?![\w])|:(\d{1,6})(?:-(\d{1,6}))?(?![\w]))`,
      // 9: other inline code stays as it is
      "(`[^`\\n]*`)",
      // 10–11: a bare range "L9–13" | 12: "(L9)"
      String.raw`${NOT_AFTER_A_FILE}(?<![\w./-])L(\d{1,6})\s*[-–—]\s*L?(\d{1,6})(?![\w])`,
      String.raw`${NOT_AFTER_A_FILE}(?<=\()L(\d{1,6})(?=\))`,
    ].join("|"),
    "g",
  );
  const link = (label: string, url: string, from: string, to?: string) => {
    const a = Number(from);
    const b = to === undefined ? a : Number(to);
    if (!(a > 0)) return label;
    return `[${label}](${url}#L${a}${b > a ? `-L${b}` : ""})`;
  };
  return repaired
    .split(UNTOUCHED)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(pattern, (whole, ...g: (string | undefined)[]) => {
            if (g[1] !== undefined) {
              const url = files.get(g[1])!;
              const from = g[2] ?? g[4] ?? g[6];
              return from ? link(whole, url, from, g[3] ?? g[5] ?? g[7]) : whole;
            }
            if (g[8] !== undefined || !oneFile) return whole;
            if (g[9] !== undefined) return link(whole, oneFile, g[9], g[10]);
            if (g[11] !== undefined) return link(whole, oneFile, g[11]);
            return whole;
          }),
    )
    .join("");
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
