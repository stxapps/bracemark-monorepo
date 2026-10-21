// Op-log repository — lives in a per-user Durable Object's SQLite
// (`ctx.storage.sql`), NOT in D1. The DO is the user's whole scope, so rows carry
// no user_id. This is the append-only log the sync engine pulls; the encrypted
// blob itself lives in R2, which is the source of truth — this log is a disposable
// accelerator, rebuildable from an R2 listing. See docs/local-first-sync.md and
// ../user-data.ts (the DO that owns this table and its in-code migrator).
//
// The client's cursor is the compound key (updated_at, path) — R2's
// `LastModified` — never `seq`. `seq` stays INTERNAL: it orders rows that share a
// millisecond and drives compaction, but it never goes over the wire (a seq is
// meaningless outside one DO's lifetime and can't be reconstructed from an R2
// listing; a timestamp always can). See "the ops/list endpoint".

export type OpKind = 'put' | 'delete';

// Public domain entity (camelCase) — one entry in the op log. `seq` is retained
// here for internal callers/tests (ordering, compaction); the wire shape drops it.
export type OpLogEntity = {
  seq: number;
  op: OpKind;
  path: string;
  updatedAt: number;
};

// The retained-range bounds the pull endpoint returns alongside the ops, so the
// client can tell incremental from fallback. Both `null` on a never-written log.
export type OpLogBounds = {
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
};

// Where the op log stood at one moment: its `generation` (bumped by every wipe)
// and its `position` (the newest seq it held). `files/sign` reads one for a
// batch of PUT tokens (../user-data.ts putGate), each token carries it into the
// upload receipt its PUT answers with (r2/upload-receipt.ts), and the commit asks
// the log whether the object could have been removed since (../user-data.ts
// commitOps, THE FENCE).
export type OpLogFence = { generation: number; position: number };

// Raw row as it sits in SQLite (snake_case columns). Internal to this repo.
type OpLogRow = {
  seq: number;
  op: OpKind;
  path: string;
  updated_at: number;
};

function toEntity(r: OpLogRow): OpLogEntity {
  return { seq: r.seq, op: r.op, path: r.path, updatedAt: r.updated_at };
}

