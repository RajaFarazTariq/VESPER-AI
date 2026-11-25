/**
 * Web Push message encryption (v0.18.0): RFC 8291 with the "aes128gcm" content coding of RFC 8188, using WebCrypto
 * only. The browser gave VESPER its P-256 public key (p256dh) and a 16-byte secret (auth) when it subscribed; only that
 * browser can read what is encrypted here, so the push service in the middle sees nothing but the size.
 *
 * Per message: a new ECDH key pair and a random salt → shared secret → (with auth) the input keying material → the
 * content key and nonce (HKDF-SHA-256) → one AES-128-GCM record. The body is the 86-byte header (salt, record size,
 * the key pair's public key) followed by the encrypted record.
 */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes from base64url (or plain base64); null when it isn't valid. */
export function fromBase64Url(text: string): Uint8Array | null {
  const clean = text.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null;
  try {
    return Uint8Array.from(atob(clean + "=".repeat((4 - (clean.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The application server's ECDH key pair for one message (tests pass the RFC's fixed one). */
export interface SenderKeys {
  privateKey: CryptoKey;
  /** Uncompressed P-256 point (65 bytes). */
  publicKey: Uint8Array;
}

export async function newSenderKeys(): Promise<SenderKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
}

/** A browser's subscription keys are usable: a P-256 public key (65 bytes, uncompressed) and a 16-byte secret. */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  const key = fromBase64Url(p256dh);
  const secret = fromBase64Url(auth);
  return key?.length === 65 && key[0] === 4 && secret?.length === 16;
}

/**
 * Encrypts one push message for a subscription (RFC 8291 §3.4; a single record, so the plaintext must stay well under
 * the record size). `salt` and `sender` are only given by tests; normally both are new for every message.
 */
export async function encryptPush(
  plaintext: Uint8Array,
  subscription: { p256dh: Uint8Array; auth: Uint8Array },
  options: { salt?: Uint8Array; sender?: SenderKeys; recordSize?: number } = {},
): Promise<Uint8Array> {
  const recordSize = options.recordSize ?? 4096;
  if (plaintext.length + 17 > recordSize) throw new Error("Push message too long for one record.");
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const sender = options.sender ?? (await newSenderKeys());
  const receiver = await crypto.subtle.importKey("raw", subscription.p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // (The Workers types call the ECDH `public` member `$public`; the runtime takes the standard name.)
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiver } as SubtleCryptoDeriveKeyAlgorithm, sender.privateKey, 256));
  // IKM = HKDF(auth, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(encoder.encode("WebPush: info\0"), subscription.p256dh, sender.publicKey);
  const ikm = await hkdf(subscription.auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The last (only) record ends with the padding delimiter 0x02.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, Uint8Array.of(2))));
  // Header: salt (16) | record size (uint32, big-endian) | key id length (1) | key id (the sender's public key).
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = sender.publicKey.length;
  return concat(header, sender.publicKey, record);
}
