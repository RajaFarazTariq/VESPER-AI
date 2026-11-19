/**
 * Live-information tools (Phase 6a): web search, reading a web page, weather, Wikipedia and
 * currency rates. All use free services (checked 2026-11-11):
 *   - Web search: Tavily (needs TAVILY_API_KEY; free plan 1,000 credits/month, a basic search = 1 credit).
 *     A daily cap for the whole app (admin panel) keeps the monthly allowance from running out.
 *   - Page reading: fetched directly and converted to text with Cloudflare's HTMLRewriter (no third party).
 *   - Weather: Open-Meteo (no key; free for non-commercial use, attribution required: CC BY 4.0).
 *   - Wikipedia: MediaWiki search + REST page summary (no key; requests identify the app).
 *   - Currency: Frankfurter (no key; central-bank reference rates).
 * Results are kept short (Groq's free tier allows ~8K tokens a minute) and web text is wrapped as untrusted.
 */
import { z } from "zod";
import { hitRateLimit } from "../db/rate-limit";
import { checkPublicUrl, clip, FetchFailed, fetchJson, readLimited, wrapUntrusted, DEFAULT_TIMEOUT_MS } from "./net";
import { define, ToolInputError, type AgentTool, type ToolContext, type WebToolContext } from "./types";
import { checkNumbers } from "../llm/number-check";
import { getCachedSearch, HOUR_MS, putCachedSearch, searchCacheKey } from "../db/search-cache";

const DAY_MS = 24 * 60 * 60 * 1000;
const userAgent = (ctx: ToolContext) => ctx.web?.userAgent ?? "VESPER-assistant";

// ------------------------------------------------------------------ source quality (labels and ranking)

/**
 * How much a website can be trusted for facts, by simple rules (no lookups):
 * - trusted: on the admin's list (subdomains included)
 * - government: .gov/.mil/.int, country versions such as gov.pk, gov.uk, gob.mx, gouv.fr, go.jp, gc.ca, and a few
 *   international bodies (un.org, worldbank.org…)
 * - official: the organisation's own site: the site's name equals a name in the question exactly (github.com and
 *   github.blog for "GitHub"; never githubstats.com), and it isn't a page someone published on a hosting platform
 * - education: universities and research (.edu, edu.pk, ac.uk…), ranked below government and official
 * - other: everything else (news, blogs, statistics and aggregator sites)
 */
export type SourceQuality = "trusted" | "government" | "official" | "education" | "other";

export const QUALITY_BOOST: Record<SourceQuality, number> = { trusted: 3, government: 3, official: 3, education: 1.5, other: 0 };

const QUALITY_LABEL: Record<SourceQuality, string> = {
  trusted: "trusted (on the administrator's list)",
  government: "official: government or international body",
  official: "official: the organisation's own website",
  education: "university or research institution",
  other: "other website (news, blog or statistics site)",
};

/** Second-level labels that form a two-part suffix under a country code: gov.pk, edu.pk, ac.uk, co.uk, com.au… */
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gc", "go", "gob", "gouv", "gov", "govt", "mil", "ne", "net", "nic", "or", "org", "sch"]);
const GOVERNMENT_SECOND_LEVEL = new Set(["gc", "go", "gob", "gouv", "gov", "govt", "mil"]);
const EDUCATION_SECOND_LEVEL = new Set(["ac", "edu"]);
const INTERNATIONAL_BODIES = new Set(["un.org", "worldbank.org", "imf.org", "oecd.org", "wto.org", "europa.eu", "canada.ca"]);
/** Hosting platforms where anyone gets a subdomain: a name match there isn't the organisation's own site. */
const USER_CONTENT_HOSTS = [
  "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "substack.com", "medium.com", "tumblr.com", "vercel.app",
  "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com", "notion.site", "wixsite.com", "weebly.com",
];
/** Common words that are also website names; never treated as the organisation a question is about. */
const GENERIC_NAMES = new Set(
  ("about according amazing best code current data developer developers download free global guide history how info latest " +
    "news official online people price prices rate rates report review reviews share site stats statistics the time today top " +
    "update version what when where which who why world year").split(" "),
);

export interface SiteParts {
  host: string;
  /** Registrable domain, e.g. "github.com" for "docs.github.com", "pbs.gov.pk" for "www.pbs.gov.pk". */
  domain: string;
  /** The name part of the domain: "github", "pbs". */
  name: string;
  /** "com", "blog", "gov.pk"… */
  suffix: string;
}

export function siteParts(url: string): SiteParts | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !l)) return null;
  const tld = labels.at(-1)!;
  const second = labels.at(-2)!;
  const twoPart = tld.length === 2 && SECOND_LEVEL.has(second);
  const suffix = twoPart ? `${second}.${tld}` : tld;
  // "gov.uk" or "gob.mx" on their own are the suffix itself, with no organisation name in front.
  const name = twoPart ? (labels.at(-3) ?? "") : second;
  return { host, domain: name ? `${name}.${suffix}` : suffix, name, suffix };
}