// Bound to a SqlStorage handle (the DO's `ctx.storage.sql`). SqlStorage is
// SYNCHRONOUS — no awaits here, unlike the D1-backed master repos (users/sessions).
export function opLogsRepo(sql: SqlStorage) {
  // The log's generation: 0 until the first wipe, then one more per wipe. A wipe
  // empties the log without appending a delete, so a receipt minted before it
  // could not otherwise tell that its object was removed. One row in
  // `log_generation`, absent until the first wipe.
  const generation = (): number => {
    const row = sql
      .exec<{ generation: number }>(`SELECT generation FROM log_generation LIMIT 1`)
      .toArray()[0];
    return row ? Number(row.generation) : 0;
  };

  // The log's position: the newest seq it holds, 0 on an empty log. A primary-
  // key seek. Monotonic within a generation, because seqs only grow
  // (AUTOINCREMENT, see wipe) and compaction, when it lands, trims oldest-first
  // and keeps the newest row.
  const newestSeq = (): number => {
    const row = sql.exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM op_logs`).one();
    return row.seq ?? 0;
  };

  return {
    // Incremental pull: a KEYSET scan over the compound cursor (updated_at, path),
    // ordered the same way, capped at `limit`. `since`/`sincePath` are the client's
    // last-seen cursor; a null/absent half is the low sentinel (0 / '') so the scan
    // starts from the very beginning — the case while a seeded new account's cursor
    // is still the empty `(0, '')`. The `(=, path >)` arm
    // is what lets a single millisecond holding more than `limit` ops be paged past.
    // See docs/local-first-sync.md "Cursor precision & pagination".
    listSince(since: number | null, sincePath: string | null, limit: number): OpLogEntity[] {
      const sinceTs = since ?? 0;
      const sincePathKey = sincePath ?? '';
      const rows = sql
        .exec<OpLogRow>(
          `SELECT seq, op, path, updated_at
             FROM op_logs
            WHERE updated_at > ?
               OR (updated_at = ? AND path > ?)
            ORDER BY updated_at ASC, path ASC
            LIMIT ?`,
          sinceTs,
          sinceTs,
          sincePathKey,
          limit,
        )
        .toArray();
      return rows.map(toEntity);
    },

    // The retained range, as plain aggregates over the live rows — no high-water-
    // mark table needed (unlike a seq): compaction trims oldest-first and never
    // removes the newest row, so MAX(updated_at) is always the true newest-ever.
    // A never-written log yields { null, null }.
    //
    // TWO SCALAR SUBQUERIES, NOT `SELECT MIN(...), MAX(...)`. SQLite's min/max
    // optimization — rewriting the aggregate into a one-row seek at an end of an
    // index — only fires for a query with EXACTLY ONE aggregate. Asking for both
    // in a single SELECT disqualifies it and degrades to a full scan of
    // idx_op_logs_cursor. Split this way each subquery is its own single-aggregate
    // query and gets the seek (verified: `SCAN` becomes two `SEARCH`es; ~8.7ms ->
    // ~0.005ms at 200k rows). This is called on EVERY pull AND every commit
    // (../user-data.ts listOps/commitOps), in the DO's serialized single thread, and
    // the log grows unbounded until compaction lands — so the scan's cost is
    // per-request and rises with the user's whole history.
    bounds(): OpLogBounds {
      const row = sql
        .exec<{
          oldest: number | null;
          newest: number | null;
        }>(
          `SELECT (SELECT MIN(updated_at) FROM op_logs) AS oldest,
                  (SELECT MAX(updated_at) FROM op_logs) AS newest`,
        )
        .one();
      return { oldestUpdatedAt: row.oldest, newestUpdatedAt: row.newest };
    },

    // Delete-all-data: drop every retained row AND start a new generation, in
    // one call so neither can happen without the other. Dropping the rows is safe
    // BECAUSE the log is a disposable accelerator — a returning client's cursor
    // against the now-null bounds routes it into the R2-listing fallback (the
    // wiped-log row of the routing table), which is exactly how other devices
    // learn of the wipe. The AUTOINCREMENT high-water mark survives
    // (sqlite_sequence isn't reset), so post-wipe seqs stay strictly increasing —
    // which compaction relies on. The generation bump is what the fence needs: a
    // wipe appends no delete, so without it a receipt minted before the wipe
    // would find nothing in the emptied log to stop it.
    wipe(): void {
      const next = generation() + 1;
      sql.exec(`DELETE FROM op_logs`);
      sql.exec(`DELETE FROM log_generation`);
      sql.exec(`INSERT INTO log_generation (generation) VALUES (?)`, next);
    },

    // The log's fence right now — what a PUT token carries into its upload
    // receipt (../user-data.ts putGate) and what a receipted commit is checked
    // against (../user-data.ts staleReceiptPaths).
    fence(): OpLogFence {
      return { generation: generation(), position: newestSeq() };
    },

    // The newest `delete` of each of `paths` appended after `seq`, keyed by path:
    // what the receipt fence asks, for the paths a commit's receipted puts name
    // (../user-data.ts staleReceiptPaths). A range over the primary key, so it
    // reads only the rows appended since the oldest receipt's token was signed,
    // and needs no index on `path` (the MIGRATIONS note on why there is none
    // still holds). That range is bounded by the receipt's TTL, not by the
    // batch: another device's bulk delete inside it is tens of thousands of
    // rows. So the path filter and the MAX run here, and what comes back is one
    // row per path at most — never the range. The paths go in as ONE JSON
    // parameter unpacked by `json_each`, not a placeholder each, which a
    // MAX_COMMIT_OPS batch would put over SQLite's bound-parameter limit.
    lastDeletesAfter(seq: number, paths: string[]): Map<string, number> {
      const rows = sql
        .exec<{ path: string; seq: number }>(
          `SELECT path, MAX(seq) AS seq
             FROM op_logs
            WHERE seq > ? AND op = 'delete'
              AND path IN (SELECT value FROM json_each(?))
            GROUP BY path`,
          seq,
          JSON.stringify(paths),
        )
        .toArray();
      return new Map(rows.map((r) => [r.path, r.seq]));
    },

    // Push: record a committed mutation AFTER its blob is in R2 (R2-first, log-
    // last — a crash in between leaves an R2 object with no op, which the
    // R2-listing fallback heals; never trust the log for "does this file exist").
    // Returns the new monotonic seq (internal — the client's cursor is updatedAt).
    append(op: OpKind, path: string, updatedAt: number): number {
      const row = sql
        .exec<{ seq: number }>(
          `INSERT INTO op_logs (op, path, updated_at)
           VALUES (?, ?, ?)
           RETURNING seq`,
          op,
          path,
          updatedAt,
        )
        .one();
      return row.seq;
    },
  };
}
