// Transfer-budget repository — how much one account MOVES in a calendar month,
// as opposed to how much it STORES (file-sizes.ts). One row in the user's DO
// SQLite, holding the month it counts and a counter per kind of call:
//
//   puts     paths signed for upload        (files/sign, op: put)
//   commits  put ops committed to the log   (ops/commit)
//
// The thresholds and the log line live in the Worker (services/transfer-budget.ts);
// this file only counts. Nothing is refused on any count yet.
//
// ⚠ TWO SEAMS, both easy to get wrong and both silent:
//
//   - DELETE-ALL-DATA MUST NOT CLEAR IT. `wipeAll` (../user-data.ts) empties the
//     op log and the size map; it leaves this table alone, on purpose. A count
//     that a wipe resets is a count that "import, wipe, repeat" resets every
//     cycle, and then it measures nothing. That is why the row is its own table
//     rather than a column on either of those.
//   - DELETING THE ACCOUNT MUST. Account deletion runs `wipeAll` and never
//     empties the DO's storage, so this row would outlive the account
//     (`clear`, called through `clearTransferBudget` by services/account.ts).
//
// The row lives only until shortly after the month it counts. The first count
// of a month sets the DO's alarm for just past that month's end, and the alarm
// drops the row if no later call has already replaced it (../user-data.ts,
// `alarm`). /privacy promises exactly that of every abuse counter — "until
// shortly after the period they count ends" — so an account that stops syncing
// mid-month must not keep its count for ever.

export type TransferCounter = 'puts' | 'commits';

// What one counted call saw: the counter before and after it, for the month it
// was counted in. `before < threshold <= after` is a crossing, which needs no
// stored "already logged" flag — a counter only rises within a month.
export type TransferCount = { period: number; before: number; after: number };

type BudgetRow = { period: number; puts: number; commits: number };

// The UTC month a timestamp falls in, as one integer (year × 12 + month), so
// "the same month" is equality and "a later month" is `>`.
export function transferPeriodOf(now: number): number {
  const date = new Date(now);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

// The first millisecond after a period: 00:00 UTC on the 1st of the next month.
export function transferPeriodEndMs(period: number): number {
  return Date.UTC(Math.floor(period / 12), (period % 12) + 1, 1);
}

// Only these two names ever reach the SQL below, from this type — never a
// caller's string — so the interpolation is not an injection path.
const COLUMN: Record<TransferCounter, 'puts' | 'commits'> = { puts: 'puts', commits: 'commits' };

export function transferBudgetRepo(sql: SqlStorage) {
  const read = (): BudgetRow | undefined =>
    sql
      .exec<BudgetRow>(`SELECT period, puts, commits FROM transfer_budget WHERE id = 1`)
      .toArray()[0];

  return {
    read,

    // Add `n` to a counter for `period`. A row from an earlier month is reset in
    // the same statement, so the call that crosses into a new month is counted
    // in the new one. `opened` is true when this call started the month's row:
    // the caller sets the alarm that will drop it.
    add(counter: TransferCounter, n: number, period: number): TransferCount & { opened: boolean } {
      const row = read();
      const current = row?.period === period;
      const before = current ? Number(row[COLUMN[counter]]) : 0;
      const after = before + n;
      // One row written, whether it opens the month or adds to it.
      sql.exec(
        `INSERT INTO transfer_budget (id, period, puts, commits) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           period = excluded.period,
           puts = excluded.puts,
           commits = excluded.commits`,
        period,
        counter === 'puts' ? after : current ? Number(row.puts) : 0,
        counter === 'commits' ? after : current ? Number(row.commits) : 0,
      );
      return { period, before, after, opened: !current };
    },

    // Take back what `add` counted for a call that was then refused for another
    // reason (a full library: lib/quota.ts). Only within the month it was added
    // to; a refund that arrives after the month turned has nothing to undo.
    refund(counter: TransferCounter, n: number, period: number): void {
      const row = read();
      if (row?.period !== period) return;
      const column = COLUMN[counter];
      sql.exec(`UPDATE transfer_budget SET ${column} = MAX(0, ${column} - ?) WHERE id = 1`, n);
    },

    // The alarm's half: drop the row once its month is over. False when there is
    // nothing to drop — the month is still running, or a later call already
    // replaced the row with the next month's.
    dropEnded(now: number): boolean {
      const row = read();
      if (!row || Number(row.period) >= transferPeriodOf(now)) return false;
      sql.exec(`DELETE FROM transfer_budget`);
      return true;
    },

    // Account deletion only — see the second seam above.
    clear(): void {
      sql.exec(`DELETE FROM transfer_budget`);
    },
  };
}