/** True when the url's site is one of `sites` or a subdomain of one ("who.int" matches "www.who.int", "news.who.int"). */
export function onSiteList(url: string, sites: readonly string[]): boolean {
  const host = siteParts(url)?.host;
  return Boolean(host && sites.some((s) => host === s || host.endsWith(`.${s}`)));
}

/** Organisation names a question mentions, as website names: single words and joined pairs ("stack overflow" → "stackoverflow"). */
export function organisationNames(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const names = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.length >= 3 && !GENERIC_NAMES.has(word)) names.add(word);
    const next = words[i + 1];
    if (next) names.add(word + next);
  }
  return names;
}

export function sourceQuality(url: string, names: ReadonlySet<string>, trusted: readonly string[] = []): SourceQuality {
  const site = siteParts(url);
  if (!site) return "other";
  if (onSiteList(url, trusted)) return "trusted";
  const [second] = site.suffix.split(".");
  const twoPart = site.suffix.includes(".");
  if (["gov", "mil", "int"].includes(site.suffix) || (twoPart && GOVERNMENT_SECOND_LEVEL.has(second!)) || INTERNATIONAL_BODIES.has(site.domain)) {
    return "government";
  }
  const hosted = USER_CONTENT_HOSTS.some((h) => site.host.endsWith(`.${h}`));
  if (!hosted && names.has(site.name)) return "official";
  if (site.suffix === "edu" || (twoPart && EDUCATION_SECOND_LEVEL.has(second!))) return "education";
  return "other";
}

const PREFER_DAYS = { day: 1, week: 7, month: 31, year: 366 } as const;

export interface RankOptions {
  trusted: readonly string[];
  blocked: readonly string[];
  /** The question and search words, to recognise the organisation's own site. */
  about: string;
  /** Rank results from this period higher. Nothing is dropped for its age (no hard date filter). */
  prefer?: keyof typeof PREFER_DAYS;
  now: Date;
  keep: number;
}

const normalUrl = (url: string) => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
const wordSet = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Same page, or snippets that say practically the same thing (≥ 80% of words shared). */
export function nearDuplicate(a: { url: string; snippet: string }, b: { url: string; snippet: string }): boolean {
  if (normalUrl(a.url) === normalUrl(b.url)) return true;
  const x = wordSet(a.snippet);
  const y = wordSet(b.snippet);
  if (x.size < 8 || y.size < 8) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.8;
}

/**
 * Labels results by source quality, drops blocked sites and near-duplicates, and puts the best first:
 * quality first (trusted / government / official > education > other), then the search engine's own order.
 * With `prefer`, newer results gain up to one point and older "other" results lose one; official, trusted,
 * government and education results never lose rank for their age. Unknown dates count as neither.
 */
export function rankResults<T extends { url: string; snippet: string; published?: string }>(
  results: T[],
  options: RankOptions,
): (T & { quality: SourceQuality })[] {
  const names = organisationNames(options.about);
  const scored = results.flatMap((r, i) => {
    if (onSiteList(r.url, options.blocked)) return [];
    const quality = sourceQuality(r.url, names, options.trusted);
    let score = QUALITY_BOOST[quality] + (1 - i / Math.max(1, results.length));
    const published = r.published ? Date.parse(r.published) : Number.NaN;
    if (options.prefer && Number.isFinite(published)) {
      const window = PREFER_DAYS[options.prefer];
      const age = Math.max(0, (options.now.getTime() - published) / DAY_MS);
      if (age <= window) score += 1 - age / window;
      else if (quality === "other") score -= 1;
    }
    return [{ result: { ...r, quality }, score }];
  });
  scored.sort((a, b) => b.score - a.score);
  const kept: (T & { quality: SourceQuality })[] = [];
  for (const { result } of scored) {
    if (!kept.some((k) => nearDuplicate(k, result))) kept.push(result);
  }
  return kept.slice(0, options.keep);
}

// ------------------------------------------------------------------ web_search (Tavily)

const SEARCH_RESULTS = 8;
const RESULTS_FOR_MODEL = 6;

// ------------------------------------------------------------------ official page check (server-side)

/** Words that show the question asks for a figure (a number, share, rate, version…). */
const ASKS_FOR_FIGURE =
  /\b(?:how (?:much|many|tall|big|large|long|old|fast|often)|what (?:share|percentage|proportion|number|rate|price|percent|amount|version)|percent(?:age)?|share|rate|number of|population|price|cost|revenue|statistics?|figures?|version|latest|count|total)\b|%/i;
const OFFICIAL_PAGE_PASSAGES = 3;
const OFFICIAL_PASSAGE_CHARS = 500;
const OFFICIAL_PAGE_TIMEOUT_MS = 6_000;

const hasFigure = (text: string) => checkNumbers(text, "").checked > 0;

/**
 * The 2–3 passages of a page most relevant to the question: those sharing the most words with it, with a bonus for
 * containing a figure. Passages are ~paragraphs, clipped, and kept in page order (few tokens for the model).
 */
