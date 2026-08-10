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
    bounds(): OpLogBounds {
      const row = sql
        .exec<{
          oldest: number | null;
          newest: number | null;
        }>(`SELECT MIN(updated_at) AS oldest, MAX(updated_at) AS newest FROM op_logs`)
        .one();
      return { oldestUpdatedAt: row.oldest, newestUpdatedAt: row.newest };
    },

    // Delete-all-data: drop every retained row. Safe BECAUSE the log is a
    // disposable accelerator — a returning client's cursor against the now-null
    // bounds routes it into the R2-listing fallback (the wiped-log row of the
    // routing table), which is exactly how other devices learn of the wipe. The
    // AUTOINCREMENT high-water mark survives (sqlite_sequence isn't reset), so
    // post-wipe seqs stay strictly increasing — which compaction relies on.
    clear(): void {
      sql.exec(`DELETE FROM op_logs`);
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
