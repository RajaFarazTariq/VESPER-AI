/**
 * VESPER's VAPID key pair (v0.18.0): ECDSA P-256, made automatically the first time it is needed and kept in D1
 * (push_keys, one row), so there is no setup step. Browsers subscribe with the public key; every notification is signed
 * with the private key (push/vapid.ts), and push services refuse notifications signed with any other key.
 *
 * Trade-off (owner approved): someone with access to the database could sign notifications for the stored
 * subscriptions. The subscription addresses are in the same database anyway, and notifications only reach the
 * browsers that subscribed. Replacing the key would stop every existing subscription, so it is never rotated here.
 */
import { toBase64Url } from "./encrypt";

export interface VapidKeys {
  /** The public key as browsers need it: base64url of the uncompressed P-256 point. */
  publicKey: string;
  privateKey: CryptoKey;
  /** The app's origin, sent as the contact ("sub") with each notification. */
  subject: string | null;
}

const KEY_ID = "vapid";
let cached: (VapidKeys & { jwk: string }) | null = null;

/** Uncompressed point 0x04 | x | y from a public JWK. */
function rawPublicKey(jwk: JsonWebKey): string {
  const part = (v: string | undefined) => Uint8Array.from(atob((v ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const x = part(jwk.x);
  const y = part(jwk.y);
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(x, 1 + 32 - x.length);
  point.set(y, 33 + 32 - y.length);
  return toBase64Url(point);
}

/**
 * The key pair (created on first use; two requests creating it at once keep whichever was stored first). With
 * `origin` (from a request), the stored contact is updated when it changed.
 */
export async function vapidKeys(db: D1Database, origin?: string): Promise<VapidKeys> {
  let row = await db
    .prepare("SELECT public_jwk, private_jwk, subject FROM push_keys WHERE id = ?1")
    .bind(KEY_ID)
    .first<{ public_jwk: string; private_jwk: string; subject: string | null }>();
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
    const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    await db
      .prepare("INSERT OR IGNORE INTO push_keys (id, public_jwk, private_jwk, subject, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(KEY_ID, publicJwk, privateJwk, origin ?? null, Date.now())
      .run();
    row = await db
      .prepare("SELECT public_jwk, private_jwk, subject FROM push_keys WHERE id = ?1")
      .bind(KEY_ID)
      .first<{ public_jwk: string; private_jwk: string; subject: string | null }>();
    if (!row) throw new Error("VAPID keys could not be stored.");
  }
  if (origin && row.subject !== origin) {
    await db.prepare("UPDATE push_keys SET subject = ?2 WHERE id = ?1").bind(KEY_ID, origin).run();
    row = { ...row, subject: origin };
  }
  if (cached?.jwk !== row.private_jwk) {
    const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(row.private_jwk) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    cached = { jwk: row.private_jwk, publicKey: rawPublicKey(JSON.parse(row.public_jwk) as JsonWebKey), privateKey, subject: row.subject };
  }
  return { publicKey: cached.publicKey, privateKey: cached.privateKey, subject: row.subject };
}
