'use client';

// Read/write helpers over the device-local `locks` table (see LockRecord in
// db.ts) — the same species as local-settings-store.ts: no network, no sync
// bookkeeping, no React (lock-provider adds reactivity via useLiveQuery and owns
// the in-memory unlocked state). Wiped on sign-out by clearData
// (clear-data.ts), which is the "forgot a lock password" recovery path.

import { db, type LockRecord } from './db';

// The constant primary key of the single app-lock row. List locks are keyed by
// their list id (a system-list constant or a random token — neither can collide
// with this).
export const APP_LOCK_ID = 'app' as const;

export function readLocks(): Promise<LockRecord[]> {
  return db.locks.toArray();
}

export async function putLock(record: LockRecord): Promise<void> {
  await db.locks.put(record);
}

export async function deleteLock(id: string): Promise<void> {
  await db.locks.delete(id);
}