export function relevantPassages(pageText: string, about: string, count = OFFICIAL_PAGE_PASSAGES): string[] {
  const words = [...wordSet(about)].filter((w) => !GENERIC_NAMES.has(w));
  const paragraphs: string[] = [];
  let current = "";
  for (const line of pageText.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    current = current ? `${current} ${line}` : line;
    if (current.length >= 200) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  const scored = paragraphs.map((text, index) => {
    const own = wordSet(text);
    const shared = words.filter((w) => own.has(w)).length;
    return { text, index, score: shared + (shared > 0 && hasFigure(text) ? 2 : 0) };
  });
  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((p) => clip(p.text, OFFICIAL_PASSAGE_CHARS));
}

/**
 * When the question names an organisation and its own site is among the results, but that result's snippet has no
 * figure while the question asks for one, read the page (free: no search used) and return the best passages.
 * Any failure (blocked, slow, not a page) just means no passages.
 */
async function officialPagePassages(
  results: { url: string; snippet: string; quality: SourceQuality }[],
  about: string,
  ctx: ToolContext,
): Promise<{ url: string; passages: string[] } | null> {
  const official = results.find((r) => r.quality === "official");
  if (!official || !ASKS_FOR_FIGURE.test(about) || hasFigure(official.snippet)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICIAL_PAGE_TIMEOUT_MS);
  const stop = () => controller.abort();
  ctx.signal?.addEventListener("abort", stop);
  try {
    const page = await fetchPageText(official.url, { userAgent: userAgent(ctx), signal: controller.signal });
    const passages = relevantPassages(page.text, about);
    return passages.length ? { url: official.url, passages } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", stop);
  }
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string | null;
}
interface TavilyResponse {
  results?: TavilyResult[];
}

// ------------------------------------------------------------------ dates, time-sensitive questions, organisations

/** Questions about things that change: newer results rank higher and saved results expire after an hour. */
const TIME_SENSITIVE =
  /\b(?:latest|newest|current(?:ly)?|today|tonight|yesterday|this (?:week|month|year)|right now|nowadays|recent(?:ly)?|news|headlines?|price|prices|score|scores|ranking|rankings|population|version|releases?|released|election|ceo|president|prime minister|20(?:2[4-9]|3\d))\b/i;
export const isTimeSensitive = (text: string) => TIME_SENSITIVE.test(text);

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const monthNumber = (name: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase()) + 1;

/**
 * The first plausible date written in a snippet ("Nov 10, 2026", "10 November 2026", "2026-11-10", "November 2026")
 * as "2026-11-10" or "2026-11". Used only when the search service gives no publish date, and labelled as a date in
 * the text (it may be an event date rather than the publish date). Future dates and years before 2000 are ignored.
 */
export function dateInText(text: string, now: Date): string | undefined {
  const found: { y: number; m: number; d?: number; at: number }[] = [];
  for (const x of text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) found.push({ y: +x[1]!, m: +x[2]!, d: +x[3]!, at: x.index });
  for (const x of text.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH},?\s+(20\d{2})\b`, "gi"))) {
    found.push({ y: +x[3]!, m: monthNumber(x[2]!), d: +x[1]!, at: x.index });
  }
  for (const x of text.matchAll(new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b`, "gi"))) {
    found.push({ y: +x[3]!, m: monthNumber(x[1]!), d: +x[2]!, at: x.index });
  }
  for (const x of text.matchAll(new RegExp(String.raw`\b${MONTH}\s+(20\d{2})\b`, "gi"))) found.push({ y: +x[2]!, m: monthNumber(x[1]!), at: x.index });
  found.sort((a, b) => a.at - b.at);
  for (const c of found) {
    if (c.m < 1 || c.m > 12 || (c.d !== undefined && (c.d < 1 || c.d > 31))) continue;
    if (c.y < 2000 || Date.UTC(c.y, c.m - 1, c.d ?? 1) > now.getTime() + DAY_MS) continue;
    const month = String(c.m).padStart(2, "0");
    return c.d !== undefined ? `${c.y}-${month}-${String(c.d).padStart(2, "0")}` : `${c.y}-${month}`;
  }
  return undefined;
}

const NAME_WORDS = String.raw`[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}`;
const ATTRIBUTION = [
  new RegExp(String.raw`\b[Aa]ccording to (?:the\s+)?(${NAME_WORDS})`),
  new RegExp(String.raw`\b(?:does|did|do)\s+(${NAME_WORDS})\s+(?:say|says|report|state|claim|publish|show)\b`),
  new RegExp(String.raw`\b(${NAME_WORDS})'s\s+(?:own\s+)?(?:report|survey|data|figures?|statistics|blog|website|announcement|numbers)\b`),
];
const NOT_ORGANISATIONS = new Set(["PDF", "Document", "File", "The", "This", "My", "Your", "Our", "I", "You", "We", "It"]);

/** The organisation a question asks to be quoted on ("According to GitHub, …" → "GitHub"), if any. */
export function attributedOrganisation(question: string): string | null {
  for (const pattern of ATTRIBUTION) {
    const m = pattern.exec(question);
    const name = m?.[1]?.trim().replace(/[.,;:]+$/, "");
    if (name && !NOT_ORGANISATIONS.has(name.split(/\s+/)[0]!)) return name;
  }
  return null;
}

