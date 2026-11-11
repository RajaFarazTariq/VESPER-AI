/** The Hono application: every /api route. Kept separate from index.ts because a Worker's
 * entry module may only export handlers. */
import { Hono } from "hono";
import type { AppEnv } from "./app-env";
import { AppError } from "./lib/errors";
import { requestContext, sameOriginGuard } from "./middleware/security";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { conversationRoutes } from "./routes/conversations";
import { memoryRoutes, toolRoutes } from "./routes/memories";
import { modelRoutes } from "./routes/models";
import { settingsRoutes } from "./routes/settings";
import { VERSION } from "./version";

export { VERSION };

export const app = new Hono<AppEnv>();

app.use("/api/*", requestContext, sameOriginGuard);

app.get("/api/health", async (c) => {
  let database = "ok";
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    database = "unavailable";
  }
  return c.json({ ok: database === "ok", version: VERSION, database }, database === "ok" ? 200 : 503);
});

app.route("/api/auth", authRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/models", modelRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/memories", memoryRoutes);
app.route("/api/tools", toolRoutes);
app.route("/api/admin", adminRoutes);

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: { code: "not_found", message: "Endpoint not found." } }, 404);
  }
  // Everything else is the single-page app (normally served before the Worker even runs).
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404);
});

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  const requestId = c.get("requestId");
  console.error(JSON.stringify({ msg: "unhandled error", requestId, error: String(error), stack: (error as Error).stack }));
  return c.json(
    { error: { code: "internal", message: `Unexpected server error. Reference: ${requestId ?? "n/a"}` } },
    500,
  );
});
