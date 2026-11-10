import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  type AdminUserDto,
  type UserDto,
  type UserRole,
  type UserSettings,
  type UserStatus,
} from "../../shared/types";
import type { AppConfig } from "../env";
import { newId } from "../lib/crypto";
import { utcDay } from "./provider-state";

export interface UserRow {
  id: string;
  /** Real GitHub id (> 0), a dev-login id, or a negative placeholder for Google-only accounts. */
  github_id: number;
  /** Set only when a GitHub account (or a local dev login) is linked. */
  github_login: string | null;
  google_sub: string | null;
  /** Verified, lower-case email from the sign-in provider. */
  email: string | null;
  login: string;
  name: string | null;
  avatar_url: string | null;
  settings: string;
  status: UserStatus;
  daily_limit: number | null;
  created_at: number;
  last_login_at: number;
}

export const USER_COLUMNS =
  "id, github_id, github_login, google_sub, email, login, name, avatar_url, settings, status, daily_limit, created_at, last_login_at";

export interface SessionUser extends UserDto {
  settings: UserSettings;
  status: UserStatus;
  dailyLimit: number | null;
}

export const settingsSchema = z.object({
  defaultModel: z.string().trim().min(1).max(200),
  fallback: z.boolean(),
  systemPrompt: z.string().max(4_000),
  ollamaEnabled: z.boolean(),
  ollamaUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => /^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i.test(v), "Must be an http(s) URL"),
  toolsEnabled: z.boolean(),
  disabledTools: z.array(z.string().trim().min(1).max(64)).max(50),
  memoryEnabled: z.boolean(),
});

/** Parse stored settings, falling back to defaults for anything missing or invalid. */
export function parseSettings(raw: string | null | undefined): UserSettings {
  let stored: unknown = {};
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_SETTINGS, ...(typeof stored === "object" && stored ? stored : {}) };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

/**
 * Admin is decided by configuration on every request (never stored), so removing a name or
 * email from ADMIN_GITHUB_USERS / ADMIN_EMAILS takes effect immediately.
 */
export function roleOf(config: AppConfig, row: Pick<UserRow, "github_login" | "email">): UserRole {
  if (row.github_login && config.adminGithubUsers.has(row.github_login.toLowerCase())) return "admin";
  if (row.email && config.adminEmails.has(row.email.toLowerCase())) return "admin";
  return "user";
}

export function toUserDto(row: UserRow, config: AppConfig): UserDto {
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, email: row.email, role: roleOf(config, row) };
}

export function toSessionUser(row: UserRow, config: AppConfig): SessionUser {
  return { ...toUserDto(row, config), settings: parseSettings(row.settings), status: row.status, dailyLimit: row.daily_limit };
}

/**
 * github_id is NOT NULL in the original schema (the table can't be rebuilt safely), so accounts
 * without GitHub get a unique negative placeholder below -2^33. Real GitHub ids are positive and
 * local dev-login ids are in [-2^32, -1], so the ranges never overlap.
 */
function placeholderGithubId(): number {
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  return -(2 ** 33 + (high! & 0xfffff) * 2 ** 32 + low!);
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

export async function findUserByGithubId(db: D1Database, githubId: number): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE github_id = ?1`).bind(githubId).first<UserRow>();
}

export async function findUserByGoogleSub(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?1`).bind(sub).first<UserRow>();
}

/** Accounts without a linked Google account whose verified email matches. */
export async function findUnlinkedByEmail(db: D1Database, email: string): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?1 AND google_sub IS NULL`)
    .bind(email)
    .all<UserRow>();
  return results;
}

/** Accounts with a GitHub login and no Google account yet. */
export async function findGithubOnlyUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE github_login IS NOT NULL AND google_sub IS NULL`)
    .all<UserRow>();
  return results;
}

