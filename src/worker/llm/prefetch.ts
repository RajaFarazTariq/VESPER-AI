/**
 * Search first, answer in one call (v0.9.5).
 *
 * Normally a question that needs a search takes two model requests: one where the model asks for the search, and one
 * with the results. Groq's free plan allows 8,000 tokens a minute, and two such requests don't fit, so those answers
 * fell back to the smallest Gemini model. For questions that clearly need a look-up, the server now runs the search
 * before the first request and sends the question together with the results: one request, which fits.
 *
 * Simple word rules decide (no extra model call). When unsure, nothing is prefetched and the model decides as before.
 *
 * In a chat with documents (v0.16.0) the documents come first: a summary request reads the newest document, a
 * question about "the report" or "page 12" (or one sent with the documents) searches or reads them. The web isn't
 * searched first there: "the 2025 results" is about the file, not the news (the model can still search itself).
 */
import { READ_DOCUMENT_TOOL, SEARCH_DOCUMENTS_TOOL } from "../../shared/documents";
import { isTimeSensitive } from "../tools/web";
import type { ToolCall } from "./types";

/** Questions about the user's own documents: search the knowledge base first. */
const ABOUT_DOCUMENTS =
  /\b(?:my|our|the|this|that|uploaded|attached)\s+(?:pdf|document|documents|file|files|paper|report|handbook|policy|knowledge base)\b|\bknowledge base\b/i;
