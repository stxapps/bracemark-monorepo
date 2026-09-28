'use client';

// "A newer build owns this origin's databases now" — the update-required signal
// (docs/offline-mode.md, _version skew_, the local database schema).
//
// Every tab of the web app (and the browser extension's contexts on their own
// origin) opens the same two IndexedDB databases: Dexie's `bracemark-data`
// (db.ts) and the raw `bracemark-session` (session-store.ts). When a newer build
// opens either at a higher version, IndexedDB sends `versionchange` to every older
// connection, and the old code has to let go AT ONCE: holding the connection
// blocks the new tab's upgrade (Dexie's side hangs; the raw session db leaves the
// new tab's auth unresolved forever), and it can never reopen at its own, lower
// version afterwards. So both databases close on `versionchange` and report here,
// and so does a first open that fails with `VersionError` (a tab whose first open
// happens after the upgrade never receives `versionchange` at all).
//
// ⚠ THIS HAS TO BE IN THE BUILD BEING REPLACED. `versionchange` fires in the OLD
// tab, so the handler that answers it is the old code — it must ship well before
// the first `version(2)` of either database, or that bump meets every open tab
// with nothing listening.
//
// The signal is sticky: once a database has been handed to a newer build, this
// context can't use it again, so nothing un-sets it short of a reload. Consumers:
// the sync providers stop scheduling cycles, and the app shows the
// update-required state (reload, with any unsaved draft kept on screen to copy).
// A database-open error is never "signed out" — nothing reads this as permission
// to clear anything.

export type UpdateRequiredSource = 'data' | 'session';

let required: UpdateRequiredSource | null = null;
const listeners = new Set<(source: UpdateRequiredSource) => void>();

export function isUpdateRequired(): boolean {
  return required !== null;
}

export function markUpdateRequired(source: UpdateRequiredSource): void {
  if (required !== null) return;
  required = source;
  for (const listener of listeners) listener(source);
}

// Subscribe; fires at most once per context. Returns an unsubscribe fn.
export function onUpdateRequired(listener: (source: UpdateRequiredSource) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether an IndexedDB/Dexie open failure means "a newer build upgraded this
// database" (the name survives Dexie's error wrapping).
export function isVersionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; inner?: { name?: unknown } };
  return e.name === 'VersionError' || e.inner?.name === 'VersionError';
}

// Test seam: forget the sticky state between specs.
export function resetUpdateRequiredForTests(): void {
  required = null;
}
