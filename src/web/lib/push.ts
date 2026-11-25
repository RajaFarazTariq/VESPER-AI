/**
 * Proactive VESPER (v0.18.0) in the browser: notifications on this device (Web Push, shown by the service worker
 * public/sw.js). Used by Settings → Notifications only, so it is downloaded with that tab. (VESPER Agent's briefing
 * request and spoken progress line are in agent-voice.ts.)
 *
 * Tests import this file, and the worker typecheck (which reads the tests) has no DOM types: the helpers at the top
 * need nothing from the page, and the browser part below reaches the page's APIs through `globalThis` with the few
 * types it uses written out here. Nothing runs at load.
 */

// ------------------------------------------------------------------ Which browser this is ("Chrome on Windows")

/**
 * A short name for this browser, shown in the device list: "Chrome on Windows", "Opera on Windows", "Chrome on
 * Android", "Safari on iPhone". `touchPoints` tells an iPad (which says "Macintosh") from a Mac; Brave says it is
 * Chrome, so the page tells it apart (`brave`).
 */
export function deviceLabel(userAgent: string, { touchPoints = 0, brave = false }: { touchPoints?: number; brave?: boolean } = {}): string {
  const ua = userAgent;
  const browser = brave
    ? "Brave"
    : /\bEdg(?:e|A|iOS)?\//.test(ua)
      ? "Edge"
      : /\b(?:OPR|OPX|OPT|OPiOS)\/|\bOpera\b/.test(ua)
        ? "Opera"
        : /\bSamsungBrowser\//.test(ua)
          ? "Samsung Internet"
          : /\bYaBrowser\//.test(ua)
            ? "Yandex Browser"
            : /\bVivaldi\//.test(ua)
              ? "Vivaldi"
              : /\b(?:Firefox|FxiOS)\//.test(ua)
                ? "Firefox"
                : /\b(?:Chrome|CriOS|Chromium)\//.test(ua)
                  ? "Chrome"
                  : /\bSafari\//.test(ua)
                    ? "Safari"
                    : "Browser";
  const os = /\bWindows\b/.test(ua)
    ? "Windows"
    : /\bAndroid\b/.test(ua)
      ? "Android"
      : /\b(?:iPhone|iPod)\b/.test(ua)
        ? "iPhone"
        : /\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && touchPoints > 1)
          ? "iPad"
          : /\bMac OS X\b|\bMacintosh\b/.test(ua)
            ? "Mac"
            : /\bCrOS\b/.test(ua)
              ? "ChromeOS"
              : /\bLinux\b/.test(ua)
                ? "Linux"
                : null;
  return os ? `${browser} on ${os}` : browser;
}

/** iPhone or iPad (an iPad says "Macintosh" but has a touch screen). */
export const isAppleMobile = (userAgent: string, touchPoints = 0) =>
  /\b(?:iPhone|iPod|iPad)\b/.test(userAgent) || (/\bMacintosh\b/.test(userAgent) && touchPoints > 1);

// ------------------------------------------------------------------ The server's key (base64url ↔ bytes)

