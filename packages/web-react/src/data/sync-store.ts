'use client';

// Read/write helpers over the per-account sync bookkeeping row (see db.ts). This
// is the seam the SyncProvider and the sync engine both go through, so the gate
// invariant ("firstSyncDoneAt > 0 ⇒ local store is complete up to the cursor")
// has one owner. Deliberately tiny and side-effect-light — no network, no React.

import { db, type SyncMetaRecord } from './db';

// The bookkeeping row for an account, or undefined if this device has never
// synced (nor created) it.
export function getSyncMeta(username: string): Promise<SyncMetaRecord | undefined> {
  return db.syncMeta.get(username);
}

// Has the blocking first sync completed for this account on this device? Drives
// InitialSyncGate: true → render local data + sync in background; false → block on a
// full pull. Absent row counts as not-done.
export async function isFirstSyncDone(username: string): Promise<boolean> {
  const meta = await getSyncMeta(username);
  return !!meta && meta.firstSyncDoneAt > 0;
}

// Account-creation path: there is NO server data to pull (a brand-new account is
// empty by definition), so we mark the first sync done immediately with an empty
// cursor. This is what lets create-account render the app instantly with no
// network round-trip — the create-account hook calls this alongside setSession.
// Encoding "new account" as a persisted flag here (rather than threading a
// create-vs-sign-in boolean through React) keeps SyncProvider's logic uniform.
// The cursor starts empty — `(0, '')` — since there's nothing pulled yet.
export function seedNewAccount(username: string): Promise<string> {
  return db.syncMeta.put({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
  });
}

// Sign-in path: call once the initial full pull has finished (all blobs
// downloaded, decrypted, written). Atomic on purpose — only flip the flag after
// the snapshot is complete, so an interrupted first sync stays "not done" and
// re-blocks on the next load rather than leaving a partial store looking
// finished (the re-run resumes rather than restarts: the engine skips records
// already stored at the listed `updatedAt`). The first cursor is the newest
// compound `(updatedAt, path)` among the listed files — the same reconstruction
// the fallback cycle does from a full listing.
export function markFirstSyncDone(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<string> {
  return db.syncMeta.put({
    username,
    syncCursorUpdatedAt,
    syncCursorPath,
    firstSyncDoneAt: Date.now(),
  });
}

// Advance the compound `(updatedAt, path)` cursor after an incremental cycle —
// to the newest op's `(updatedAt, path)` seen. Both halves move together: a later
// millisecond resets the path tiebreak. FORWARD-ONLY, read-and-compare in one
// transaction: IndexedDB is shared across tabs, so a slower tab's cycle finishing
// late must not drag the cursor back below what a faster one already consumed
// (regression is harmless — just a redundant re-pull — but free to prevent).
// Leaves firstSyncDoneAt untouched.
export async function advanceCursor(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    const meta = await db.syncMeta.get(username);
    if (!meta) return; // signed out mid-cycle — nothing to advance
    const ahead =
      syncCursorUpdatedAt > meta.syncCursorUpdatedAt ||
      (syncCursorUpdatedAt === meta.syncCursorUpdatedAt && syncCursorPath > meta.syncCursorPath);
    if (!ahead) return;
    await db.syncMeta.update(username, { syncCursorUpdatedAt, syncCursorPath });
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
  await db.syncMeta.update(username, { syncCursorUpdatedAt, syncCursorPath });
}
