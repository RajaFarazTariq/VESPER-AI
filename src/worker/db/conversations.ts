import type { ConversationDto, MessageDto, MessageRole, MessageStatus } from "../../shared/types";
import { newId } from "../lib/crypto";

interface ConversationRow {
  id: string;
  title: string;
  model: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  provider: string | null;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  created_at: number;
}

const toConversation = (r: ConversationRow): ConversationDto => ({
  id: r.id,
  title: r.title,
  model: r.model,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): MessageDto => ({
  id: r.id,
  role: r.role,
  content: r.content,
  reasoning: r.reasoning,
  provider: r.provider,
  model: r.model,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

/** Derive a short sidebar title from the first user message. */
export function deriveTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New chat";
  if (collapsed.length <= 60) return collapsed;
  const cut = collapsed.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export async function listConversations(
  db: D1Database,
  userId: string,
  limit: number,
  before?: number,
): Promise<ConversationDto[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, model, created_at, updated_at FROM conversations
       WHERE user_id = ?1 AND updated_at < ?2
       ORDER BY updated_at DESC LIMIT ?3`,
    )
    .bind(userId, before ?? Number.MAX_SAFE_INTEGER, limit)
    .all<ConversationRow>();
  return results.map(toConversation);
}

export async function getConversation(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ConversationDto | null> {
  const row = await db
    .prepare("SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .first<ConversationRow>();
  return row ? toConversation(row) : null;
}

export async function createConversation(
  db: D1Database,
  userId: string,
  title: string,
  model: string | null,
): Promise<ConversationDto> {
  const now = Date.now();
  const conversation: ConversationDto = { id: newId(), title, model, createdAt: now, updatedAt: now };
  await db
    .prepare(
      "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(conversation.id, userId, title, model, now)
    .run();
  return conversation;
}

export async function updateConversation(
  db: D1Database,
  userId: string,
  id: string,
  patch: { title?: string; model?: string | null; touch?: boolean },
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    values.push(patch.title);
    sets.push(`title = ?${values.length}`);
  }
  if (patch.model !== undefined) {
    values.push(patch.model);
    sets.push(`model = ?${values.length}`);
  }
  if (patch.touch) {
    values.push(Date.now());
    sets.push(`updated_at = ?${values.length}`);
  }
  if (sets.length === 0) return true;
  values.push(id, userId);
  const result = await db
    .prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?${values.length - 1} AND user_id = ?${values.length}`)
    .bind(...values)
    .run();
  return result.meta.changes > 0;
}

export async function deleteConversation(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM conversations WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes > 0;
}

/** Messages in chronological order. `limit` keeps only the newest N. */
export async function listMessages(db: D1Database, conversationId: string, limit = 500): Promise<MessageDto[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT id, role, content, reasoning, provider, model, status, error, created_at, rowid AS rid
         FROM messages WHERE conversation_id = ?1
         ORDER BY created_at DESC, rid DESC LIMIT ?2
       ) ORDER BY created_at ASC, rid ASC`,
    )
    .bind(conversationId, limit)
    .all<MessageRow>();
  return results.map(toMessage);
}

export interface NewMessage {
  role: MessageRole;
  content: string;
  reasoning?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: MessageStatus;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Ensures the message sorts after an earlier one created in the same millisecond. */
  notBefore?: number;
}

export async function insertMessage(db: D1Database, conversationId: string, m: NewMessage): Promise<MessageDto> {
  const createdAt = Math.max(Date.now(), (m.notBefore ?? 0) + 1);
  const message: MessageDto = {
    id: newId(),
    role: m.role,
    content: m.content,
    reasoning: m.reasoning || null,
    provider: m.provider ?? null,
    model: m.model ?? null,
    status: m.status ?? "complete",
    error: m.error ?? null,
    createdAt,
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, reasoning, provider, model, status, error,
                               tokens_in, tokens_out, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.reasoning,
        message.provider,
        message.model,
        message.status,
        message.error,
        m.tokensIn ?? null,
        m.tokensOut ?? null,
        createdAt,
      ),
    db.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2").bind(createdAt, conversationId),
  ]);
  return message;
}

/** Remove assistant messages after the last user message (used by "regenerate"). */
export async function deleteTrailingAssistantMessages(db: D1Database, conversationId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM messages WHERE conversation_id = ?1 AND role = 'assistant' AND created_at >= COALESCE(
         (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?1 AND role = 'user'), 0)`,
    )
    .bind(conversationId)
    .run();
}
