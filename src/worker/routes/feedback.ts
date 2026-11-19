import { Hono } from "hono";
import { z } from "zod";
import { FEEDBACK_REASONS, type FeedbackReason } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { deleteFeedback, findOwnAnswer, saveFeedback } from "../db/feedback";
import { badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";

const feedbackSchema = z.object({
  /** 1 = 👍, -1 = 👎, 0 = take the rating back. */
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  reason: z.enum(FEEDBACK_REASONS as [FeedbackReason, ...FeedbackReason[]]).nullable().optional(),
  note: z.string().max(1_000, "Notes are limited to 1,000 characters.").nullable().optional(),
});

const feedbackLimiter = rateLimit("feedback", 60, 60_000, (c) => c.get("user").id);

/** 👍/👎 on the user's own answers. */
export const feedbackRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .put("/:messageId", feedbackLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, feedbackSchema);
    const answer = await findOwnAnswer(c.env.DB, user.id, c.req.param("messageId"));
    if (!answer) throw notFound("Message");
    if (answer.role !== "assistant") throw badRequest("Only answers can be rated.");
    if (body.rating === 0) {
      await deleteFeedback(c.env.DB, user.id, answer.id);
      return c.json({ feedback: null });
    }
    const feedback = await saveFeedback(c.env.DB, user.id, answer, {
      rating: body.rating,
      reason: body.reason ?? null,
      note: body.note ?? null,
    });
    return c.json({ feedback });
  });
