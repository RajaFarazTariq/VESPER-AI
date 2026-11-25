/**
 * Sending a notification (v0.18.0): the payload ({ title, body, url, tag, kind }) is encrypted for each of the user's
 * browsers (push/encrypt.ts), signed with VESPER's key (push/vapid.ts) and posted to that browser's push service, which
 * delivers it when the browser is running.
 *
 * Push service answers: 2xx → delivered (failures reset); 404/410 → the subscription is gone (deleted); anything else
 * (or no answer) → one more failure, and after 5 in a row the subscription is dropped.
 *
 * Only the push services of the browsers VESPER supports are ever contacted (SSRF guard: a subscription is an address
 * the browser sends, so it is checked when saved and again before each request).
 */
import type { PushPayload } from "../../shared/types";
import { recordPushResults, type PushTarget } from "../db/notifications";
import { encryptPush, fromBase64Url } from "./encrypt";
import type { VapidKeys } from "./keys";
import { vapidAuthorization, vapidToken } from "./vapid";

/** Chrome/Opera/Android (FCM), Edge (Windows), Firefox (Mozilla) and Safari (Apple). */
const EXACT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const HOST_SUFFIXES = [".notify.windows.com", ".push.apple.com", ".push.services.mozilla.com"];
const MAX_ENDPOINT = 2_000;
/** A payload larger than this isn't sent (push services take about 4 KB; ours are far smaller). */
const MAX_PAYLOAD_BYTES = 2_048;
const TIMEOUT_MS = 8_000;
/** Dropped after this many failures in a row. */
export const MAX_FAILURES = 5;

/** The endpoint is an https address on a known push service (no port, no user name), or null. */
export function allowedPushEndpoint(endpoint: string): URL | null {
  if (endpoint.length > MAX_ENDPOINT) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length) ? url : null;
}

export interface PushOptions {
  /** How long the push service keeps it for a browser that isn't running (seconds). */
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
}

export type PushOutcome = "ok" | "gone" | "failed";

/** Posts one encrypted notification. Never throws. */
export async function sendPush(keys: VapidKeys, target: PushTarget, payload: PushPayload, options: PushOptions, now = Date.now()): Promise<PushOutcome> {
  const url = allowedPushEndpoint(target.endpoint);
  const p256dh = fromBase64Url(target.p256dh);
  const auth = fromBase64Url(target.auth);
  if (!url || !p256dh || !auth) return "gone";
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    if (plaintext.length > MAX_PAYLOAD_BYTES) return "failed";
    const body = await encryptPush(plaintext, { p256dh, auth });
    const jwt = await vapidToken(keys, url.origin, now);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        TTL: String(options.ttl),
        Urgency: options.urgency,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: vapidAuthorization(jwt, keys.publicKey),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return "ok";
    return response.status === 404 || response.status === 410 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}

/** Sends to every given browser (at the same time) and records the outcomes. */
export async function deliver(
  db: D1Database,
  keys: VapidKeys,
  targets: PushTarget[],
  payload: PushPayload,
  options: PushOptions,
  now = Date.now(),
): Promise<{ sent: number; failed: number; gone: number }> {
  if (targets.length === 0) return { sent: 0, failed: 0, gone: 0 };
  const outcomes = await Promise.all(targets.map((t) => sendPush(keys, t, payload, options, now)));
  await recordPushResults(
    db,
    targets.map((t, i) => ({ id: t.id, outcome: outcomes[i]! })),
    now,
  ).catch((error) => console.error(JSON.stringify({ msg: "push results not saved", error: String(error) })));
  const sent = outcomes.filter((o) => o === "ok").length;
  // failed includes the gone ones (removed).
  return { sent, failed: outcomes.length - sent, gone: outcomes.filter((o) => o === "gone").length };
}
