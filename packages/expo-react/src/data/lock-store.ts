// Read/write helpers over the device-local `locks` table (db.ts) — the expo
// sibling of web-react's data/lock-store.ts, same API so the lock-provider port
// is drop-in: no network, no sync bookkeeping, no React (the provider adds
// reactivity via drizzle's useLiveQuery and owns the in-memory unlocked state).
// Wiped on sign-out by the future clear-data, which is the "forgot a lock
// password" recovery path.
//
// Deliberately sqlite, NOT expo-secure-store: a lock verifier is a one-way
// PBKDF2 pair guarding already-decrypted local data (see expo-crypto's
// lock-verifier.ts — "a shoulder-surfing deterrent, not encryption"), so it
// needs a queryable device-local table, not credential storage. secure-store
// would also fight the shape: no key enumeration, a ~2 KB per-entry Android
// cap that N list locks would breach, and iOS-Keychain survival across
// uninstall that plain app data correctly doesn't have.

import { eq } from 'drizzle-orm';

import { getDb, locks } from './db';

// Mirrors web-react's LockRecord (hideList optional, not null) so the shared
// lock logic — e.g. @stxapps/shared's computeCoverage — sees one shape. ONE
// expo-only addition: `biometric`, the opt-in to unlock this lock with Face ID /
// Touch ID (docs/locks.md). It's native-only (web has no equivalent), and the
// shared CoverageLock slice reads only `id`/`hideList`, so the extra field
// doesn't touch the cross-platform logic.
export interface LockRecord {
  id: string;
  kind: 'app' | 'list';
  salt: string;
  hash: string;
  hideList?: boolean;
  biometric?: boolean;
}

// The constant primary key of the single app-lock row. List locks are keyed by
// their list id (a system-list constant or a random token — neither can collide
// with this).
export const APP_LOCK_ID = 'app' as const;

export async function readLocks(): Promise<LockRecord[]> {
  const rows = await getDb().select().from(locks);
  return rows.map((row) => ({
    ...row,
    hideList: row.hideList ?? undefined,
    biometric: row.biometric ?? undefined,
  }));
}

export async function putLock(record: LockRecord): Promise<void> {
  const row = { ...record, hideList: record.hideList ?? null, biometric: record.biometric ?? null };
  await getDb().insert(locks).values(row).onConflictDoUpdate({ target: locks.id, set: row });
}

export async function deleteLock(id: string): Promise<void> {
  await getDb().delete(locks).where(eq(locks.id, id));
}
