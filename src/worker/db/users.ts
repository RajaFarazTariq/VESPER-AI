import { z } from "zod";
import { DEFAULT_SETTINGS, type UserDto, type UserSettings } from "../../shared/types";
import { newId } from "../lib/crypto";

interface UserRow {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  settings: string;
}

export interface SessionUser extends UserDto {
  settings: UserSettings;
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

export function toUserDto(row: Pick<UserRow, "id" | "login" | "name" | "avatar_url">): UserDto {
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

export async function upsertGithubUser(
  db: D1Database,
  profile: { githubId: number; login: string; name: string | null; avatarUrl: string | null },
): Promise<UserDto> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, settings, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?6)
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
         last_login_at = excluded.last_login_at
       RETURNING id, login, name, avatar_url`,
    )
    .bind(newId(), profile.githubId, profile.login, profile.name, profile.avatarUrl, now)
    .first<Pick<UserRow, "id" | "login" | "name" | "avatar_url">>();
  if (!row) throw new Error("Failed to upsert user");
  return toUserDto(row);
}

export async function updateSettings(db: D1Database, userId: string, settings: UserSettings): Promise<void> {
  await db.prepare("UPDATE users SET settings = ?1 WHERE id = ?2").bind(JSON.stringify(settings), userId).run();
}
