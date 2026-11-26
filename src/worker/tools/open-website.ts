/**
 * Open a website (v0.19.0): "open YouTube", "go to github.com/RajaFarazTariq". Browsers don't let a page open another
 * site by itself, so the answer gets an "Open youtube.com" button (ToolEventDto.link) that the user taps; nothing is
 * ever opened automatically.
 *
 * Well-known names map to fixed https addresses. Anything else must be an http(s) address the USER typed in this chat
 * (the same leak-guard idea as for email addresses): an address the model put together, or one from a web page or a
 * document, could carry the user's data in it or lead somewhere they never asked for, so it is refused. Private,
 * local and IP-number addresses are refused too.
 */
import { z } from "zod";
import { checkPublicUrl, clip } from "./net";
import { define, ToolInputError, type AgentTool, type ToolOutput } from "./types";

/** Well-known sites by the names people use for them (lower case, words separated by single spaces). */
const KNOWN_SITES: [names: string[], url: string, title: string][] = [
  [["youtube", "yt"], "https://www.youtube.com", "YouTube"],
  [["youtube music"], "https://music.youtube.com", "YouTube Music"],
  [["gmail", "google mail", "my email", "my inbox"], "https://mail.google.com", "Gmail"],
  [["github"], "https://github.com", "GitHub"],
  [["google drive", "drive", "my drive"], "https://drive.google.com", "Google Drive"],
  [["google docs", "docs"], "https://docs.google.com", "Google Docs"],
  [["google sheets", "sheets"], "https://sheets.google.com", "Google Sheets"],
  [["google calendar", "calendar", "my calendar"], "https://calendar.google.com", "Google Calendar"],
  [["google maps", "maps"], "https://www.google.com/maps", "Google Maps"],
  [["google"], "https://www.google.com", "Google"],
  [["google news", "news", "news sites", "the news"], "https://news.google.com", "Google News"],
  [["google photos", "photos"], "https://photos.google.com", "Google Photos"],
  [["whatsapp", "whatsapp web"], "https://web.whatsapp.com", "WhatsApp Web"],
  [["wikipedia", "wiki"], "https://www.wikipedia.org", "Wikipedia"],
  [["netflix"], "https://www.netflix.com", "Netflix"],
  [["spotify"], "https://open.spotify.com", "Spotify"],
  [["linkedin"], "https://www.linkedin.com", "LinkedIn"],
  [["x", "twitter", "x twitter", "twitter x"], "https://x.com", "X"],
  [["facebook", "fb"], "https://www.facebook.com", "Facebook"],
  [["messenger"], "https://www.messenger.com", "Messenger"],
  [["instagram", "insta"], "https://www.instagram.com", "Instagram"],
  [["tiktok"], "https://www.tiktok.com", "TikTok"],
  [["reddit"], "https://www.reddit.com", "Reddit"],
  [["pinterest"], "https://www.pinterest.com", "Pinterest"],
  [["stack overflow", "stackoverflow"], "https://stackoverflow.com", "Stack Overflow"],
  [["outlook", "hotmail"], "https://outlook.live.com", "Outlook"],
  [["yahoo mail"], "https://mail.yahoo.com", "Yahoo Mail"],
  [["amazon"], "https://www.amazon.com", "Amazon"],
  [["daraz"], "https://www.daraz.pk", "Daraz"],
  [["foodpanda"], "https://www.foodpanda.pk", "foodpanda"],
  [["olx"], "https://www.olx.com.pk", "OLX"],
  [["bbc", "bbc news"], "https://www.bbc.com/news", "BBC News"],
  [["cnn"], "https://www.cnn.com", "CNN"],
  [["reuters"], "https://www.reuters.com", "Reuters"],
  [["al jazeera", "aljazeera"], "https://www.aljazeera.com", "Al Jazeera"],
  [["dawn", "dawn news"], "https://www.dawn.com", "Dawn"],
  [["geo", "geo news"], "https://www.geo.tv", "Geo News"],
  [["express tribune", "tribune"], "https://tribune.com.pk", "The Express Tribune"],
  [["the news international"], "https://www.thenews.com.pk", "The News International"],
  [["espncricinfo", "cricinfo"], "https://www.espncricinfo.com", "ESPNcricinfo"],
];

