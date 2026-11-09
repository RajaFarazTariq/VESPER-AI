import type { Context } from "hono";
import type { z } from "zod";
import { AppError, badRequest } from "./errors";

const MAX_BODY_BYTES = 256 * 1024;

/** Parse and validate a JSON body with a size cap. */
export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new AppError(413, "payload_too_large", "Request body is too large.");
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    throw badRequest("Could not read request body.");
  }
  if (raw.length > MAX_BODY_BYTES) throw new AppError(413, "payload_too_large", "Request body is too large.");
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest(issues[0] ? `${issues[0].path || "body"}: ${issues[0].message}` : "Invalid request.", issues);
  }
  return result.data;
}
