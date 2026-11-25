/**
 * VAPID (RFC 8292, v0.18.0): each notification carries a short signed token (an ES256 JWT) that proves it comes from
 * VESPER's key. aud = the push service's origin, exp = at most 24 hours ahead, sub = the app's origin (contact).
 * Tokens are kept in memory per push service for about 12 hours, so a run signs at most one per service.
 */
import { toBase64Url } from "./encrypt";
import type { VapidKeys } from "./keys";

const encoder = new TextEncoder();
const b64 = (text: string) => toBase64Url(encoder.encode(text));
/** A token is valid for 23 hours (under the 24-hour maximum even with some clock difference) and reused for 12. */
const VALID_MS = 23 * 60 * 60_000;
const REUSE_MS = 12 * 60 * 60_000;

/** A signed ES256 token for these claims. WebCrypto's ECDSA signature is already JWS's r | s form. */
export async function signVapidJwt(privateKey: CryptoKey, claims: { aud: string; exp: number; sub: string }): Promise<string> {
  const unsigned = `${b64(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(unsigned)));
  return `${unsigned}.${toBase64Url(signature)}`;
}

const tokens = new Map<string, { jwt: string; until: number }>();

/** The token for one push service (origin), reused while it has more than 11 hours left. */
export async function vapidToken(keys: VapidKeys, audience: string, now = Date.now()): Promise<string> {
  const sub = keys.subject ?? "https://localhost";
  const cacheKey = `${keys.publicKey}|${audience}|${sub}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > now) return hit.jwt;
  const jwt = await signVapidJwt(keys.privateKey, { aud: audience, exp: Math.floor((now + VALID_MS) / 1000), sub });
  if (tokens.size > 50) tokens.clear();
  tokens.set(cacheKey, { jwt, until: now + REUSE_MS });
  return jwt;
}

/** The Authorization header for a push request. */
export const vapidAuthorization = (jwt: string, publicKey: string) => `vapid t=${jwt}, k=${publicKey}`;