const BY_NAME = new Map(KNOWN_SITES.flatMap(([names, url, title]) => names.map((n) => [n, { url, title }] as const)));

/** "The YouTube website" → "youtube"; "X/Twitter" → "x twitter". */
function siteKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|open|go to)\s+/, "")
    .replace(/\s+(?:website|web site|site|homepage|home page|page|app|dot com)$/, "")
    .trim();
}

export function knownSite(text: string): { url: string; title: string } | null {
  const key = siteKey(text);
  return BY_NAME.get(key) ?? BY_NAME.get(key.replace(/\s+(?:web|com)$/, "")) ?? null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The address without its scheme, "www." and a closing slash, in lower case: what the user would have typed. */
const typedForm = (url: URL) => `${url.host}${url.pathname}${url.search}`.toLowerCase().replace(/^www\./, "").replace(/\/$/, "");

/**
 * Whether the user typed this address in the chat (with or without https:// or www.). It must stand on its own in
 * their text: "evil.com" isn't in "notevil.com", and "example.com" isn't in "example.com.evil.net".
 */
export function userTyped(url: URL, userText: string | undefined): boolean {
  const form = typedForm(url);
  if (!form) return false;
  let decoded = form;
  try {
    decoded = decodeURI(form); // "example.com/café" is typed as it reads, not as %C3%A9
  } catch {
    // not decodable: only the form as it is
  }
  return [...new Set([form, decoded])].some((f) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}.@-])(?:https?://)?(?:www\\.)?${escapeRegExp(f)}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "iu").test(userText ?? ""),
  );
}

/** A site name or an address the user typed → a safe https/http URL to offer, or a refusal in words for the model. */
export function websiteFor(site: string, userText: string | undefined): { url: string; title: string } {
  const known = knownSite(site);
  if (known) return known;
  const raw = site.trim();
  // "github.com/owner" without a scheme: an address too (a bare word isn't).
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[^\s/]+\.[^\s/]{2,}(?:[/?#]\S*)?$/.test(raw) ? `https://${raw}` : null;
  if (!withScheme) {
    throw new ToolInputError(`"${clip(raw, 60)}" isn't a site VESPER knows by name. Ask the user for its web address (like example.com).`);
  }
  const url = checkPublicUrl(withScheme);
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) {
    throw new ToolInputError("Addresses given as IP numbers can't be opened. Ask the user for the site's name.");
  }
  if (!userTyped(url, userText)) {
    throw new ToolInputError(
      "Only addresses the user typed in this chat can be opened (not ones from a web page, a document or put together by you). Ask the user to type the address.",
    );
  }
  return { url: url.toString(), title: host.replace(/^www\./, "") };
}

const openWebsite = define({
  name: "open_website",
  label: "Open a website",
  description:
    'An Open button for a website: a well-known name ("YouTube", "Gmail") or an address the user typed. Never opens by itself.',
  risk: "read",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: { site: { type: "string" } },
    required: ["site"],
  },
  schema: z.object({ site: z.string().trim().min(1).max(2_000) }),
  async run({ site }, ctx): Promise<ToolOutput> {
    const link = websiteFor(site, ctx.userText);
    const domain = new URL(link.url).hostname.replace(/^www\./, "");
    return {
      content: JSON.stringify({
        ready: true,
        url: link.url,
        note: `An "Open ${domain}" button is shown under your reply; browsers don't open sites by themselves. Say "Tap Open to go there." Never say it was opened.`,
      }),
      summary: `Open ${domain}`,
      link,
    };
  },
});

export const OPEN_WEBSITE_TOOLS: AgentTool[] = [openWebsite];
