// File-size repository — the durable per-path size map that backs the per-user
// quota, in the same per-user DO SQLite as the op log (../user-data.ts). Quota is
// NOT summed from the op log: the log is compactable and disposable, so it would
// undercount. This map is the authoritative `path → size`, set from the commit
// HEAD on `put` and read-and-subtracted on `delete` (a delete has no object left
// to HEAD, so the freed size must already be recorded here). See
// docs/local-first-sync.md "authorization & quota".

// Aggregate usage the `files/sign` quota check reads before minting upload URLs.
// Namespace-blind: the gate is a byte/object cost backstop and counts every path
// alike. It used to carry a `linkCount` for the free tier's saved-link cap, which
// moved to the client (lib/quota.ts has the argument).
export type FileUsage = {
  fileCount: number;
  totalBytes: number;
};

type SizeRow = { size: number };

export function fileSizesRepo(sql: SqlStorage) {
  return {
    // Record (or overwrite) a path's size — called on every committed `put` with
    // R2's reported object size. UPSERT because an in-place content update re-PUTs
    // the same path with a new size, and a crash-recovery re-commit repeats it.
    set(path: string, size: number): void {
      sql.exec(
        `INSERT INTO file_sizes (path, size) VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size`,
        path,
        size,
      );
    },

    // Drop a path on `delete` and return the bytes it freed (0 if we had no record
    // of it — a delete of something never sized, e.g. an object-without-op). The
    // freed size is read from this map, not R2, because the object is already gone.
    remove(path: string): number {
      const row = sql
        .exec<SizeRow>(`SELECT size FROM file_sizes WHERE path = ?`, path)
        .toArray()[0];
      if (!row) return 0;
      sql.exec(`DELETE FROM file_sizes WHERE path = ?`, path);
      return row.size;
    },

    // Delete-all-data: drop every recorded size, resetting usage to zero. Runs in
    // the same DO wipe as the op-log clear (user-data.ts wipeAll) — the R2 objects
    // the sizes described are deleted right after, so zero is where the map lands
    // anyway once the namespace is empty.
    clear(): void {
      sql.exec(`DELETE FROM file_sizes`);
    },

    // Current file count + byte total for this user, the quota the `put` sign
    // check compares against (once per files/sign put batch, in the user's local
    // DO SQLite). COALESCE so an empty map reports 0, not null. A full aggregate
    // scan — COUNT(*)/SUM(size) visit every row — which is fine at current scale:
    // the map is per-user and small, and the scan is local + sub-ms. If a single
    // user's map ever grows large (~100k+ rows) or this shows in DO CPU time,
    // switch to a maintained running total (a one-row usage table incremented in
    // commitOps) so this becomes an O(1) read; now that the namespace term is
    // gone, that total is two plain counters. Deferred to avoid standing derived
    // state that can drift on re-commit.
    usage(): FileUsage {
      const row = sql
        .exec<{
          count: number;
          total: number;
        }>(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM file_sizes`)
        .one();
      return { fileCount: row.count, totalBytes: row.total };
    },
  };
}