/** Likely own websites of an organisation, for a search limited to them ("GitHub" → github.com, github.blog…). */
export function organisationDomains(name: string): string[] {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key.length >= 3 ? ["com", "org", "blog", "co", "net"].map((tld) => `${key}.${tld}`) : [];
}

const SNIPPET_CHARS = 450;
/** When an official result has the figure, at most this many "other website" results go to the model. */
const MAX_OTHER_WITH_OFFICIAL = 2;
const STRONG_SOURCES = new Set<SourceQuality>(["trusted", "government", "official"]);

/**
 * One Tavily search, through the cache: a saved result (same words, topic and site filters, not expired) costs
 * nothing; otherwise it counts against the app's daily allowance and is saved for next time.
 * Deep research passes `counted: false` (it set its searches aside beforehand) and `network: false` once its
 * searches are used up (then only a saved result can answer; null = skipped).
 * `checkedAt`: when the search was actually made (null for a saved result from before v0.9.8).
 */
async function tavilySearch(
  web: WebToolContext,
  ctx: ToolContext,
  request: { query: string; topic: "general" | "news"; include?: string[]; maxResults: number },
  ttlMs: number,
  options: { counted?: boolean; network?: boolean } = {},
): Promise<{ results: TavilyResult[]; cached: boolean; checkedAt: number | null }> {
  const exclude = web.blockedSites ?? [];
  const key = await searchCacheKey({ query: request.query, topic: request.topic, ...(request.include ? { include: request.include } : {}), exclude });
  const saved = await getCachedSearch(ctx.db, key, ctx.now.getTime());
  if (saved) {
    try {
      return { results: (JSON.parse(saved.body) as TavilyResponse).results ?? [], cached: true, checkedAt: saved.checkedAt };
    } catch {
      // unreadable entry: search again
    }
  }
  if (options.network === false) throw new SearchSkipped();
  // One shared allowance for the whole app per UTC day (the free plan is shared by everyone).
  if (options.counted !== false) {
    const { allowed } = await hitRateLimit(ctx.db, "tool:web_search", web.webSearchDailyLimit, DAY_MS);
    if (!allowed) {
      throw new ToolInputError(
        "Today's web search allowance for this app is used up. Answer from your own knowledge and tell the user it may be out of date.",
      );
    }
  }
  const response = await fetchJson<TavilyResponse>("https://api.tavily.com/search", "Web search", {
    method: "POST",
    headers: { Authorization: `Bearer ${web.tavilyApiKey}`, "Content-Type": "application/json" },
    // No time_range is sent: a hard date filter would also drop older official pages, so recency only changes the
    // ranking (rankResults).
    body: JSON.stringify({
      query: request.query,
      search_depth: "basic",
      max_results: request.maxResults,
      topic: request.topic,
      include_answer: false,
      ...(request.include ? { include_domains: request.include } : {}),
      ...(exclude.length ? { exclude_domains: exclude } : {}),
    }),
    userAgent: web.userAgent,
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  const results = response.results ?? [];
  await putCachedSearch(ctx.db, key, JSON.stringify({ results }), ttlMs, ctx.now.getTime());
  return { results, cached: false, checkedAt: ctx.now.getTime() };
}

/** A research search that wasn't made: its searches were used up and no saved result matched. */
export class SearchSkipped extends Error {
  constructor() {
    super("search skipped");
    this.name = "SearchSkipped";
  }
}

/** "2026-11-19", or "unknown" for a saved result from before checked dates were kept. */
const checkedDate = (checkedAt: number | null) => (checkedAt === null ? "unknown" : new Date(checkedAt).toISOString().slice(0, 10));

const asFound = (r: TavilyResult, now: Date) => ({
  title: clip(r.title || r.url!, 150),
  url: r.url!,
  ...(r.published_date ? { published: r.published_date } : {}),
  snippet: clip(r.content ?? "", SNIPPET_CHARS),
  ...(!r.published_date && dateInText(r.content ?? "", now) ? { dateInText: dateInText(r.content ?? "", now)! } : {}),
});

const webSearch = define({
  name: "web_search",
  label: "Web search",
  description:
    "Search the web for current or specific information (news, prices, results, office holders, versions, anything " +
    "that may have changed or that you're unsure about). Returns up to 6 results, best sources first, with source type, " +
    "date and a snippet. Use read_page for the full page.",
  risk: "read",
  requiresMemory: false,
  isAvailable: ({ web }) => Boolean(web?.tavilyApiKey) && (web?.webSearchDailyLimit ?? 0) > 0,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A focused search query, e.g. \"Pakistan vs England test series result November 2026\"" },
      topic: { type: "string", enum: ["general", "news"], description: "Use \"news\" for recent events and headlines. Default: general." },
      time_range: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: 'Rank results from this recent period higher (older official sources are still kept). Use "year" for facts that change over time.',
      },
    },
    required: ["query"],
  },
  schema: z.object({
    query: z.string().trim().min(2).max(300),
    topic: z.enum(["general", "news"]).optional(),
    time_range: z.enum(["day", "week", "month", "year"]).optional(),
  }),
  async run({ query, topic, time_range }, ctx) {
    const web = ctx.web;
    if (!web?.tavilyApiKey || web.webSearchDailyLimit <= 0) throw new ToolInputError("Web search isn't available right now.");
    const about = `${web.question ?? ""} ${query}`; // the question and the search words
    // Saved results expire sooner for things that change.
    const ttl = isTimeSensitive(about) || topic === "news" || time_range === "day" || time_range === "week" ? HOUR_MS : 6 * HOUR_MS;
    // 8 results cost the same single search as 5; the best 6 go to the model.
    const first = await tavilySearch(web, ctx, { query, topic: topic ?? "general", maxResults: SEARCH_RESULTS }, ttl);
    const valid = (r: TavilyResult) => typeof r.url === "string" && /^https?:\/\//i.test(r.url);
    let found = first.results.filter(valid).map((r) => asFound(r, ctx.now));
    const notes: string[] = first.cached ? ["saved results"] : [];

    // The question asks for an organisation's own figure ("According to GitHub…") but none of its pages came back:
    // one more search, limited to its likely own websites (counts as a search unless saved).
    const organisation = attributedOrganisation(web.question ?? "");
    const domains = organisation ? organisationDomains(organisation) : [];
    if (domains.length && !found.some((r) => domains.includes(siteParts(r.url)?.domain ?? ""))) {
      try {
        const own = await tavilySearch(web, ctx, { query, topic: topic ?? "general", include: domains, maxResults: 5 }, ttl);
        const extra = own.results.filter(valid).map((r) => asFound(r, ctx.now));
        if (extra.length) notes.push(`also searched ${organisation}'s own sites`);
        found = [...extra, ...found];
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        // allowance used up or the service failed: the first results are still good to use
      }
    }

    const ranked = rankResults(
      found.map((r) => ({ ...r, ...(r.published || !r.dateInText ? {} : { published: r.dateInText }) })),
      {
        trusted: web.trustedSites ?? [],
        blocked: web.blockedSites ?? [],
        about,
        ...(time_range ? { prefer: time_range } : isTimeSensitive(about) ? { prefer: "year" as const } : {}),
        now: ctx.now,
        keep: RESULTS_FOR_MODEL,
      },
    );
    const officialPage = await officialPagePassages(ranked, about, ctx);
    if (officialPage) notes.push(`read the official page ${siteParts(officialPage.url)?.host ?? ""}`);
    // An official result has the figure: keep only the best 1–2 "other website" results (fewer tokens, less temptation).
    const strong = ranked.some((r) => STRONG_SOURCES.has(r.quality) && (hasFigure(r.snippet) || officialPage?.url === r.url));
    let others = 0;
    const kept = strong ? ranked.filter((r) => r.quality !== "other" || ++others <= MAX_OTHER_WITH_OFFICIAL) : ranked;
    const original = new Map(found.map((r) => [r.url, r]));
    const results = kept.map((r) => {
      const raw = original.get(r.url);
      return {
        title: r.title,
        url: r.url,
        source: QUALITY_LABEL[r.quality],
        published: raw?.published ?? "unknown",
        ...(raw && !raw.published && raw.dateInText ? { date_in_text: raw.dateInText } : {}),
        snippet: r.snippet,
        ...(officialPage && officialPage.url === r.url
          ? {
              official_page_passages: officialPage.passages,
              official_page_note: "Read automatically: the most relevant passages of this official page (its snippet had no figure).",
            }
          : {}),
      };
    });
    const heading = results.length ? `${results.length} results for "${clip(query, 80)}"` : `No results for "${clip(query, 80)}"`;
    // Saved results carry the date the search was really made, not today.
    return {
      content: wrapUntrusted("a web search", { query, retrieved: checkedDate(first.checkedAt), results }),
      summary: notes.length ? `${heading}; ${notes.join("; ")}` : heading,
      sources: results.map((r) => ({ title: r.title, url: r.url })),
    };
  },
});

