'use client';

// Read/write helpers over the per-account sync bookkeeping row (see db.ts). This
// is the seam the SyncProvider and the sync engine both go through, so the gate
// invariant ("firstSyncDoneAt > 0 ⇒ local store is complete up to the cursor")
// has one owner. Deliberately tiny and side-effect-light — no network, no React.

import {
  afterRecheck,
  forgetSettled,
  recordSkips,
  type SkippedPath,
  type UnreadableState,
} from '@stxapps/shared';

import { db, type SyncMetaRecord } from './db';
import { peekSession, withSessionLock } from './session-store';

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
// empty by definition), so auth marks the first sync done under the lifecycle
// lock with an empty cursor. This lets create-account render instantly with no
// network round-trip — setSession seeds it after cleanup, before exposing auth.
// Encoding "new account" as a persisted flag here (rather than threading a
// create-vs-sign-in boolean through React) keeps SyncProvider's logic uniform.
// The cursor starts empty — `(0, '')` — since there's nothing pulled yet.
export function seedNewAccount(username: string): Promise<string> {
  return db.syncMeta.put({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
    // A new account has nothing a build could have skipped, so the record is
    // complete from the start (shared's unreadableRecordComplete).
    unreadableRecordCompleteAt: Date.now(),
  });
}

// A stale sync cycle ran into a torn-down account: its bookkeeping row is gone,
// so the local store it was writing into belongs to nobody — or to the NEXT
// account signed in on this device. Every pulled write re-checks the row inside
// its own transaction (the engine's putPulled/applyDeletes) and aborts with this,
// so a cycle that outlived a sign-out, a revocation wipe or an account switch in
// any context can't leave the old account's plaintext in the new store
// (docs/sessions.md, _concurrent requests and shared local state_). The
// teardown's clear and these writes are rw transactions on the same store, so
// IndexedDB orders them: either the write lands first and the clear removes it,
// or the clear lands first and the write finds no row.
export class AccountFencedError extends Error {
  constructor(username: string) {
    super(`Sync for ${username} stopped: the account is no longer signed in on this device`);
    this.name = 'AccountFencedError';
  }
}

// Inside a transaction that includes db.syncMeta: throw unless `username` still
// owns this device's store. Hands back the row it read, for a caller that has more
// to do with it in the same transaction.
export async function assertAccountStillOwnsStore(username: string): Promise<SyncMetaRecord> {
  const meta = await db.syncMeta.get(username);
  if (!meta) throw new AccountFencedError(username);
  return meta;
}

// Claim the bookkeeping row — only ever under the lifecycle lock: from setSession,
// before it exposes the adopted session, and from claimIfStillSignedIn below. A
// sync cycle must never call this directly to recreate ownership after teardown.
// The row begins
// with `firstSyncDoneAt: 0` — "not done", so the gate still blocks and an
// interrupted pull re-runs. It exists so every write of that pull has a row to be
// fenced on (AccountFencedError). An existing row is left as it is.
export async function beginInitialSync(username: string): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    if (await db.syncMeta.get(username)) return;
    await db.syncMeta.put({
      username,
      syncCursorUpdatedAt: 0,
      syncCursorPath: '',
      firstSyncDoneAt: 0,
    });
  });
}

// The claim for a session adopted by a build that made none at adoption (it
// claimed only as its first pull began): SyncProvider calls this before a first
// sync — never hydration, because startup must not wait on this database, which a
// long transaction in another tab can hold for as long as it runs. Under the
// lifecycle lock, and only while `username` is still the persisted account, so it
// can never recreate the ownership a teardown has just dropped.
export async function claimIfStillSignedIn(username: string): Promise<void> {
  await withSessionLock(async () => {
    const persisted = await peekSession();
    if (persisted?.username === username) await beginInitialSync(username);
  });
}

// The delete-all-data reset (delete-all-data.ts), for a caller already inside a
// transaction that includes db.syncMeta: back to the row seedNewAccount writes —
// cursor `(0, '')`, `firstSyncDoneAt` now. NOT seedNewAccount itself, though the
// row it leaves is the same: that one CREATES the row, and creating it is a claim,
// which belongs under the lifecycle lock (beginInitialSync, above). This one
// requires the row first — but its write is still a `put`, an upsert, so "rewrites,
// never creates" holds ONLY inside the caller's transaction, where no teardown can
// land between the check and the put. Called bare it is a check-then-put across two
// transactions, and can create the row. The flow reaches it after a server call
// that can be out for minutes, and a put from there would hand the store's
// ownership back to an account another context had torn down meanwhile — after
// which every fence keyed on that row accepts its stale writers again.
export async function resetToSeededState(username: string): Promise<void> {
  await assertAccountStillOwnsStore(username);
  await db.syncMeta.put({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
    // The server holds nothing now, so nothing here is an unrecorded skip.
    unreadableRecordCompleteAt: Date.now(),
  });
}

