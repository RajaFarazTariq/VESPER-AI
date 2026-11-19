/**
 * search_knowledge: answers from the documents the administrator added (admin panel → Knowledge).
 *
 * 1. Full-text search (FTS5, BM25) finds up to 30 candidate passages that share key words with the query.
 * 2. Workers AI's re-ranker (@cf/baai/bge-reranker-base, ~280 Neurons per million tokens, so a search
 *    costs about 4 of the 10,000 free daily Neurons) re-orders them by meaning; the best 6 are returned.
 *    Without the AI binding (local dev, tests) or on any error, the keyword order is kept.
 * 3. Each passage carries its document and location, so the answer can cite "Handbook.pdf, page 12".
 * Passages are wrapped as untrusted data: documents (and saved web pages) may contain instructions.
 */
import { z } from "zod";
import type { SourceDto } from "../../shared/types";
import { searchChunks, type KnowledgeHit } from "../db/knowledge";
import { clip, wrapUntrusted } from "./net";
import { define } from "./types";

const CANDIDATES = 30;
const RESULTS = 6;
const PASSAGE_CHARS = 800;
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const RERANK_TIMEOUT_MS = 8_000;

type RerankOutput = { response?: { id?: number; score?: number }[] };

// A capitalised name of up to five words ("GitHub", "World Health Organization", "Bank of England").
const ORG = String.raw`[A-Z][\w&'.-]*(?:\s+(?:of\s+|for\s+|and\s+|the\s+)?[A-Z][\w&'.-]*){0,4}`;
const QUOTE_VERBS = "reported|reports|found|finds|said|says|announced|announces|estimated|estimates|stated|states|revealed|reveals|claimed|claims|published|publishes|showed|shows";
const NAME_THEN_VERB = new RegExp(String.raw`(?<![\w.])(${ORG})(?:'s)?,?\s+(?:\[\d+(?:\s*[,–-]\s*\d+)*\]\s+)?(?:has\s+|have\s+|had\s+|also\s+)?(?:${QUOTE_VERBS})\b`, "g");
const ACCORDING_TO = new RegExp(String.raw`\b[Aa]ccording to (?:the\s+)?(${ORG})`, "g");
/** Capitalised words that start sentences or name people's roles, not organisations. */
const NOT_NAMES = new Set(
  ("A An And As At But By For However In It Its On Our Recent Previous Prior Some Many Most Other Others Another Each " +
    "Researchers Authors Study Studies Survey Results Table Figure Section Chapter The Their These They This Those We He She " +
    "Early Later Finally First Second Third Overall Similarly Also Further").split(" "),
);

/**
 * Organisations a document passage quotes: "GitHub reported…", "Thomas Dohmke, CEO of GitHub, said…",
 * "according to the World Health Organization". Such a passage is second-hand for that organisation's own figures.
 * People cited as authors ("Peng et al. [40] reported") aren't organisations and are skipped.
 */
export function quotedOrganisations(text: string): string[] {
  const names = new Set<string>();
  for (const m of [...text.matchAll(NAME_THEN_VERB), ...text.matchAll(ACCORDING_TO)]) {
    let name = m[1]!.replace(/^(?:CEO|CTO|CFO|President|Director|Head|Chief|Founder|Chairman|Chair|Spokesperson|Minister)\s+of\s+(?:the\s+)?/, "").trim();
    name = name.replace(/[.,]+$/, "");
    const first = name.split(/\s+/)[0]!;
    if (!name || NOT_NAMES.has(first) || name.length < 2) continue;
    names.add(name);
  }
  return [...names].slice(0, 3);
}

/** Common words that don't show what a question is about (besides the usual small words). */
const COMMON_WORDS = new Set(
  ("the and for are was were has had but not you can its our out who how why any all his her she him they use new one " +
    "two get got may per via own too now off yet nor did does done say says said see seen way ask " +
    "about according after also another because been before being between both could does each from have here into just " +
    "like made make many more most much must only other over same should since some such than that their them then there " +
    "these they this those through very what when where which while will with would your share percent percentage written " +
    "write writes latest version current number total overall data report tell know").split(" "),
);
const wordKey = (w: string) => (w.length > 5 ? w.slice(0, 5) : w); // "developers" ~ "developer"

/** The words that carry a question's topic: 3+ letters, not common words, not plain numbers (years). */
export function topicWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !COMMON_WORDS.has(w))
      .map(wordKey),
  );
}

/** A passage is about a question when it shares at least two of the question's topic words (or its only one). */
export function passageAboutQuestion(passage: string, words: ReadonlySet<string>): boolean {
  if (words.size === 0) return false;
  const own = topicWords(passage);
  let shared = 0;
  for (const w of words) if (own.has(w)) shared++;
  return shared >= Math.min(2, words.size);
}

/** The source label for a passage: "your document", or "your document (quoting GitHub)". */
export function documentSourceLabel(text: string): string {
  const quoted = quotedOrganisations(text);
  return quoted.length ? `your document (quoting ${quoted.join(", ")})` : "your document";
}

