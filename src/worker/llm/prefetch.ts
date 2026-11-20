/**
 * Search first, answer in one call (v0.9.5).
 *
 * Normally a question that needs a search takes two model requests: one where the model asks for the search, and one
 * with the results. Groq's free plan allows 8,000 tokens a minute, and two such requests don't fit, so those answers
 * fell back to the smallest Gemini model. For questions that clearly need a look-up, the server now runs the search
 * before the first request and sends the question together with the results: one request, which fits.
 *
 * Simple word rules decide (no extra model call). When unsure, nothing is prefetched and the model decides as before.
 */
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
  /^\s*(?:please\s+)?(?:write|draft|compose|translate|summari[sz]e|rewrite|rephrase|paraphrase|correct|proofread|explain this|fix|debug|refactor|code|generate|create|make)\b/i;
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

/**
 * The tool call to run before the first model request, or null to let the model decide.
 * `available` is the set of tools offered this turn (the user's and admin's switches are respected).
 */
export function planPrefetch(question: string, available: ReadonlySet<string>): ToolCall | null {
  const text = question.trim();
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
