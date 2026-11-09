// Transfer-days repository — daily totals of accounts passing a step of the
// monthly transfer count (migrations/sessions/0007_transfer_days.sql), in
// SESSIONS_DB. services/transfer-budget.ts decides which steps a call passed;
// this only adds them up. Nothing here names an account.

export type TransferStepPassed = { step: number; budget: boolean };

export function transferDaysRepo(db: D1Database) {
  return {
    // One account passed each of `steps` on `day`: add one to each step's total.
    // One batch, so a call's steps land together. A step that is the plan's
    // threshold on any call that day stays marked as one (MAX).
    async addPassed(
      day: number,
      counter: string,
      plan: string,
      steps: TransferStepPassed[],
    ): Promise<void> {
      if (steps.length === 0) return;
      const stmt = db.prepare(
        `INSERT INTO transfer_days (day, counter, plan, step, budget, accounts)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(day, counter, plan, step) DO UPDATE SET
           accounts = accounts + 1,
           budget = MAX(budget, excluded.budget)`,
      );
      await db.batch(steps.map((s) => stmt.bind(day, counter, plan, s.step, s.budget ? 1 : 0)));
    },

    // Delete every day before `day`. Returns the number of rows removed.
    async purgeBefore(day: number): Promise<number> {
      const res = await db.prepare(`DELETE FROM transfer_days WHERE day < ?`).bind(day).run();
      return res.meta.changes;
    },
  };
}
