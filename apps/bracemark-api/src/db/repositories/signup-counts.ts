// Signup counter repository — lives in SESSIONS_DB beside the sessions, and for
// the same reason: disposable, high-churn state (migrations/sessions/
// 0003_signup_counts.sql). One row per (network, UTC day). services/signup-cap.ts
// owns the policy; this is only the counter.

export function signupCountsRepo(db: D1Database) {
  return {
    // Count one signup for this network today, returning the new total. One
    // upsert, so two concurrent signups can't both read the same count and both
    // pass the cap.
    async increment(networkHash: string, day: number): Promise<number> {
      const row = await db
        .prepare(
          `INSERT INTO signup_counts (network_hash, day, count) VALUES (?, ?, 1)
           ON CONFLICT(network_hash, day) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(networkHash, day)
        .first<{ count: number }>();
      return row?.count ?? 1;
    },

    // Delete every day before `day`. Returns the number of rows removed.
    async purgeBefore(day: number): Promise<number> {
      const res = await db.prepare(`DELETE FROM signup_counts WHERE day < ?`).bind(day).run();
      return res.meta.changes;
    },
  };
}
