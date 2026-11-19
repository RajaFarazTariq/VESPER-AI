import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { getAnswerForCheck, saveVerification } from "../db/conversations";
import { D1ProviderStateStore, utcDay } from "../db/provider-state";
import { consumeDailyAnswerCheck, refundDailyAnswerCheck } from "../db/users";
import { getConfig } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { presentVerification, viewerOf } from "../lib/present";
import { getProviderModels } from "../llm/catalog";
import { getProviders } from "../llm/registry";
import { planRoute } from "../llm/router";
import { sourcesOfTools, verifyAnswer } from "../llm/verify";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";

/** A check takes one model request; give up after a minute. */
const CHECK_TIMEOUT_MS = 60_000;
const checkLimiter = rateLimit("answer_check", 6, 60_000, (c) => c.get("user").id);

/**
 * "Check this answer" (v0.11.0): rates the key claims of one of your own answers against the sources it used.
 * An answer is checked once; asking again returns the saved result (and doesn't count again).
 */
export const answerCheckRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .post("/:messageId", checkLimiter, async (c) => {
    const user = c.get("user");
    const config = getConfig(c.env);
    const settings = await getAppSettings(c.env.DB, config);
    const viewer = viewerOf(user, settings);
    if (!settings.answerCheckEnabled) throw new AppError(403, "answer_check_off", "Answer checks are switched off.");
    const answer = await getAnswerForCheck(c.env.DB, user.id, c.req.param("messageId"));
    if (!answer) throw notFound("Message");
    if (answer.role !== "assistant") throw badRequest("Only answers can be checked.");
    if (answer.verification) return c.json({ verification: presentVerification(answer.verification, viewer) });
    if (!answer.evidence) {
      throw new AppError(400, "no_sources", "This answer didn't use any sources, so there's nothing to check it against.");
    }
    if (answer.status !== "complete") throw badRequest("Only finished answers can be checked.");

    const providers = getProviders(c.env);
    const store = new D1ProviderStateStore(c.env.DB);
    const health = await store.getHealth();
    const openrouter = providers.get("openrouter");
    if (openrouter?.isConfigured() && !c.env.OPENROUTER_MODEL) await getProviderModels(c.env.DB, openrouter);
    const planned = await planRoute({ selection: "auto", providers, order: config.providerOrder, health, fallback: true });
    if (!planned.ok) throw new AppError(503, planned.error.code, planned.error.message);

    // Counted before the check runs (two clicks at once can't both slip through), given back if it fails.
    const perDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : settings.answerChecksPerDay;
    const day = utcDay();
    if (!(await consumeDailyAnswerCheck(c.env.DB, user.id, perDay))) {
      throw new AppError(
        429,
        "answer_check_limit",
        perDay <= 0
          ? "Answer checks are paused for your account."
          : `You've used all ${perDay} answer checks for today. They reset at 00:00 UTC.`,
      );
    }
    const verification = await verifyAnswer({
      appName: config.appName,
      question: answer.question,
      answer: answer.content,
      evidence: answer.evidence,
      sources: sourcesOfTools(answer.tools),
      trigger: "user",
      plan: planned.plan,
      providers,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      store,
      health,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: "answer check failed", requestId: c.get("requestId"), error: String(error) }));
      return null;
    });
    if (!verification) {
      await refundDailyAnswerCheck(c.env.DB, user.id, day);
      throw new AppError(503, "answer_check_failed", "Couldn't check the answer right now. Please try again in a minute.");
    }
    await saveVerification(c.env.DB, answer.id, verification);
    return c.json({ verification: presentVerification(verification, viewer) });
  });