// ------------------------------------------------------------------ deep research helpers (v0.9.8)

const SHORT_QUALITY: Record<SourceQuality, string> = {
  trusted: "trusted site",
  government: "official (government)",
  official: "official (own website)",
  education: "university / research",
  other: "other website",
};

/** A web source as deep research uses it. */
export interface ResearchSource {
  title: string;
  url: string;
  quality: SourceQuality;
  /** Short source type, e.g. "official (government)". */
  kind: string;
  /** Publish date from the search service or the page's own metadata; null = unknown (never guessed from the text). */
  published: string | null;
  /** When it was looked up: today, or the date a saved search was first made ("unknown" for very old saved rows). */
  checked: string;
  snippet: string;
  /** The parts of the page about the question, when the page was opened. */
  passages?: string[];
  /** Came from a saved search (cost no search). */
  saved?: boolean;
}

/**
 * One deep-research search. Never counted here: the run set its searches aside beforehand (holdResearchSearches).
 * `network: false` = its searches are used up, so only a saved result can answer (otherwise SearchSkipped).
 */
export async function researchSearch(
  web: WebToolContext,
  ctx: ToolContext,
  query: string,
  about: string,
  options: { network: boolean },
): Promise<{ sources: ResearchSource[]; cached: boolean }> {
  const ttl = isTimeSensitive(about) ? HOUR_MS : 6 * HOUR_MS;
  const found = await tavilySearch(web, ctx, { query, topic: "general", maxResults: SEARCH_RESULTS }, ttl, {
    counted: false,
    network: options.network,
  });
  const items = found.results.filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url)).map((r) => asFound(r, ctx.now));
  const ranked = rankResults(
    // A date written in the snippet only helps the ranking; it is never shown as the publish date.
    items.map((r) => ({ ...r, ...(r.published || !r.dateInText ? {} : { published: r.dateInText }) })),
    {
      trusted: web.trustedSites ?? [],
      blocked: web.blockedSites ?? [],
      about,
      ...(isTimeSensitive(about) ? { prefer: "year" as const } : {}),
      now: ctx.now,
      keep: RESULTS_FOR_MODEL,
    },
  );
  const original = new Map(items.map((r) => [r.url, r]));
  return {
    cached: found.cached,
    sources: ranked.map((r) => ({
      title: r.title,
      url: r.url,
      quality: r.quality,
      kind: SHORT_QUALITY[r.quality],
      published: publishedDate(original.get(r.url)?.published, ctx.now.getTime()) ?? null,
      checked: checkedDate(found.checkedAt),
      snippet: r.snippet,
      ...(found.cached ? { saved: true } : {}),
    })),
  };
}