/** Asks for an organisation's own figure: worth a search even without a "latest" word. */
// Case-sensitive on purpose: "does GitHub say" names an organisation, "does it say" doesn't.
const ATTRIBUTION = /\b[Aa]ccording to\b|\b(?:[Dd]oes|[Dd]id)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}\s+(?:say|report|state)\b/;
/** Plain sums ("What is 2025 minus 2024?"): the calculator's job, even when a year appears. */
const ARITHMETIC = /^\s*(?:what\s+is\s+|what's\s+|calculate\s+|compute\s+)?[\d\s+\-*/().,%^=x×÷]+(?:\s*(?:plus|minus|times|divided by|of)\s*[\d\s+\-*/().,%^=x×÷]+)*\s*\??\s*$/i;
/** Requests the model handles without the web (or with its own dedicated tool). */
const NOT_A_LOOKUP =
  /^\s*(?:please\s+)?(?:write|draft|compose|translate|summari[sz]e|rewrite|rephrase|paraphrase|correct|proofread|explain this|fix|debug|refactor|code|generate|create|make|remind|set a reminder)\b/i;
const HAS_OWN_TOOL = /\b(?:weather|temperature|forecast|rain|humidity|convert|conversion|exchange rate)\b/i;
const MAX_QUESTION_CHARS = 600;

/**
 * About the user's code on GitHub (v0.13.1): "Current version" in "change the README line 'Current version …' in
 * owner/repo" isn't a question for the web. Only when GitHub tools are offered; the model can still search itself.
 */
const GITHUB_TOOLS = ["github_repo", "github_file", "github_open_pr", "github_create_issue", "github_comment"];
const ABOUT_CODE =
  /github\.com\/|\b(?:repo|repos|repository|repositories|pull requests?|PRs?|commits?|branch(?:es)?|README|codebase)\b|#\d+\b|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|md|json|ya?ml|css|html)\b/i;
function namesRepo(text: string): boolean {
  if (ABOUT_CODE.test(text)) return true;
  // "owner/name" like RajaFarazTariq/VESPER-AI or octo-dev/app (not "and/or", "km/h", "24/7").
  for (const m of text.matchAll(/\b([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{2,100})/g)) {
    const [, owner = "", name = ""] = m;
    if (/[A-Za-z]/.test(owner) && /[A-Za-z]/.test(name) && /[A-Z-]/.test(owner + name)) return true;
  }
  return false;
}

/** Asks for a summary of a document: read it in order. */
const SUMMARY_REQUEST =
  /\b(?:summar(?:y|ies|i[sz]e[ds]?|i[sz]ing)|overview|key (?:points|takeaways)|main (?:points|ideas)|tl;?dr)\b|\bwhat(?:'s|’s|\s+is)\s+(?:this|the|that|my|attached)\s+(?:document|file|pdf|report|paper)\s+(?:all\s+)?about\b/i;
/** About the documents in the chat: "the report", "this file", "my PDF"… (a page is read instead, see PAGE). */
const ABOUT_CHAT_DOCUMENTS = /\b(?:the|this|that|these|those|my|our|attached|uploaded)\s+(?:documents?|files?|pdfs?|reports?|papers?)\b/i;
/** "page 12": read that page (the newest document's), rather than searching for the words "page" and "12". */
const PAGE = /\bpage\s+(\d{1,4})\b/i;

/** The chat's documents as the prefetch sees them: D1, D2… and file names. */
export interface PrefetchDocuments {
  /** This message came with documents (they are the newest ones). */
  attached: boolean;
  list?: { ref: string; name: string }[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one document a message names ("D2", "report.pdf", "the report"), or null when it names none or several. */
export function namedDocument(text: string, list: { ref: string; name: string }[]): string | null {
  const named = list.filter((d) => {
    if (new RegExp(`\\b${escapeRegExp(d.ref)}\\b`, "i").test(text)) return true;
    const name = d.name.toLowerCase();
    const bare = name.replace(/\.[a-z0-9]{1,5}$/, "");
    const lower = text.toLowerCase();
    return lower.includes(name) || (bare.length >= 4 && lower.includes(bare));
  });
  return named.length === 1 ? named[0]!.ref : null;
}

/**
 * Chats with documents (v0.16.0): read or search them first, or let the model decide (null).
 * Only for messages that are clearly about the documents: sent with them, naming one, or saying "the report", "this
 * file"… ("give me an overview of photosynthesis" in such a chat is left to the model). With several documents and
 * none named, nothing is read first (it could be the wrong one); a search covers all of them.
 */
function planDocumentPrefetch(text: string, available: ReadonlySet<string>, documents: PrefetchDocuments): ToolCall | null {
  const read = available.has(READ_DOCUMENT_TOOL);
  const list = documents.list ?? [];
  // A message without words (only the documents): read the newest one, which was just attached.
  if (!/[\p{L}\p{N}]/u.test(text)) return read ? call(READ_DOCUMENT_TOOL, {}) : null;
  // Long messages are often pasted text the user wants handled ("summarise this"): the model decides.
  if (text.length > MAX_QUESTION_CHARS) return null;
  const target = namedDocument(text, list);
  const page = PAGE.exec(text);
  const aboutDocuments = documents.attached || target !== null || page !== null || ABOUT_CHAT_DOCUMENTS.test(text);
  if (!aboutDocuments) return null;
  const which = target ? { document: target } : {};
  // Which document to read: the named one, the only one, or (right after attaching) the newest.
  const canRead = read && (target !== null || list.length <= 1 || documents.attached);
  if (page && canRead) return call(READ_DOCUMENT_TOOL, { ...which, page: Number(page[1]) });
  if (SUMMARY_REQUEST.test(text)) return canRead ? call(READ_DOCUMENT_TOOL, which) : null;
  if (available.has(SEARCH_DOCUMENTS_TOOL) && text.length >= 2) return call(SEARCH_DOCUMENTS_TOOL, { query: text.slice(0, 300), ...which });
  return null;
}

/**
 * The tool call to run before the first model request, or null to let the model decide.
 * `available` is the set of tools offered this turn (the user's and admin's switches are respected).
 * `documents`: the chat has documents and the document tools are offered.
 */
export function planPrefetch(question: string, available: ReadonlySet<string>, documents?: PrefetchDocuments): ToolCall | null {
  const text = question.trim();
  if (documents) return planDocumentPrefetch(text, available, documents);
  if (text.length < 8 || text.length > MAX_QUESTION_CHARS || NOT_A_LOOKUP.test(text) || ARITHMETIC.test(text)) return null;
  if (GITHUB_TOOLS.some((name) => available.has(name)) && namesRepo(text)) return null;
  if (ABOUT_DOCUMENTS.test(text)) {
    return available.has("search_knowledge") ? call("search_knowledge", { query: text.slice(0, 300) }) : null;
  }
  if (HAS_OWN_TOOL.test(text) || !available.has("web_search")) return null;
  if (!isTimeSensitive(text) && !ATTRIBUTION.test(text)) return null;
  return call("web_search", {
    query: text.slice(0, 300),
    ...(/\b(?:news|headlines?|today|yesterday|this week)\b/i.test(text) ? { topic: "news" } : {}),
    time_range: "year",
  });
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `prefetch-${name}`, name, arguments: JSON.stringify(args) });

/** The note added under the user's question for the model, with what the server already looked up. */
export function prefetchNote(label: string, content: string): string {
  return (
    `\n\n[The app already ran "${label}" for this question before you answer. Use these results under the source rules; ` +
    `call a tool only if they don't answer the question. Results:]\n${content}`
  );
}
