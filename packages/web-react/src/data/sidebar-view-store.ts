'use client';

// Read/write/clear helpers over the device-local links-drawer view state (the
// collapsed nav sections/rows) — the sibling of expo-react's sidebar-view-store,
// which keeps the same thing in its `sidebar_view` table. The sole owner of the
// storage key and the read-write, so the sidebar hook stays shape-only.
//
// Why localStorage, not Dexie: this is device-local VIEW state, so the synced
// settings are out by definition, and it's deliberately not the `localSettings`
// row either — that bag is for cross-cutting device settings (theme/layout),
// whereas these ids are one pane's chrome. localStorage is also synchronous, so
// a collapse toggle persists without an awaited/floated IDB write on every
// click. (Same reasoning as subscription-store, for a different reason: there
// it's the sync READ that matters, here the fire-and-forget write.)
//
// Every operation is best-effort — the collapse toggle must never throw over a
// storage hiccup; a failed read just starts everything expanded.

const STORAGE_KEY = 'bracemark:sidebar-collapsed';

// The device's persisted collapse ids, or [] when none is stored / storage is
// unavailable or the value is corrupt. Defensive about the stored shape
// (untrusted JSON): a non-array or a stray non-string entry degrades to a clean
// string list, never a crash — a bad id would just fail to match any
// section/row and stay inert.
export function readSidebarCollapsedIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// Persist the full collapse set (the hook passes the whole set each toggle). A
// no-op when storage is unavailable (private mode, quota) — the in-memory set
// still drives this session's UI.
export function writeSidebarCollapsedIds(collapsedIds: string[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(collapsedIds));
  } catch {
    // Storage unavailable — skip persistence.
  }
}

// Drop the stored set — called from the sign-out teardown (clear-data.ts) so the
// next account on this device doesn't inherit a collapse set keyed to the
// previous account's list/tag ids.
export function clearSidebarCollapsedIds(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing stored to clear.
  }
}
