/**
 * Fixed-window counter in D1. Returns whether the request is allowed and when the window resets.
 * One row write per call; fine for a personal app and well within the free 100k writes/day.
 */
export async function hitRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; resetAt: number }> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return { allowed: (row?.count ?? 1) <= limit, resetAt: windowStart + windowMs };
}
