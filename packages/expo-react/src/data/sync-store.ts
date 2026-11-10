// Read/write helpers over the per-account sync bookkeeping row — the expo
// sibling of web-react's data/sync-store.ts, same API and the same gate
// invariant ("firstSyncDoneAt > 0 ⇒ local store is complete up to the cursor")
// with one owner. See that file for the full semantics of each operation;
// comments here cover the port. Deliberately tiny and side-effect-light — no
// network, no React.

import { eq } from 'drizzle-orm';

import {
  afterRecheck,
  forgetSettled,
  recordSkips,
  type SkippedPath,
  type UnreadableState,
} from '@stxapps/shared';

import { type DbTx, getDb, syncMeta } from './db';
import { loadSession, withSessionLock } from './session-store';

// Same shape as web-react's SyncMetaRecord, with web's four optional fields
// (`unreadablePaths`, `unreadableRecheck`, `unreadableRecordCompleteAt`,
// `lastOrphanSweepAt`) as nullable columns: NULL here is web's absent field.
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
// round-trip (see web-react sync-store.ts).
export async function seedNewAccount(username: string): Promise<void> {
  putSyncMeta({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
    // A new account has skipped nothing and never swept. Set explicitly, since
    // the upsert rewrites a row the same name left behind (web's `put` replaces
    // it whole).
    unreadablePaths: null,
    unreadableRecheck: null,
    // Nothing a build could have skipped (web's seedNewAccount).
    unreadableRecordCompleteAt: Date.now(),
    lastOrphanSweepAt: null,
  });
}

// A stale sync cycle ran into a torn-down account: its bookkeeping row is gone,
// so the store it was writing into belongs to nobody — or to the NEXT account
// signed in here. Every pulled write re-checks the row inside its own transaction
// (item-store's putItemsUnqueued / deleteItemsUnqueued) and aborts with this, so a
// cycle that outlived a sign-out, a revocation wipe or an account switch can't
// leave the old account's plaintext in the new store (docs/sessions.md). Same
// fence as web-react's sync-store.
export class AccountFencedError extends Error {
  constructor(username: string) {
    super(`Sync for ${username} stopped: the account is no longer signed in on this device`);
    this.name = 'AccountFencedError';
  }
}

// Inside the caller's transaction: throw unless `username` still owns the store.
export function assertAccountOwnsStoreTx(tx: DbTx, username: string): void {
  const meta = tx
    .select({ username: syncMeta.username })
    .from(syncMeta)
    .where(eq(syncMeta.username, username))
    .get();
  if (!meta) throw new AccountFencedError(username);
}

// Claim the bookkeeping row — only ever under the lifecycle lock: from setSession,
// before it exposes the adopted session, and from claimIfStillSignedIn below. A
// sync cycle must never call this directly to recreate ownership after teardown.
// The row begins
// with `firstSyncDoneAt: 0` — "not done", so the gate still blocks and an
// interrupted pull re-runs — so every write of that pull has a row to be fenced
// on. An existing row is left as it is.
export async function beginInitialSync(username: string): Promise<void> {
  getDb().transaction((tx) => {
    const meta = tx.select().from(syncMeta).where(eq(syncMeta.username, username)).get();
    if (meta) return;
    tx.insert(syncMeta)
      .values({ username, syncCursorUpdatedAt: 0, syncCursorPath: '', firstSyncDoneAt: 0 })
      .run();
  });
}

// The claim for a session adopted by a build that made none at adoption (it
// claimed only as its first pull began): SyncProvider calls this before a first
// sync — never hydration, which must not wait on the data store (the web
// sibling's rule; one shape for the ported pair). Under the lifecycle lock, and
// only while `username` is still the persisted account, so it can never recreate
// the ownership a teardown has just dropped.
export async function claimIfStillSignedIn(username: string): Promise<void> {
  await withSessionLock(async () => {
    const persisted = await loadSession();
    if (persisted?.username === username) await beginInitialSync(username);
  });
}

// The delete-all-data reset, inside the caller's transaction (delete-all-data.ts,
// which wipes the synced tables in the same one): back to the row seedNewAccount
// writes — cursor `(0, '')`, `firstSyncDoneAt` now. NOT seedNewAccount itself: that
// one CREATES the row, which is a claim and belongs under the lifecycle lock. This
// only rewrites a row that is still there (an UPDATE cannot insert), so a run whose
// account was torn down under its server call throws instead of handing the store
// back to it (web's sync-store carries the reasoning). The row is keyed on the
// username, not the session: the SAME account signing back in meanwhile passes.
// The unreadable record and the sweep's stamp go too: the server holds nothing
// now, so nothing is unreadable, and web's reset rewrites the row whole. An
// UPDATE names its columns, so here they have to be named.
export function resetToSeededStateTx(tx: DbTx, username: string): void {
  assertAccountOwnsStoreTx(tx, username);
  tx.update(syncMeta)
    .set({
      syncCursorUpdatedAt: 0,
      syncCursorPath: '',
      firstSyncDoneAt: Date.now(),
      unreadablePaths: null,
      unreadableRecheck: null,
      unreadableRecordCompleteAt: Date.now(),
      lastOrphanSweepAt: null,
    })
    .where(eq(syncMeta.username, username))
    .run();
}

