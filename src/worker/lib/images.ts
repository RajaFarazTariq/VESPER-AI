import { z } from "zod";

/** Images per chat message. */
export const MAX_IMAGES_PER_MESSAGE = 3;
/** One resized image as a data URL (~900 KB of JPEG). The browser shrinks photos to ~1280 px well below this. */
export const MAX_IMAGE_CHARS = 1_200_000;
/** One stored preview (~45 KB of JPEG; the browser aims for ~20 KB). */
export const MAX_THUMB_CHARS = 60_000;
/** Body limit for POST /api/chat: room for 3 images plus the text (other routes keep 256 KB). */
export const CHAT_BODY_LIMIT = 4 * 1024 * 1024;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The first bytes must really be a JPEG, PNG or WebP file, matching the declared type. */
function signatureMatches(type: string, base64: string): boolean {
  let head: string;
  try {
    head = atob(base64.slice(0, 24)); // 18 bytes
  } catch {
    return false;
  }
  const byte = (i: number) => head.charCodeAt(i);
  if (type === "jpeg") return byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
  if (type === "png") return head.startsWith("\x89PNG\r\n\x1a\n");
  return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
}

/** A base64 JPEG/PNG/WebP data URL whose content really is that kind of image. */
export function isImageDataUrl(value: string): boolean {
  const match = DATA_URL.exec(value);
  if (!match) return false;
  const base64 = match[2]!;
  return base64.length % 4 === 0 && base64.length >= 24 && signatureMatches(match[1]!, base64);
}

const imageDataUrl = (max: number) =>
  z
    .string()
    .max(max, "Image is too large.")
    .refine(isImageDataUrl, "Must be a JPEG, PNG or WebP image.");

export const chatImageSchema = z.object({
  data: imageDataUrl(MAX_IMAGE_CHARS),
  thumb: imageDataUrl(MAX_THUMB_CHARS),
});
