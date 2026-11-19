import type { ChatImageInput } from "../../shared/types";

/**
 * Images are shrunk in the browser before sending: ~1280 px JPEG for the model, and a ~384 px preview (~20 KB)
 * that is kept with the message. The original file never leaves the device.
 */
const SIZES: [side: number, quality: number][] = [
  [1280, 0.85],
  [1280, 0.72],
  [1024, 0.7],
  [800, 0.65],
];
const THUMB_SIZES: [side: number, quality: number][] = [
  [384, 0.72],
  [320, 0.62],
  [256, 0.55],
];
/** Just under the server's limits (1,200,000 and 60,000 characters). */
const MAX_DATA_CHARS = 1_150_000;
const MAX_THUMB_CHARS = 55_000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export class ImageError extends Error {}

/** An image waiting in the message box. */
export interface PendingImage extends ChatImageInput {
  id: string;
}

function encode(bitmap: ImageBitmap, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("This browser can't prepare images.");
  ctx.fillStyle = "#ffffff"; // transparent PNGs get a white background in JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function smallest(bitmap: ImageBitmap, sizes: [number, number][], max: number): string | null {
  for (const [side, quality] of sizes) {
    const url = encode(bitmap, side, quality);
    if (url.length <= max) return url;
  }
  return null;
}

/** Resize one picked/pasted/dropped file. Throws ImageError with a message for the user. */
export async function prepareImage(file: File): Promise<ChatImageInput> {
  const name = file.name || "image";
  if (!file.type.startsWith("image/")) throw new ImageError(`"${name}" isn't an image.`);
  if (file.size > MAX_FILE_BYTES) throw new ImageError(`"${name}" is too large (over 30 MB).`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError(`"${name}" can't be opened here. Use a JPEG, PNG or WebP image.`);
  }
  try {
    const data = smallest(bitmap, SIZES, MAX_DATA_CHARS);
    const thumb = smallest(bitmap, THUMB_SIZES, MAX_THUMB_CHARS);
    if (!data || !thumb) throw new ImageError(`"${name}" is too detailed to send. Try a smaller image.`);
    return { data, thumb };
  } finally {
    bitmap.close();
  }
}

/** The image files among pasted or dropped items. */
export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}