// Sign-in path: call once the initial full pull has finished (all blobs
// downloaded, decrypted, written) — only then does the flag flip, so an
// interrupted first sync stays "not done" and re-blocks (resuming, not
// restarting) on the next load. The cursor it is handed is the op log's
// high-water mark as it stood before the pull's listing, with an empty path —
// never the newest stamp the listing showed (sync/engine.ts logWatermark, and
// web's). Fenced like the pull's writes: the row beginInitialSync claimed must
// still be there, or the account was torn down mid-pull and this must not
// resurrect it.
export async function markFirstSyncDone(
  username: string,
  syncCursorUpdatedAt: number,
  syncCursorPath: string,
): Promise<void> {
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    // A first sync is a full listing whose pull recorded its skips before this
    // claim, so the record now covers the store (web's markFirstSyncDone).
    tx.update(syncMeta)
      .set({
        syncCursorUpdatedAt,
        syncCursorPath,
        firstSyncDoneAt: Date.now(),
        unreadableRecordCompleteAt: Date.now(),
      })
      .where(eq(syncMeta.username, username))
      .run();
  });
}

// A fallback (a full listing) completed with the record in place — web-react
// sync-store's markUnreadableRecordComplete. Fenced like the pull's writes.
export async function markUnreadableRecordComplete(username: string): Promise<void> {
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    tx.update(syncMeta)
      .set({ unreadableRecordCompleteAt: Date.now() })
      .where(eq(syncMeta.username, username))
      .run();
  });
}

// Advance the compound `(updatedAt, path)` cursor after an incremental cycle — to
// the last op that cycle LISTED, never to a stamp it merely holds (its own
// commit's): the cursor is the claim that everything at or below it has been
// applied (sync/engine.ts). FORWARD-ONLY, read-and-compare in one transaction —
// web guards against a slower context dragging the cursor back; native has one
// runtime per store, but the guard costs nothing (a regression would be harmless
// anyway: just a redundant re-pull). Leaves firstSyncDoneAt untouched.
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

// Set the cursor after a download-authoritative fallback — to the log's
// high-water mark as it stood before that cycle's listing (sync/engine.ts
// logWatermark). UNCONDITIONAL, unlike advanceCursor: the cursor-ahead fallback
// case exists precisely to LOWER a stale cursor back to what the log actually
// holds, and a wiped log puts it back at `(0, '')`.
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

// The record as shared's rules see it (sync/unreadable.ts), read inside `tx`.
function unreadableStateTx(tx: DbTx, username: string): UnreadableState {
  const meta = tx
    .select({ paths: syncMeta.unreadablePaths, recheck: syncMeta.unreadableRecheck })
    .from(syncMeta)
    .where(eq(syncMeta.username, username))
    .get();
  return { paths: meta?.paths ?? [], recheck: meta?.recheck ?? undefined };
}

// The unreadable record's paths, as a set — web-react sync-store's
// unreadablePathSet, which carries why a pull reads it once and what a stale one
// costs. A pull's stores then take a path out of the record only when it is in
// here (item-store's putItemsUnqueued), so an ordinary pull neither reads nor
// parses the record per row. Only the one column: the stamps stay unparsed.
export async function unreadablePathSet(username: string): Promise<Set<string>> {
  const meta = getDb()
    .select({ paths: syncMeta.unreadablePaths })
    .from(syncMeta)
    .where(eq(syncMeta.username, username))
    .get();
  return new Set(meta?.paths);
}

// Write a record shared's rules returned. An empty one is NULL, as web's absent field.
function writeUnreadableTx(tx: DbTx, username: string, next: UnreadableState): void {
  tx.update(syncMeta)
    .set({
      unreadablePaths: next.paths.length > 0 ? [...next.paths] : null,
      unreadableRecheck: next.recheck ?? null,
    })
    .where(eq(syncMeta.username, username))
    .run();
}

// Add paths a pull skipped as unreadable to the account's record
// (SyncMetaRecord.unreadablePaths), each with the server stamp the pull saw for
// it — web-react sync-store's recordUnreadablePaths, which carries the
// reasoning. The pull calls it once, as it finishes and before its caller claims
// the cursor or the first sync, so the record is never behind a completed cycle.
// Fenced like the pull's own writes.
export async function recordUnreadablePaths(
  username: string,
  skipped: readonly SkippedPath[],
  now = Date.now(),
): Promise<void> {
  if (skipped.length === 0) return;
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    const next = recordSkips(unreadableStateTx(tx, username), skipped, now);
    if (next) writeUnreadableTx(tx, username, next);
  });
}

// Inside the pull's own write transaction (item-store's putItemsUnqueued /
// deleteItemsUnqueued), after its fence: drop the paths it has just stored or
// deleted from the unreadable record — web-react sync-store's
// forgetUnreadablePaths. A path left in by mistake costs a sweep that waits; one
// dropped by mistake can cost a deleted extraction or blob for every device, so
// only the pull's successful writes (and the recheck's, through them) call this.
export function forgetUnreadablePathsTx(
  tx: DbTx,
  username: string,
  paths: readonly string[],
): void {
  const next = forgetSettled(unreadableStateTx(tx, username), paths);
  if (next) writeUnreadableTx(tx, username, next);
}

// The end of a recheck (sync/engine.ts recheckUnreadable) — web-react
// sync-store's finishUnreadableRecheck: the paths it found gone leave the
// record, the ones still unreadable move to the back, and the next recheck is
// scheduled. Fenced like the pull's writes.
export async function finishUnreadableRecheck(
  username: string,
  checked: readonly string[],
  gone: readonly string[],
  now = Date.now(),
): Promise<void> {
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    writeUnreadableTx(
      tx,
      username,
      afterRecheck(unreadableStateTx(tx, username), checked, gone, now),
    );
  });
}

// Record that the orphaned-file sweep ran to the end (SyncMetaRecord.lastOrphanSweepAt).
// `at` is the sweep's stamp (shared's orphanSweepStamp), which a capped run sets back.
// Fenced: a sweep that outlived its account writes nothing.
export async function markOrphanSweep(username: string, at: number): Promise<void> {
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    tx.update(syncMeta).set({ lastOrphanSweepAt: at }).where(eq(syncMeta.username, username)).run();
  });
}