/** Accounts with a Google account and no GitHub account yet. */
export async function findGoogleOnlyUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub IS NOT NULL AND github_login IS NULL`)
    .all<UserRow>();
  return results;
}

export async function createUser(
  db: D1Database,
  fields: {
    githubId?: number;
    githubLogin?: string | null;
    googleSub?: string | null;
    email?: string | null;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  },
): Promise<UserRow> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO users (id, github_id, github_login, google_sub, email, login, name, avatar_url, settings, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', ?9, ?9)
       RETURNING ${USER_COLUMNS}`,
    )
    .bind(
      newId(),
      fields.githubId ?? placeholderGithubId(),
      fields.githubLogin ?? null,
      fields.googleSub ?? null,
      fields.email ?? null,
      fields.login,
      fields.name,
      fields.avatarUrl,
      now,
    )
    .first<UserRow>();
  if (!row) throw new Error("Failed to create user");
  return row;
}

export type UserPatch = Partial<
  Pick<UserRow, "github_id" | "github_login" | "google_sub" | "email" | "login" | "name" | "avatar_url" | "status" | "daily_limit" | "last_login_at">
>;
const PATCHABLE: ReadonlySet<string> = new Set([
  "github_id",
  "github_login",
  "google_sub",
  "email",
  "login",
  "name",
  "avatar_url",
  "status",
  "daily_limit",
  "last_login_at",
]);

/** Update the given columns. Only whitelisted column names ever reach the SQL text. */
export async function updateUser(db: D1Database, id: string, patch: UserPatch): Promise<UserRow | null> {
  const entries = Object.entries(patch).filter(([k, v]) => PATCHABLE.has(k) && v !== undefined);
  if (entries.length === 0) return getUserById(db, id);
  const sets = entries.map(([k], i) => `${k} = ?${i + 2}`).join(", ");
  return db
    .prepare(`UPDATE users SET ${sets} WHERE id = ?1 RETURNING ${USER_COLUMNS}`)
    .bind(id, ...entries.map(([, v]) => v))
    .first<UserRow>();
}

export async function updateSettings(db: D1Database, userId: string, settings: UserSettings): Promise<void> {
  await db.prepare("UPDATE users SET settings = ?1 WHERE id = ?2").bind(JSON.stringify(settings), userId).run();
}

/** Deletes the account; sessions, conversations, messages, memories and usage rows cascade. */
export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM users WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- Admin listing -------------------------------------------------------------

type AdminUserRow = UserRow & { today_messages: number; conversations: number };

export function toAdminUserDto(row: UserRow & { today_messages?: number; conversations?: number }, config: AppConfig): AdminUserDto {
  return {
    ...toUserDto(row, config),
    status: row.status,
    dailyLimit: row.daily_limit,
    todayMessages: row.today_messages ?? 0,
    conversations: row.conversations ?? 0,
    github: row.github_login !== null,
    google: row.google_sub !== null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const ADMIN_LIST_SQL = `SELECT ${USER_COLUMNS.split(", ")
  .map((c) => `u.${c}`)
  .join(", ")}, COALESCE(d.messages, 0) AS today_messages,
    (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversations
  FROM users u LEFT JOIN user_usage_daily d ON d.user_id = u.id AND d.day = ?1`;

export async function listUsersForAdmin(db: D1Database, config: AppConfig): Promise<AdminUserDto[]> {
  const { results } = await db
    .prepare(`${ADMIN_LIST_SQL} ORDER BY u.last_login_at DESC LIMIT 1000`)
    .bind(utcDay())
    .all<AdminUserRow>();
  return results.map((r) => toAdminUserDto(r, config));
}

export async function getUserForAdmin(db: D1Database, config: AppConfig, id: string): Promise<AdminUserDto | null> {
  const row = await db.prepare(`${ADMIN_LIST_SQL} WHERE u.id = ?2`).bind(utcDay(), id).first<AdminUserRow>();
  return row ? toAdminUserDto(row, config) : null;
}

// --- Daily message limit -------------------------------------------------------

/**
 * Count one message against today's limit, atomically. Returns false (and counts nothing)
 * when the user has already reached `limit` today.
 */
export async function consumeDailyMessage(db: D1Database, userId: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const row = await db
    .prepare(
      `INSERT INTO user_usage_daily (user_id, day, messages) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET messages = messages + 1 WHERE messages < ?3
       RETURNING messages`,
    )
    .bind(userId, utcDay(), limit)
    .first<{ messages: number }>();
  return row !== null;
}