// Sign-in path: call once the initial full pull has finished (all blobs
// downloaded, decrypted, written). Atomic on purpose — only flip the flag after
// the snapshot is complete, so an interrupted first sync stays "not done" and
// re-blocks on the next load rather than leaving a partial store looking
// finished (the re-run resumes rather than restarts: the engine skips records
// already stored at the listed `updatedAt`). The first cursor is the op log's
// high-water mark as it stood BEFORE the pull's listing, with an empty path —
// never the newest stamp the listing showed, which says nothing about what a
// non-snapshot listing missed (sync/engine.ts logWatermark). The fallback cycle
// ends on the same value, for the same reason.
//
// Fenced like the pull's writes: the row beginInitialSync claimed must still be
// there, or the account was torn down mid-pull and this must not resurrect it. An
// `update`, not a `put`: the pull it closes has just recorded the paths it skipped
// on this row (recordUnreadablePaths), and rewriting the row whole would drop that
// record at the one moment it matters most — a fresh sign-in, where nothing else
// holds those paths.
export async function markFirstSyncDone(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    await assertAccountStillOwnsStore(username);
    await db.syncMeta.update(username, {
      syncCursorUpdatedAt,
      syncCursorPath,
      firstSyncDoneAt: Date.now(),
      // A first sync is a full listing, and its pull recorded what it skipped
      // before this claim, so the record now covers the whole store.
      unreadableRecordCompleteAt: Date.now(),
    });
  });
}

// A fallback (a full listing) completed with the record in place: from now on an
// absence here that the record doesn't name is not a skip (SyncMetaRecord.
// unreadableRecordCompleteAt). The engine calls it after the fallback's cursor
// claim; the fallback's pull recorded its skips before that. Fenced like the
// pull's writes.
export async function markUnreadableRecordComplete(username: string): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    await assertAccountStillOwnsStore(username);
    await db.syncMeta.update(username, { unreadableRecordCompleteAt: Date.now() });
  });
}

// The record as shared's rules see it (sync/unreadable.ts).
function unreadableState(meta: SyncMetaRecord): UnreadableState {
  return { paths: meta.unreadablePaths ?? [], recheck: meta.unreadableRecheck };
}

// Add paths a pull skipped as unreadable to the account's record
// (SyncMetaRecord.unreadablePaths), each with the server stamp the pull saw for it
// (the recheck stores a healed blob at that stamp). The pull calls it once, as it
// finishes and before its caller claims anything, so the record is never behind a
// completed cycle. Fenced like the pull's own writes: a pull that outlived its
// account fails here, as its puts and deletes would.
export async function recordUnreadablePaths(
  username: string,
  skipped: readonly SkippedPath[],
  now = Date.now(),
): Promise<void> {
  if (skipped.length === 0) return;
  await db.transaction('rw', db.syncMeta, async () => {
    const meta = await assertAccountStillOwnsStore(username);
    const next = recordSkips(unreadableState(meta), skipped, now);
    if (next) {
      await db.syncMeta.update(username, {
        unreadablePaths: [...next.paths],
        unreadableRecheck: next.recheck,
      });
    }
  });
}

// The end of a recheck (sync/engine.ts recheckUnreadable): the paths it found gone
// (a 404) leave the record, the ones still unreadable move to the back, and the next
// recheck is scheduled. The ones it healed already left, with the put that stored
// them. Fenced like the pull's writes.
export async function finishUnreadableRecheck(
  username: string,
  checked: readonly string[],
  gone: readonly string[],
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    const meta = await assertAccountStillOwnsStore(username);
    const next = afterRecheck(unreadableState(meta), checked, gone, now);
    await db.syncMeta.update(username, {
      unreadablePaths: [...next.paths],
      unreadableRecheck: next.recheck,
    });
  });
}

// Record that the orphaned-file sweep ran to the end (SyncMetaRecord.lastOrphanSweepAt).
// Fenced: a sweep that outlived its account writes nothing.
export async function markOrphanSweep(username: string, at: number): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    await assertAccountStillOwnsStore(username);
    await db.syncMeta.update(username, { lastOrphanSweepAt: at });
  });
}

// Inside a transaction that includes db.syncMeta, with the row its fence just read:
// drop paths a pull has now stored or deleted from the unreadable record. A path
// left in it by mistake costs nothing worse than a dangling extraction the sweep
// passes over; one dropped by mistake can cost a deleted extraction, so only the
// pull's own successful writes call this.
export async function forgetUnreadablePaths(
  meta: SyncMetaRecord,
  paths: readonly string[],
): Promise<void> {
  const next = forgetSettled(unreadableState(meta), paths);
  if (next) {
    await db.syncMeta.update(meta.username, {
      unreadablePaths: [...next.paths],
      unreadableRecheck: next.recheck,
    });
  }
}

// Advance the compound `(updatedAt, path)` cursor after an incremental cycle —
// to the last op that cycle LISTED, and only that: a caller must never pass a
// stamp it merely holds (its own commit's), since the cursor is the claim that
// everything at or below it has been applied (sync/engine.ts). Both halves move
// together: a later millisecond resets the path tiebreak. FORWARD-ONLY,
// read-and-compare in one transaction. The cycle lock keeps two tabs' cycles from
// overlapping where Web Locks exist; this guard is what still holds where they
// don't, so a slower context's cycle finishing late can't drag the cursor back
// below what a faster one already consumed (a regression would be harmless — just
// a redundant re-pull — but it is free to prevent). Leaves firstSyncDoneAt
// untouched.
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

// Set the cursor after a download-authoritative fallback — to the log's high-water
// mark as it stood before that cycle's listing (sync/engine.ts logWatermark).
// UNCONDITIONAL, unlike advanceCursor: the cursor-ahead fallback case exists
// precisely to LOWER a stale cursor back to what the log actually holds, and a
// wiped log puts it back at `(0, '')`.
export async function resetCursor(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  await db.syncMeta.update(username, { syncCursorUpdatedAt, syncCursorPath });
}
