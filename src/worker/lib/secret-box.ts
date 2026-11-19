/**
 * Encryption for secrets kept in the database (GitHub access and refresh tokens, v0.12.0).
 *
 * AES-256-GCM with a key from a Cloudflare secret (base64, 32 bytes). Each value gets a fresh random IV, and the
 * owner's id is bound in as "additional data", so a sealed value copied to another user's row won't open.
 * Format: "v1.<iv>.<ciphertext>" (base64url).
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

const toB64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (text: string) => {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

/** True when the value is a usable key: base64 of exactly 32 bytes. */
export function validSecretKey(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    return fromB64(raw.trim()).length === 32;
  } catch {
    return false;
  }
}

function keyFor(raw: string): Promise<CryptoKey> {
  let key = keys.get(raw);
  if (!key) {
    key = crypto.subtle.importKey("raw", fromB64(raw.trim()), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keys.set(raw, key);
  }
  return key;
}

export async function seal(rawKey: string, plaintext: string, owner: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(owner) },
    await keyFor(rawKey),
    encoder.encode(plaintext),
  );
  return `v1.${toB64url(iv)}.${toB64url(new Uint8Array(sealed))}`;
}

/** The original text; throws if the value was changed, belongs to someone else or the key is wrong. */
export async function unseal(rawKey: string, sealed: string, owner: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Unknown sealed value");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv), additionalData: encoder.encode(owner) },
    await keyFor(rawKey),
    fromB64(data),
  );
  return decoder.decode(plain);
}
