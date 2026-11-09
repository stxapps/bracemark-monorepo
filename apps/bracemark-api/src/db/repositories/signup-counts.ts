// Signup counter repository — lives in SESSIONS_DB beside the sessions, and for
// the same reason: disposable, high-churn state (migrations/sessions/
// 0003_signup_counts.sql). One row per (network, UTC day). services/signup-cap.ts
// owns the policy; this is only the counter.

export type SignupDayTotals = { day: number; cappedNetworks: number; busiest: number };

export function signupCountsRepo(db: D1Database) {
  return {
    // Count one signup for this network today, returning the new total. One
    // upsert, so two concurrent signups can't both read the same count and both
    // pass the cap. The row keeps the cap it was counted against (0005), since
    // the hash can't say which family's cap that was: totalsByDay below reads it.
    async increment(networkHash: string, day: number, cap: number): Promise<number> {
      const row = await db
        .prepare(
          `INSERT INTO signup_counts (network_hash, day, count, cap) VALUES (?, ?, 1, ?)
           ON CONFLICT(network_hash, day) DO UPDATE SET count = count + 1, cap = excluded.cap
           RETURNING count`,
        )
        .bind(networkHash, day, cap)
        .first<{ count: number }>();
      return row?.count ?? 1;
    },

    // Each day in [from, to] that has rows: how many networks went past the cap
    // they were counted against, and the most signups any one network made
    // (refused ones included). A row from before 0005 has no cap and counts as
    // not past it. Days without rows are absent; the caller fills them in.
    async totalsByDay(from: number, to: number): Promise<SignupDayTotals[]> {
      const { results } = await db
        .prepare(
          `SELECT day,
                  COALESCE(SUM(count > cap), 0) AS cappedNetworks,
                  MAX(count) AS busiest
           FROM signup_counts WHERE day BETWEEN ? AND ? GROUP BY day`,
        )
        .bind(from, to)
        .all<SignupDayTotals>();
      return results;
    },

    // Delete every day before `day`. Returns the number of rows removed.
    async purgeBefore(day: number): Promise<number> {
      const res = await db.prepare(`DELETE FROM signup_counts WHERE day < ?`).bind(day).run();
      return res.meta.changes;
    },
  };
}
