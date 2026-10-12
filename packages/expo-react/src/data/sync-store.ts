// Read/write helpers over the per-account sync bookkeeping row — the expo
// sibling of web-react's data/sync-store.ts, same API and the same gate
// invariant ("firstSyncDoneAt > 0 ⇒ local store is complete up to the cursor")
// with one owner. See that file for the full semantics of each operation;
// comments here cover the port. Deliberately tiny and side-effect-light — no
// network, no React.

import { eq } from 'drizzle-orm';

import { type DbTx, getDb, syncMeta } from './db';
import { loadSession, withSessionLock } from './session-store';

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
// round-trip (see web-react sync-store.ts).
export async function seedNewAccount(username: string): Promise<void> {
  putSyncMeta({
    username,
    syncCursorUpdatedAt: 0,
    syncCursorPath: '',
    firstSyncDoneAt: Date.now(),
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
export function resetToSeededStateTx(tx: DbTx, username: string): void {
  assertAccountOwnsStoreTx(tx, username);
  tx.update(syncMeta)
    .set({ syncCursorUpdatedAt: 0, syncCursorPath: '', firstSyncDoneAt: Date.now() })
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
    tx.update(syncMeta)
      .set({ syncCursorUpdatedAt, syncCursorPath, firstSyncDoneAt: Date.now() })
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