/** Open one page for deep research and keep only the passages about the question (no model call). */
export async function researchPage(
  url: string,
  about: string,
  ctx: ToolContext,
): Promise<{ title: string; url: string; passages: string[]; published: string | null }> {
  const page = await fetchPageText(url, { userAgent: userAgent(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}) });
  return {
    title: clip(page.title || page.url.hostname, 150),
    url: page.url.href,
    passages: relevantPassages(page.text, about, OFFICIAL_PAGE_PASSAGES),
    published: page.published ?? null,
  };
}

// ------------------------------------------------------------------ read_page (direct fetch + HTMLRewriter)

const PAGE_TEXT_CHARS = 6_000;
const MAX_REDIRECTS = 3;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Meta tags where pages state their own publish date (never guessed from the text). */
const PUBLISHED_META =
  'meta[property="article:published_time"], meta[name="article:published_time"], meta[itemprop="datePublished"], ' +
  'meta[property="og:published_time"], meta[name="date"], meta[name="pubdate"], meta[name="publish-date"], meta[name="DC.date.issued"]';

/** "2026-11-10T08:00:00Z" → "2026-11-10"; nothing for unreadable, future or implausibly old dates. */
export function publishedDate(raw: string | null | undefined, now = Date.now()): string | undefined {
  const t = raw ? Date.parse(raw.trim()) : Number.NaN;
  if (!Number.isFinite(t) || t > now + DAY_MS || t < Date.UTC(1990, 0, 1)) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

/** Readable text of an HTML page: skips scripts, styles, navigation, headers/footers and forms. */
export async function htmlToText(html: string): Promise<{ title: string; text: string; published?: string }> {
  let title = "";
  let published: string | undefined;
  let skip = 0;
  const out: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("title", { text: (t) => void (title += t.text) })
    .on(PUBLISHED_META, { element: (el) => void (published ??= publishedDate(el.getAttribute("content"))) })
    .on("head, script, style, noscript, svg, template, iframe, nav, footer, form, aside, header, button, select", {
      element(el) {
        skip++;
        try {
          el.onEndTag(() => void skip--);
        } catch {
          skip--; // void element: nothing inside it
        }
      },
    })
    .on("p, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote, dd, dt, figcaption, br, div, section, article, table", {
      element: () => void out.push("\n"),
    })
    .onDocument({ text: (t) => void (skip === 0 && out.push(t.text)) });
  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  const text = decodeEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text, ...(published ? { published } : {}) };
}

/**
 * Open a public web page and return its title and readable text. Every redirect hop is checked
 * again (public http(s) addresses only). Used by read_page and by the knowledge base's
 * "Add web page". Failures are ToolInputErrors with a plain explanation.
 */
export async function fetchPageText(
  raw: string,
  options: { userAgent: string; signal?: AbortSignal; maxBytes?: number },
): Promise<{ url: URL; title: string; text: string; truncated: boolean; published?: string }> {
  let url = checkPublicUrl(raw);
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      response = await fetch(url.href, {
        redirect: "manual",
        headers: { "User-Agent": options.userAgent, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), options.signal])
          : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new FetchFailed(`Couldn't open ${url.hostname} (no answer or too slow).`);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new FetchFailed("The page redirected too many times.");
      url = checkPublicUrl(new URL(location, url).href); // every hop is checked again
      continue;
    }
    break;
  }
  if (!response) throw new FetchFailed("Couldn't open the page.");
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FetchFailed(`The page returned an error (HTTP ${response.status}).`);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("pdf")) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError("That's a PDF file. Reading PDFs from the web isn't supported yet.");
  }
  const isHtml = !type || type.includes("html") || type.includes("xml");
  if (!isHtml && !type.startsWith("text/")) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`That address isn't a readable web page (it's ${type.split(";")[0]}).`);
  }
  const { text: body, truncated } = await readLimited(response, options.maxBytes ?? 1_500_000);
  const page: { title: string; text: string; published?: string } = isHtml ? await htmlToText(body) : { title: "", text: body.trim() };
  if (!page.text) throw new ToolInputError("The page has no readable text (it may need JavaScript or a login).");
  return { url, title: page.title, text: page.text, truncated, ...(page.published ? { published: page.published } : {}) };
}