/** The server's public key ("BEl6…", base64url without padding) → the bytes `pushManager.subscribe` wants. */
export function base64UrlToBytes(text: string): Uint8Array {
  const base64 = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes (a subscription's keys) → base64url without padding, as the server stores them. */
export function bytesToBase64Url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether a subscription was made with this key (a new server key needs a new subscription). */
export function sameKey(a: ArrayBuffer | Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------ Times ("22:00", "Today, 17:00")

/**
 * A time from the time picker as "HH:MM", or null when it isn't one. Pickers give "22:00", some "22:00:00"; a
 * typed "7:05" becomes "07:05".
 */
export function parseTime(value: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The calendar day of `t` in `timeZone`: its year, and a number that grows by one per day (for "today"/"tomorrow"). */
function calendarDay(t: number, timeZone: string): { year: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), day: Date.UTC(get("year"), get("month") - 1, get("day")) / 86_400_000 };
}

/** A time zone the browser knows, else the browser's own. */
function knownZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/**
 * When a reminder is due, in its own time zone: "Today, 17:00", "Tomorrow, 09:00", "Wed 27 Nov, 09:00" (with the year
 * when it isn't this year's).
 */
export function reminderTime(dueAt: number, timeZone: string | null | undefined, now = Date.now()): string {
  const zone = knownZone(timeZone) ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(dueAt);
  const due = calendarDay(dueAt, zone);
  const today = calendarDay(now, zone);
  if (due.day === today.day) return `Today, ${time}`;
  if (due.day === today.day + 1) return `Tomorrow, ${time}`;
  const sameYear = due.year === today.year;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).formatToParts(dueAt);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}${sameYear ? "" : ` ${get("year")}`}, ${time}`;
}

/** What a test notification did: "Sent to 2 devices." */
export function testResult({ sent, failed }: { sent: number; failed: number }): string {
  const devices = (n: number) => `${n} device${n === 1 ? "" : "s"}`;
  if (sent === 0 && failed === 0) return "No device has notifications on yet.";
  if (sent === 0) return failed === 1 ? "Couldn't reach your device. Try switching notifications off and on again there." : `Couldn't reach any of your ${devices(failed)}.`;
  return `Sent to ${devices(sent)}.${failed ? ` ${devices(failed)} couldn't be reached.` : ""}`;
}

// ------------------------------------------------------------------ This browser (the page's APIs, typed here)

interface SubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
  unsubscribe(): Promise<boolean>;
}
interface RegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
  };
}
interface PageLike {
  isSecureContext?: boolean;
  navigator?: {
    userAgent?: string;
    maxTouchPoints?: number;
    /** iOS: opened from the Home Screen. */
    standalone?: boolean;
    brave?: unknown;
    serviceWorker?: {
      register(url: string, options?: { scope?: string }): Promise<RegistrationLike>;
      getRegistration(scope?: string): Promise<RegistrationLike | undefined>;
      readonly ready: Promise<RegistrationLike>;
    };
  };
  PushManager?: unknown;
  Notification?: {
    readonly permission: string;
    /** Older Safari answers through the callback only. */
    requestPermission(callback?: (permission: string) => void): Promise<string> | undefined;
  };
  matchMedia?: (query: string) => { matches: boolean };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
}
const page = () => globalThis as unknown as PageLike;

/**
 * Whether this browser can get VESPER notifications. "ios-home-screen": iPhone and iPad allow them only for a site
 * added to the Home Screen and opened from there. "insecure": they need https (or localhost).
 */
export type PushSupport = "ok" | "unsupported" | "insecure" | "ios-home-screen";

export function pushSupport(): PushSupport {
  const p = page();
  const nav = p.navigator;
  const ua = nav?.userAgent ?? "";
  const installed = nav?.standalone === true || p.matchMedia?.("(display-mode: standalone)").matches === true;
  // Service workers exist only on https (and localhost), so an http page lacks them all.
  if (p.isSecureContext === false) return "insecure";
  if (nav?.serviceWorker && p.PushManager !== undefined && p.Notification !== undefined) return "ok";
  if (isAppleMobile(ua, nav?.maxTouchPoints ?? 0) && !installed) return "ios-home-screen";
  return "unsupported";
}

/** "granted", "denied" or "default" (not asked yet); "unsupported" without notifications. */
export function notificationPermission(): "granted" | "denied" | "default" | "unsupported" {
  const value = page().Notification?.permission;
  return value === "granted" || value === "denied" || value === "default" ? value : "unsupported";
}

/** This browser's name for the device list. */
export function thisDeviceLabel(): string {
  const nav = page().navigator;
  return deviceLabel(nav?.userAgent ?? "", { touchPoints: nav?.maxTouchPoints ?? 0, brave: nav?.brave !== undefined });
}

