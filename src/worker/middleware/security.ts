import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env";
import { hitRateLimit } from "../db/rate-limit";
import { AppError } from "../lib/errors";

/** Request id, structured access log and safe default headers for every API response. */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  const started = Date.now();
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Request-Id", requestId);
  console.log(
    JSON.stringify({
      msg: "request",
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - started,
    }),
  );
};

/**
 * CSRF protection for cookie-authenticated requests: state-changing requests must
 * come from our own origin and carry JSON. Browsers always send Origin on such requests.
 */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  const expected = new URL(c.req.url).origin;
  if (origin && origin !== expected) throw new AppError(403, "forbidden_origin", "Cross-origin request blocked.");
  const fetchSite = c.req.header("sec-fetch-site");
  if (!origin && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new AppError(403, "forbidden_origin", "Cross-site request blocked.");
  }
  const type = c.req.header("content-type") ?? "";
  const hasBody = method !== "DELETE";
  if (hasBody && !type.toLowerCase().startsWith("application/json")) {
    throw new AppError(415, "unsupported_media_type", "Requests must use Content-Type: application/json.");
  }
  return next();
};

export const clientIp = (headers: { header(name: string): string | undefined }) =>
  headers.header("cf-connecting-ip") ?? headers.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

/** Fixed-window rate limit keyed by a function of the request. */
export function rateLimit(
  prefix: string,
  limit: number | ((c: Parameters<MiddlewareHandler<AppEnv>>[0]) => number),
  windowMs: number,
  key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const max = typeof limit === "function" ? limit(c) : limit;
    const { allowed, resetAt } = await hitRateLimit(c.env.DB, `${prefix}:${key(c)}`, max, windowMs);
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      c.header("Retry-After", String(retryAfter));
      throw new AppError(429, "rate_limited", `Too many requests. Try again in ${retryAfter}s.`);
    }
    return next();
  };
}
