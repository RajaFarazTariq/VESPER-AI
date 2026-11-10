/**
 * Data-safety guard for database migrations.
 *
 * For every migration, this builds a database with all EARLIER migrations, fills it with
 * user data, applies the rest, and checks that nothing was lost. A migration that drops or
 * rebuilds a table with user data (which cascades into chats, sessions and memories) fails
 * here, and because the deploy workflow runs the tests first, it never reaches production.
 *
 * Deliberately wiping data must never happen in a migration; it is a separate, explicit step.
 */
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const USER_TABLES = ["users", "sessions", "conversations", "messages", "memories"] as const;

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(name).first();
  return row !== null;
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of USER_TABLES) {
    if (!(await tableExists(table))) continue;
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    out[table] = row?.n ?? 0;
  }
  return out;
}

/** Seed using only the columns from the very first schema, which later migrations must keep. */
async function seed(): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, settings, created_at, last_login_at)
       VALUES ('u1', 101, 'first', 'First', NULL, '{"systemPrompt":"keep me"}', ?1, ?1),
              ('u2', 102, 'second', NULL, NULL, '{}', ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES ('s1', 'u1', ?1, ?2, ?1, 'test')",
    ).bind(now, now + 86_400_000),
    env.DB.prepare(
      "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES ('c1', 'u1', 'one', 'auto', ?1, ?1), ('c2', 'u2', 'two', NULL, ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'hi', ?1), ('m2', 'c1', 'assistant', 'hello', ?1), ('m3', 'c2', 'user', 'x', ?1)",
    ).bind(now),
  ]);
  if (await tableExists("memories")) {
    await env.DB.prepare("INSERT INTO memories (id, user_id, content, source, created_at) VALUES ('mem1', 'u1', 'likes tea', 'user', ?1)")
      .bind(now)
      .run();
  }
}

describe("migrations never lose user data", () => {
  const all = env.TEST_MIGRATIONS;

  for (let split = 1; split < all.length; split++) {
    it(`keeps every row when applying ${all.slice(split).map((m) => m.name).join(", ")}`, async () => {
      await reset();
      await applyD1Migrations(env.DB, all.slice(0, split));
      await seed();
      const before = await counts();

      await applyD1Migrations(env.DB, all);

      const after = await counts();
      for (const [table, n] of Object.entries(before)) expect(after[table], `rows in ${table}`).toBe(n);
      const user = await env.DB.prepare("SELECT id, login, settings FROM users WHERE id = 'u1'").first();
      expect(user).toEqual({ id: "u1", login: "first", settings: '{"systemPrompt":"keep me"}' });
      const integrity = await env.DB.prepare("PRAGMA foreign_key_check").all();
      expect(integrity.results).toEqual([]);
    });
  }

  it("has more than one migration to check", () => {
    expect(all.length).toBeGreaterThan(1);
  });
});
