import { app } from "./app";
import { cleanup } from "./db/provider-state";
import type { Env } from "./env";
import { runProactive } from "./jobs/proactive";

/** The daily housekeeping trigger in wrangler.jsonc; every other trigger is the every-minute run (v0.18.0). */
const DAILY_CRON = "17 3 * * *";

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === DAILY_CRON) ctx.waitUntil(cleanup(env.DB));
    // Reminders, meeting alerts and daily briefings (jobs/proactive.ts), as of the minute the run was scheduled for.
    else ctx.waitUntil(runProactive(env, controller.scheduledTime).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
