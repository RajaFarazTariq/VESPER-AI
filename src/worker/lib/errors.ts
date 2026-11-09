import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = () => new AppError(401, "unauthorized", "Please sign in.");
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);