/** The browser's time zone ("Asia/Karachi"), sent with the device and with every settings change. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Why switching notifications on didn't work, in plain words. */
export class PushError extends Error {
  constructor(
    readonly code: "unsupported" | "denied" | "dismissed" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/** What the server needs to send to this browser (`POST /api/notifications/devices`, with the label and time zone). */
export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const DEVICE_KEY = "vesper-push-device";

/** The server's id for this browser's subscription (remembered when it was switched on here). */
export function savedDeviceId(): string | null {
  try {
    return page().localStorage?.getItem(DEVICE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDeviceId(id: string | null): void {
  try {
    const storage = page().localStorage;
    if (id) storage?.setItem(DEVICE_KEY, id);
    else storage?.removeItem(DEVICE_KEY);
  } catch {
    // storage unavailable: this device then shows as "off" next time, and switching on again fixes it
  }
}

/** This browser's current subscription, without registering anything; whether it uses the server's key `publicKey`. */
export async function currentSubscription(publicKey?: string): Promise<{ endpoint: string; keyMatches: boolean } | null> {
  const container = page().navigator?.serviceWorker;
  if (!container) return null;
  try {
    const registration = await container.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return null;
    const key = subscription.options?.applicationServerKey;
    return { endpoint: subscription.endpoint, keyMatches: !publicKey || key === undefined || sameKey(key, base64UrlToBytes(publicKey)) };
  } catch {
    return null;
  }
}

/** Asks for permission (the browser's own prompt: call this straight from a tap). */
async function askPermission(): Promise<string> {
  const N = page().Notification;
  if (!N) return "denied";
  if (N.permission !== "default") return N.permission;
  return new Promise<string>((resolve) => {
    const answer = N.requestPermission(resolve);
    if (answer && typeof answer.then === "function") answer.then(resolve, () => resolve(N.permission));
  });
}

const BLOCKED =
  "Notifications are blocked for this site. To allow them, click the padlock (or site icon) at the left of the address bar → Notifications → Allow, then reload this page.";

/**
 * Switches notifications on in this browser: asks for permission (first, while the tap still counts), registers the
 * service worker (/sw.js, scope /), and subscribes with the server's public key (a subscription made with an older
 * key is replaced). Returns what the server needs; throws a PushError with a plain message.
 */
export async function subscribe(publicKey: string): Promise<PushSubscriptionInfo> {
  if (pushSupport() !== "ok") throw new PushError("unsupported", "This browser can't show VESPER notifications.");
  const permission = await askPermission();
  if (permission === "denied") throw new PushError("denied", BLOCKED);
  if (permission !== "granted") throw new PushError("dismissed", "Notifications weren't allowed. Press Turn on again and choose Allow.");
  const container = page().navigator!.serviceWorker!;
  const key = base64UrlToBytes(publicKey);
  let subscription: SubscriptionLike | null;
  try {
    await container.register("/sw.js", { scope: "/" });
    // Subscribing needs the worker active, not just installed.
    const { pushManager } = await container.ready;
    const options = { userVisibleOnly: true, applicationServerKey: key };
    subscription = await pushManager.getSubscription();
    const used = subscription?.options?.applicationServerKey;
    if (subscription && used !== undefined && !sameKey(used, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      try {
        subscription = await pushManager.subscribe(options);
      } catch (error) {
        // A subscription with another key that the browser didn't tell us about: replace it once.
        const old = await pushManager.getSubscription();
        if (!old) throw error;
        await old.unsubscribe();
        subscription = await pushManager.subscribe(options);
      }
    }
  } catch {
    const brave = page().navigator?.brave !== undefined;
    throw new PushError(
      "failed",
      brave
        ? "Brave couldn't switch notifications on. In Brave's settings → Privacy and security, turn on “Use Google services for push messaging”, then try again."
        : "This browser couldn't switch notifications on. Please try again in a moment.",
    );
  }
  const p256dh = subscription?.getKey("p256dh");
  const auth = subscription?.getKey("auth");
  if (!subscription || !p256dh || !auth) throw new PushError("failed", "This browser couldn't switch notifications on. Please try again in a moment.");
  return { endpoint: subscription.endpoint, keys: { p256dh: bytesToBase64Url(p256dh), auth: bytesToBase64Url(auth) } };
}

/** Switches notifications off in this browser (the server's device row is removed separately). */
export async function unsubscribe(): Promise<void> {
  const container = page().navigator?.serviceWorker;
  if (!container) return;
  try {
    const registration = await container.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // already gone
  }
}