const readPage = define({
  name: "read_page",
  label: "Read a web page",
  description:
    "Open a public web page (http/https) and read its main text, e.g. a search result or a link the user gave you. " +
    "PDFs and pages that need a login can't be read.",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The full address, starting with https://" } },
    required: ["url"],
  },
  schema: z.object({ url: z.string().trim().min(8).max(2000) }),
  async run({ url: raw }, ctx) {
    const page = await fetchPageText(raw, { userAgent: userAgent(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const { url } = page;
    const title = clip(page.title || url.hostname, 150);
    const text = page.text.length > PAGE_TEXT_CHARS ? `${page.text.slice(0, PAGE_TEXT_CHARS)}…` : page.text;
    const source = QUALITY_LABEL[sourceQuality(url.href, organisationNames(ctx.web?.question ?? ""), ctx.web?.trustedSites ?? [])];
    return {
      content: wrapUntrusted(url.hostname, { url: url.href, title, source, text, cut_off: page.truncated || page.text.length > PAGE_TEXT_CHARS }),
      summary: `Read "${clip(title, 80)}"`,
      sources: [{ title, url: url.href }],
    };
  },
});

// ------------------------------------------------------------------ weather (Open-Meteo)

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 56: "light freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "light freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light rain showers", 81: "rain showers",
  82: "violent rain showers", 85: "light snow showers", 86: "heavy snow showers", 95: "thunderstorm",
  96: "thunderstorm with light hail", 97: "heavy thunderstorm", 99: "thunderstorm with heavy hail",
};
const conditions = (code: unknown) => (typeof code === "number" ? (WMO[code] ?? `weather code ${code}`) : "unknown");

interface GeoResponse {
  results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string; timezone?: string }[];
}
interface ForecastResponse {
  timezone?: string;
  current?: Record<string, number | string>;
  current_units?: Record<string, string>;
  daily?: Record<string, (number | string | null)[]>;
}

const weather = define({
  name: "weather",
  label: "Weather",
  description:
    "Current weather and the forecast (up to 7 days) for a city or place, e.g. \"Lahore\" or \"Paris, France\". " +
    "If the user didn't say where, ask them (or use a location they asked you to remember).",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or place name, optionally with the country, e.g. \"Lahore, Pakistan\"" },
      days: { type: "integer", minimum: 1, maximum: 7, description: "How many days of forecast (default 3)." },
    },
    required: ["location"],
  },
  schema: z.object({ location: z.string().trim().min(2).max(100), days: z.number().int().min(1).max(7).optional() }),
  async run({ location, days }, ctx) {
    const options = { userAgent: userAgent(ctx), signal: ctx.signal };
    const geocode = (name: string) =>
      fetchJson<GeoResponse>(
        `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: "1", language: "en", format: "json" })}`,
        "The weather service",
        options,
      );
    let place = (await geocode(location)).results?.[0];
    if (!place && location.includes(",")) place = (await geocode(location.split(",")[0]!.trim())).results?.[0];
    if (!place) throw new ToolInputError(`Couldn't find a place called "${location}". Try a nearby city name.`);

    const forecast = await fetchJson<ForecastResponse>(
      `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
        timezone: "auto",
        forecast_days: String(days ?? 3),
      })}`,
      "The weather service",
      options,
    );
    const name = [place.name, place.admin1, place.country].filter((p, i, all) => p && all.indexOf(p) === i).join(", ");
    const c = forecast.current ?? {};
    const d = forecast.daily ?? {};
    const daily = (d.time ?? []).map((date, i) => ({
      date,
      conditions: conditions(d.weather_code?.[i]),
      min_c: d.temperature_2m_min?.[i] ?? null,
      max_c: d.temperature_2m_max?.[i] ?? null,
      rain_chance_pct: d.precipitation_probability_max?.[i] ?? null,
      precipitation_mm: d.precipitation_sum?.[i] ?? null,
    }));
    const current = {
      local_time: c.time ?? null,
      conditions: conditions(c.weather_code),
      temperature_c: c.temperature_2m ?? null,
      feels_like_c: c.apparent_temperature ?? null,
      humidity_pct: c.relative_humidity_2m ?? null,
      precipitation_mm: c.precipitation ?? null,
      wind_kmh: c.wind_speed_10m ?? null,
    };
    return {
      content: JSON.stringify({ location: name, timezone: forecast.timezone ?? place.timezone ?? null, current, daily, attribution: "Weather data by Open-Meteo.com (CC BY 4.0)" }),
      summary: `${name}: ${current.temperature_c ?? "?"}°C, ${current.conditions}`,
      sources: [{ title: `Weather data by Open-Meteo.com (${place.name})`, url: "https://open-meteo.com/" }],
    };
  },
});

