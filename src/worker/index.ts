import { app } from "./app";
import { cleanup } from "./db/provider-state";
import type { Env } from "./env";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env.DB));
  },
} satisfies ExportedHandler<Env>;
