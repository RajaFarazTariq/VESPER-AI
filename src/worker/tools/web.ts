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
import { define, ToolInputError, type AgentTool, type ToolContext } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const userAgent = (ctx: ToolContext) => ctx.web?.userAgent ?? "VESPER-assistant";

// ------------------------------------------------------------------ web_search (Tavily)

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string; published_date?: string | null }[];
}

const webSearch = define({
  name: "web_search",
  label: "Web search",
  description:
    "Search the web for current or specific information: news, recent events, prices, schedules, sports results, " +
    "current office holders, product details, anything that may have changed recently or that you're unsure about. " +
    "Returns up to 5 results with title, URL and a text snippet. Use read_page to read a result in full when the snippet isn't enough.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (web) => Boolean(web?.tavilyApiKey) && (web?.webSearchDailyLimit ?? 0) > 0,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A focused search query, e.g. \"Pakistan vs England test series result November 2026\"" },
      topic: { type: "string", enum: ["general", "news"], description: "Use \"news\" for recent events and headlines. Default: general." },
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this recent period (optional)." },
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
    // One shared allowance for the whole app per UTC day (the free plan is shared by everyone).
    const { allowed } = await hitRateLimit(ctx.db, "tool:web_search", web.webSearchDailyLimit, DAY_MS);
    if (!allowed) {
      throw new ToolInputError(
        "Today's web search allowance for this app is used up. Answer from your own knowledge and tell the user it may be out of date.",
      );
    }
    const response = await fetchJson<TavilyResponse>("https://api.tavily.com/search", "Web search", {
      method: "POST",
      headers: { Authorization: `Bearer ${web.tavilyApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        topic: topic ?? "general",
        include_answer: false,
        ...(time_range ? { time_range } : {}),
      }),
      userAgent: web.userAgent,
      timeoutMs: 15_000,
      signal: ctx.signal,
    });
    const results = (response.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
      .slice(0, 5)
      .map((r) => ({
        title: clip(r.title || r.url!, 150),
        url: r.url!,
        ...(r.published_date ? { published: r.published_date } : {}),
        snippet: clip(r.content ?? "", 600),
      }));
    return {
      content: wrapUntrusted("a web search", { query, results }),
      summary: results.length ? `${results.length} results for "${clip(query, 80)}"` : `No results for "${clip(query, 80)}"`,
      sources: results.map((r) => ({ title: r.title, url: r.url })),
    };
  },
});

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

/** Readable text of an HTML page: skips scripts, styles, navigation, headers/footers and forms. */
export async function htmlToText(html: string): Promise<{ title: string; text: string }> {
  let title = "";
  let skip = 0;
  const out: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("title", { text: (t) => void (title += t.text) })
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
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text };
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
    let url = checkPublicUrl(raw);
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        response = await fetch(url.href, {
          redirect: "manual",
          headers: { "User-Agent": userAgent(ctx), Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
          signal: ctx.signal ? AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ctx.signal]) : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
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
      throw new ToolInputError("That's a PDF file. Reading PDFs isn't supported yet.");
    }
    const isHtml = !type || type.includes("html") || type.includes("xml");
    if (!isHtml && !type.startsWith("text/")) {
      await response.body?.cancel().catch(() => {});
      throw new ToolInputError(`That address isn't a readable web page (it's ${type.split(";")[0]}).`);
    }
    const { text: body, truncated: bodyCut } = await readLimited(response, 1_500_000);
    const page = isHtml ? await htmlToText(body) : { title: "", text: body.trim() };
    if (!page.text) throw new ToolInputError("The page has no readable text (it may need JavaScript or a login).");
    const title = clip(page.title || url.hostname, 150);
    const text = page.text.length > PAGE_TEXT_CHARS ? `${page.text.slice(0, PAGE_TEXT_CHARS)}…` : page.text;
    return {
      content: wrapUntrusted(url.hostname, { url: url.href, title, text, cut_off: bodyCut || page.text.length > PAGE_TEXT_CHARS }),
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
