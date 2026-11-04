// Signup counter repository — lives in SESSIONS_DB beside the sessions, and for
// the same reason: disposable, high-churn state (migrations/sessions/
// 0003_signup_counts.sql). One row per (network, UTC day). services/signup-cap.ts
// owns the policy; this is only the counter.

export function signupCountsRepo(db: D1Database) {
  return {
    // Count one signup for this network today, returning the new total. One
    // upsert, so two concurrent signups can't both read the same count and both
    // pass the cap. The row keeps the cap it was counted against (0005), since
    // the hash can't say which family's cap that was: countOverCap below reads it.
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

    // How many networks went past their cap on `day`, each judged by the cap it
    // was counted against. A row from before 0005 has no cap and isn't counted.
    async countOverCap(day: number): Promise<number> {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM signup_counts WHERE day = ? AND count > cap`)
        .bind(day)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    // The most signups any one network made on `day`, refused ones included; 0
    // for a day with none. The report's measure of how a cap would land.
    async busiest(day: number): Promise<number> {
      const row = await db
        .prepare(`SELECT COALESCE(MAX(count), 0) AS n FROM signup_counts WHERE day = ?`)
        .bind(day)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    // Delete every day before `day`. Returns the number of rows removed.
    async purgeBefore(day: number): Promise<number> {
      const res = await db.prepare(`DELETE FROM signup_counts WHERE day < ?`).bind(day).run();
      return res.meta.changes;
    },
  };
}
