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
const PASSAGE_CHARS = 1_100;
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const RERANK_TIMEOUT_MS = 8_000;

type RerankOutput = { response?: { id?: number; score?: number }[] };

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
    "Search the knowledge base: documents the administrator added (for example handbooks, policies, books, notes and saved web pages). " +
    "Returns the most relevant passages with their document name and page or section. Check it whenever a question relates to " +
    "one of its folders (documents can be out of date: for things that change over time, compare with the web). Use specific key words from the topic; " +
    "if nothing relevant comes back, try different words or synonyms before concluding the documents don't cover it.",
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
  // `limit` isn't offered to the model: the server uses it for the smaller search it runs alongside a web search.
  schema: z.object({
    query: z.string().trim().min(2).max(300),
    folder: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(RESULTS).optional(),
  }),
  async run({ query, folder, limit }, ctx) {
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
    const best = await rerank(ctx.ai, query, candidates, limit ?? RESULTS);
    const results = best.map((h, i) => ({
      ref: i + 1,
      source: "your document (the administrator's knowledge base)",
      document: h.title,
      ...(h.location ? { location: h.location } : {}),
      folder: h.collection,
      ...(h.sourceUrl ? { url: h.sourceUrl } : {}),
      text: clip(h.text, PASSAGE_CHARS),
    }));
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