// ------------------------------------------------------------------ wikipedia

interface WikiSearchResponse {
  query?: { search?: { title: string }[] };
}
interface WikiSummary {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

const wikipedia = define({
  name: "wikipedia",
  label: "Wikipedia",
  description:
    "Look up a topic on Wikipedia (people, places, history, science, organisations…) and get the article's summary and link. " +
    "Good for stable facts; for recent news use web_search.",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up, e.g. \"Allama Iqbal\" or \"photosynthesis\"" },
      language: { type: "string", description: "Wikipedia language code, e.g. \"en\" (default) or \"ur\"" },
    },
    required: ["query"],
  },
  schema: z.object({ query: z.string().trim().min(1).max(200), language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/).optional() }),
  async run({ query, language }, ctx) {
    const lang = language ?? "en";
    const options = { userAgent: userAgent(ctx), signal: ctx.signal };
    const search = await fetchJson<WikiSearchResponse>(
      `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: "3", format: "json", utf8: "1" })}`,
      "Wikipedia",
      options,
    );
    const titles = (search.query?.search ?? []).map((s) => s.title).filter(Boolean);
    if (titles.length === 0) throw new ToolInputError(`Wikipedia has no article matching "${query}".`);
    const summary = await fetchJson<WikiSummary>(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[0]!.replace(/ /g, "_"))}`,
      "Wikipedia",
      options,
    );
    const title = summary.title ?? titles[0]!;
    const url = summary.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    return {
      content: wrapUntrusted("Wikipedia", {
        title,
        description: summary.description ?? null,
        summary: clip(summary.extract ?? "", 2_500),
        ...(summary.type === "disambiguation" ? { note: "This is a disambiguation page: the name has several meanings." } : {}),
        url,
        other_matching_articles: titles.slice(1),
      }),
      summary: `Wikipedia: ${clip(title, 80)}`,
      sources: [{ title: `${title} – Wikipedia`, url }],
    };
  },
});

// ------------------------------------------------------------------ currency (Frankfurter)

const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,5}$/, "Use a currency code like USD, PKR or EUR");

const currency = define({
  name: "currency",
  label: "Exchange rates",
  description:
    "Latest (or historical) exchange rates and conversions between currencies, e.g. USD to PKR. " +
    "Reference rates from central banks; banks and money changers add their own margin.",
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Currency code to convert from, e.g. \"USD\"" },
      to: { type: "array", items: { type: "string" }, description: "Up to 5 currency codes to convert to, e.g. [\"PKR\", \"EUR\"]" },
      amount: { type: "number", description: "Amount in the 'from' currency (default 1)" },
      date: { type: "string", description: "Optional past date, YYYY-MM-DD (default: latest)" },
    },
    required: ["from", "to"],
  },
  schema: z.object({
    from: currencyCode,
    to: z.union([currencyCode, z.array(currencyCode).min(1).max(5)]),
    amount: z.number().positive().max(1e12).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  }),
  async run({ from, to, amount, date }, ctx) {
    const targets = [...new Set(Array.isArray(to) ? to : [to])].filter((t) => t !== from);
    if (targets.length === 0) throw new ToolInputError("Choose at least one different currency to convert to.");
    const rows = await fetchJson<{ date: string; base: string; quote: string; rate: number }[] | { message?: string }>(
      `https://api.frankfurter.dev/v2/rates?${new URLSearchParams({ base: from, quotes: targets.join(","), ...(date ? { date } : {}) })}`,
      "The exchange-rate service",
      { userAgent: userAgent(ctx), signal: ctx.signal },
    );
    const list = Array.isArray(rows) ? rows.filter((r) => typeof r.rate === "number") : [];
    if (list.length === 0) throw new ToolInputError(`No rate found for ${from} → ${targets.join(", ")}. Check the currency codes.`);
    const value = amount ?? 1;
    const round = (n: number) => (Math.abs(n) >= 1 ? Math.round(n * 100) / 100 : Number(n.toPrecision(6)));
    const rates = list.map((r) => ({ to: r.quote, rate: r.rate, ...(amount !== undefined ? { amount: value, converted: round(value * r.rate) } : {}) }));
    const missing = targets.filter((t) => !list.some((r) => r.quote === t));
    const first = list[0]!;
    return {
      content: JSON.stringify({
        date: first.date,
        from,
        rates,
        ...(missing.length ? { not_found: missing } : {}),
        note: "Central-bank reference rates (via Frankfurter); banks and money changers add their own margin.",
      }),
      summary: `${value} ${from} = ${round(value * first.rate)} ${first.quote} (${first.date})`,
      sources: [{ title: "Exchange rates by Frankfurter (central-bank data)", url: "https://frankfurter.dev/" }],
    };
  },
});

export const WEB_TOOLS: AgentTool[] = [webSearch, readPage, weather, wikipedia, currency];
