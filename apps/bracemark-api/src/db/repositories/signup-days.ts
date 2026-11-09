// Signup-days repository — the signup cap's figures as one row of totals per UTC
// day (migrations/sessions/0006_signup_days.sql), in SESSIONS_DB beside the
// per-network counter they are totalled from. services/signup-report.ts owns
// what goes in a row and when; this is only the table.

export type SignupDay = {
  day: number;
  cappedNetworks: number;
  busiest: number;
  capIpv4: number | null;
  capIpv6: number | null;
  enforced: boolean;
};

export function signupDaysRepo(db: D1Database) {
  return {
    // The newest day with a row, or null for an empty table.
    async latestDay(): Promise<number | null> {
      const row = await db
        .prepare(`SELECT MAX(day) AS day FROM signup_days`)
        .first<{ day: number | null }>();
      return row?.day ?? null;
    },

    // Write each day's row, replacing one already there, so a re-run of the same
    // cron writes the same rows again rather than failing or doubling. One batch:
    // the days land together or not at all.
    async write(days: SignupDay[]): Promise<void> {
      if (days.length === 0) return;
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO signup_days
           (day, capped_networks, busiest, cap_ipv4, cap_ipv6, enforced)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      await db.batch(
        days.map((d) =>
          stmt.bind(d.day, d.cappedNetworks, d.busiest, d.capIpv4, d.capIpv6, d.enforced ? 1 : 0),
        ),
      );
    },

    // Delete every day before `day`. Returns the number of rows removed.
    async purgeBefore(day: number): Promise<number> {
      const res = await db.prepare(`DELETE FROM signup_days WHERE day < ?`).bind(day).run();
      return res.meta.changes;
    },
  };
}
