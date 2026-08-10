// Read/write helpers over the per-account sync bookkeeping row — the expo
// sibling of web-react's data/sync-store.ts, same API and the same gate
// invariant ("firstSyncDoneAt > 0 ⇒ local store is complete up to the cursor")
// with one owner. See that file for the full semantics of each operation;
// comments here cover the port. Deliberately tiny and side-effect-light — no
// network, no React.

import { eq } from 'drizzle-orm';

import { getDb, syncMeta } from './db';

// Same shape as web-react's SyncMetaRecord (every column NOT NULL, so the
// drizzle-inferred row already matches it exactly).
export type SyncMetaRecord = typeof syncMeta.$inferSelect;

// The bookkeeping row for an account, or undefined if this device has never
// synced (nor created) it.
export async function getSyncMeta(username: string): Promise<SyncMetaRecord | undefined> {
  return getDb().select().from(syncMeta).where(eq(syncMeta.username, username)).get();
}

// Has the blocking first sync completed for this account on this device? Drives
// the initial-sync gate: true → render local data + sync in background; false →
// block on a full pull. Absent row counts as not-done.
export async function isFirstSyncDone(username: string): Promise<boolean> {
  const meta = await getSyncMeta(username);
  return !!meta && meta.firstSyncDoneAt > 0;
}

function putSyncMeta(record: SyncMetaRecord): void {
  getDb()
    .insert(syncMeta)
    .values(record)
    .onConflictDoUpdate({ target: syncMeta.username, set: record })
    .run();
}

// Account-creation path: no server data to pull (a brand-new account is empty
// by definition), so the first sync is marked done immediately with an empty
// `(0, '')` cursor — what lets create-account render instantly with no network
// round-trip (see web-react sync-store.ts). Also the delete-all-data reset.
export async function seedNewAccount(username: string): Promise<void> {
  putSyncMeta({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
  });
}

// Sign-in path: call once the initial full pull has finished (all blobs
// downloaded, decrypted, written) — only then does the flag flip, so an
// interrupted first sync stays "not done" and re-blocks (resuming, not
// restarting) on the next load.
export async function markFirstSyncDone(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  putSyncMeta({
    username,
    syncCursorUpdatedAt,
    syncCursorPath,
    firstSyncDoneAt: Date.now(),
  });
}

// Advance the compound `(updatedAt, path)` cursor after an incremental cycle.
// FORWARD-ONLY, read-and-compare in one transaction — web guards against a
// slower TAB dragging the cursor back; native has no tabs, but overlapping
// in-process cycles can still finish out of order, and the guard costs nothing
// (a regression would be harmless anyway: just a redundant re-pull). Leaves
// firstSyncDoneAt untouched.
export async function advanceCursor(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  getDb().transaction((tx) => {
    const meta = tx.select().from(syncMeta).where(eq(syncMeta.username, username)).get();
    if (!meta) return; // signed out mid-cycle — nothing to advance
    const ahead =
      syncCursorUpdatedAt > meta.syncCursorUpdatedAt ||
      (syncCursorUpdatedAt === meta.syncCursorUpdatedAt && syncCursorPath > meta.syncCursorPath);
    if (!ahead) return;
    tx.update(syncMeta)
      .set({ syncCursorUpdatedAt, syncCursorPath })
      .where(eq(syncMeta.username, username))
      .run();
  });
}

// Set the cursor to a value reconstructed straight from an R2 listing — the
// download-authoritative fallback. UNCONDITIONAL, unlike advanceCursor: the
// cursor-ahead fallback case exists precisely to LOWER a stale cursor back to
// what R2 actually holds.
export async function resetCursor(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  getDb()
    .update(syncMeta)
    .set({ syncCursorUpdatedAt, syncCursorPath })
    .where(eq(syncMeta.username, username))
    .run();
}
