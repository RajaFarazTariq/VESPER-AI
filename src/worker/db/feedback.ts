import type {
  FeedbackItemDto,
  FeedbackReason,
  FeedbackSummaryDto,
  MessageFeedbackDto,
  SourceDto,
  ToolEventDto,
} from "../../shared/types";

/** Copies kept with each rating are capped so one row stays small. */
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 20_000;
const MAX_SOURCES = 15;

interface AnswerRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  provider: string | null;
  model: string | null;
  tools: string | null;
  created_at: number;
}

/** An answer in one of this user's conversations, or null (not found, not theirs). */
export async function findOwnAnswer(db: D1Database, userId: string, messageId: string): Promise<AnswerRow | null> {
  return db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.provider, m.model, m.tools, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?1 AND c.user_id = ?2`,
    )
    .bind(messageId, userId)
    .first<AnswerRow>();
}

/** Every source the answer's tools returned (web links and document pages), without duplicates. */
function sourcesOf(rawTools: string | null): SourceDto[] {
  let tools: ToolEventDto[] = [];
  try {
    tools = rawTools ? (JSON.parse(rawTools) as ToolEventDto[]) : [];
  } catch {
    tools = [];
  }
  const seen = new Set<string>();
  const out: SourceDto[] = [];
  for (const source of tools.flatMap((t) => t.sources ?? [])) {
    const key = source.url ?? `${source.title}|${source.location ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** The question the answer replied to: the last user message before it. */
async function questionFor(db: D1Database, answer: AnswerRow): Promise<string> {
  const row = await db
    .prepare(
      `SELECT content, images FROM messages
       WHERE conversation_id = ?1 AND role = 'user' AND created_at <= ?2
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(answer.conversation_id, answer.created_at)
    .first<{ content: string; images: string | null }>();
  if (!row) return "";
  let images = 0;
  try {
    images = row.images ? (JSON.parse(row.images) as unknown[]).length : 0;
  } catch {
    images = 0;
  }
  const note = images > 0 ? `[${images} image${images === 1 ? "" : "s"} attached]` : "";
  return [row.content.trim(), note].filter(Boolean).join(" ").slice(0, MAX_QUESTION_CHARS);
}

/** Save (or change) the user's rating, keeping a copy of the question, answer, model and sources. */
export async function saveFeedback(
  db: D1Database,
  userId: string,
  answer: AnswerRow,
  input: { rating: 1 | -1; reason: FeedbackReason | null; note: string | null },
): Promise<MessageFeedbackDto> {
  const now = Date.now();
  // Reasons and notes belong to 👎; a 👍 clears them.
  const reason = input.rating === -1 ? input.reason : null;
  const note = input.rating === -1 ? input.note?.trim() || null : null;
  await db
    .prepare(
      `INSERT INTO message_feedback (message_id, conversation_id, user_id, rating, reason, note, question, answer, provider, model,
                                     sources, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(message_id) DO UPDATE SET rating = excluded.rating, reason = excluded.reason, note = excluded.note,
         updated_at = excluded.updated_at`,
    )
    .bind(
      answer.id,
      answer.conversation_id,
      userId,
      input.rating,
      reason,
      note,
      await questionFor(db, answer),
      answer.content.slice(0, MAX_ANSWER_CHARS),
      answer.provider,
      answer.model,
      JSON.stringify(sourcesOf(answer.tools)),
      now,
    )
    .run();
  return { rating: input.rating, reason, note };
}

export async function deleteFeedback(db: D1Database, userId: string, messageId: string): Promise<void> {
  await db.prepare("DELETE FROM message_feedback WHERE message_id = ?1 AND user_id = ?2").bind(messageId, userId).run();
}

interface FeedbackRow {
  message_id: string;
  rating: 1 | -1;
  reason: string | null;
  note: string | null;
  question: string;
  answer: string;
  provider: string | null;
  model: string | null;
  sources: string | null;
  created_at: number;
  updated_at: number;
  login: string;
  name: string | null;
}

function parseSources(raw: string | null): SourceDto[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as SourceDto[]) : [];
  } catch {
    return [];
  }
}

/** Newest first; `before` (an updated_at value) pages back. */
export async function listFeedback(
  db: D1Database,
  options: { rating?: 1 | -1; limit: number; before?: number },
): Promise<FeedbackItemDto[]> {
  const { results } = await db
    .prepare(
      `SELECT f.message_id, f.rating, f.reason, f.note, f.question, f.answer, f.provider, f.model, f.sources,
              f.created_at, f.updated_at, u.login, u.name
       FROM message_feedback f JOIN users u ON u.id = f.user_id
       WHERE (?1 IS NULL OR f.rating = ?1) AND f.updated_at < ?2
       ORDER BY f.updated_at DESC LIMIT ?3`,
    )
    .bind(options.rating ?? null, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    .all<FeedbackRow>();
  return results.map((r) => ({
    messageId: r.message_id,
    rating: r.rating,
    reason: (r.reason as FeedbackReason | null) ?? null,
    note: r.note,
    user: { login: r.login, name: r.name },
    question: r.question,
    answer: r.answer,
    provider: r.provider,
    model: r.model,
    sources: parseSources(r.sources),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function feedbackSummary(db: D1Database): Promise<FeedbackSummaryDto> {
  const [totals, perModel] = await db.batch<{ provider?: string | null; model?: string | null; up: number | null; down: number | null }>([
    db.prepare("SELECT SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM message_feedback"),
    db.prepare(
      `SELECT provider, model, SUM(rating = 1) AS up, SUM(rating = -1) AS down
       FROM message_feedback GROUP BY provider, model ORDER BY COUNT(*) DESC LIMIT 50`,
    ),
  ]);
  const total = totals?.results[0];
  return {
    up: total?.up ?? 0,
    down: total?.down ?? 0,
    byModel: (perModel?.results ?? []).map((r) => ({ provider: r.provider ?? null, model: r.model ?? null, up: r.up ?? 0, down: r.down ?? 0 })),
  };
}