/** Order passages by meaning (best first) with the re-ranker; falls back to the given order. */
export async function rerank(ai: Ai | undefined, query: string, hits: KnowledgeHit[], top: number): Promise<KnowledgeHit[]> {
  if (!ai || hits.length <= 1) return hits.slice(0, top);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = ai.run as unknown as (model: string, input: unknown) => Promise<RerankOutput>;
    const result = await Promise.race([
      run.call(ai, RERANK_MODEL, {
        query: query.slice(0, 500),
        contexts: hits.map((h) => ({ text: h.text.slice(0, 1_500) })),
        top_k: Math.min(top, hits.length),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("re-ranker timed out")), RERANK_TIMEOUT_MS);
      }),
    ]);
    const ordered = (result.response ?? [])
      .filter((r): r is { id: number; score?: number } => typeof r.id === "number" && hits[r.id] !== undefined)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((r) => hits[r.id]!);
    return ordered.length > 0 ? ordered.slice(0, top) : hits.slice(0, top);
  } catch (error) {
    console.warn(JSON.stringify({ msg: "knowledge re-rank failed; using keyword order", error: String(error) }));
    return hits.slice(0, top);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One source per document location, in the order used (web pages keep their link). */
function sourcesOf(hits: KnowledgeHit[]): SourceDto[] {
  const seen = new Set<string>();
  const out: SourceDto[] = [];
  for (const h of hits) {
    const key = `${h.documentId}|${h.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: h.title, ...(h.sourceUrl ? { url: h.sourceUrl } : {}), ...(h.location ? { location: h.location } : {}) });
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const searchKnowledge = define({
  name: "search_knowledge",
  label: "Knowledge base",
  description:
    "Search the knowledge base: documents the administrator added (handbooks, policies, papers, saved web pages). Returns " +
    "the most relevant passages with document name and page or section. Use it when a question relates to one of its folders; " +
    "use specific key words, and try synonyms before concluding the documents don't cover it.",
  risk: "read",
  requiresMemory: false,
  isAvailable: ({ knowledgeReady }) => Boolean(knowledgeReady),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: 'Key words or a short question, e.g. "annual leave carry over"' },
      folder: { type: "string", description: "Optional: the name of one knowledge-base folder to search. Leave out to search all." },
    },
    required: ["query"],
  },
  // `limit` and `relevantOnly` aren't offered to the model: the server uses them for the smaller search it runs
  // alongside a web search, which keeps only passages that are about the question (no tokens spent on unrelated ones).
  schema: z.object({
    query: z.string().trim().min(2).max(300),
    folder: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(RESULTS).optional(),
    relevantOnly: z.boolean().optional(),
  }),
  async run({ query, folder, limit, relevantOnly }, ctx) {
    const candidates = await searchChunks(ctx.db, query, { ...(folder ? { collection: folder } : {}), limit: CANDIDATES });
    if (candidates.length === 0) {
      return {
        content: JSON.stringify({
          query,
          results: [],
          note: folder
            ? `Nothing found in the folder "${folder}". Try other key words, or search all folders.`
            : "Nothing found. Try other key words or synonyms; if still nothing, the documents probably don't cover this.",
        }),
        summary: `Nothing found for "${clip(query, 60)}"`,
      };
    }
    const ranked = await rerank(ctx.ai, query, candidates, limit ?? RESULTS);
    const words = topicWords(query);
    const best = relevantOnly ? ranked.filter((h) => passageAboutQuestion(h.text, words)) : ranked;
    if (best.length === 0) {
      return {
        content: JSON.stringify({ query, results: [], note: "Nothing in the documents is about this question." }),
        summary: `Nothing relevant for "${clip(query, 60)}"`,
      };
    }
    const results = best.map((h, i) => {
      const quoted = quotedOrganisations(h.text);
      // The warning sits in the passage text itself, where the model reads the figure.
      const warning = quoted.length
        ? `[This document quotes ${quoted.join(", ")}; it is not ${quoted.length === 1 ? `${quoted[0]}'s` : "their"} own publication] `
        : "";
      return {
        ref: i + 1,
        source: documentSourceLabel(h.text),
        document: h.title,
        ...(h.location ? { location: h.location } : {}),
        folder: h.collection,
        ...(h.sourceUrl ? { url: h.sourceUrl } : {}),
        text: warning + clip(h.text, PASSAGE_CHARS),
      };
    });
    const documents = new Set(best.map((h) => h.documentId)).size;
    return {
      content: wrapUntrusted("the knowledge base", {
        query,
        results,
        how_to_cite: 'Cite the passages you use inline as (document, location), e.g. (Handbook.pdf, page 12).',
      }),
      summary: `Found ${plural(best.length, "passage")} in ${plural(documents, "document")}`,
      sources: sourcesOf(best),
      evidence: best.map((h) => h.text).join("\n\n"), // whole passages, for the number check
    };
  },
});
