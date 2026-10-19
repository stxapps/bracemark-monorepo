'use client';

// Read/write/clear helpers over the device-local links-drawer view state (the
// collapsed nav sections/rows; and, at the bottom, the desktop rail's dock state,
// which has no expo twin) — the sibling of expo-react's sidebar-view-store,
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

// --- The rail's dock state: whether it is collapsed, and how wide it was dragged ---
//
// Device-local view state like the collapsed ids above, under its own key, and
// wiped by the same sign-out teardown. Its lifecycle is otherwise
// `localSettings`' — this device's chrome, nothing account-keyed, so it survives
// delete-all-data — and it isn't in that Dexie row only because the row is an
// async read: the rail has to know its width and whether it is docked on the
// render that first mounts it, or a narrowed or collapsed rail paints at its
// default and then jumps (see `getSidebarRail`).
//
// Unlike the ids, the rail is read by TWO components that must agree — the rail
// itself and the topbar's "Show sidebar" control — so this half is an external
// store (subscribe + snapshot) for `useSyncExternalStore`, not a pair of bare
// read/write helpers each caller would have to re-broadcast between them.
//
// The width is validated as a finite positive number and nothing more. The
// bounds it is clamped to are the rail's design measure, so they live with the
// rail (links/_panes/sidebar.tsx) and are applied there on every read — a stored
// value from before a bound moved is clamped, not trusted.

const RAIL_STORAGE_KEY = 'bracemark:sidebar-rail';

export interface SidebarRail {
  collapsed: boolean;
  // Pixels; `null` means never resized — the rail's own default applies.
  width: number | null;
}

export const DEFAULT_SIDEBAR_RAIL: SidebarRail = { collapsed: false, width: null };

const railListeners = new Set<() => void>();

// The snapshot is cached against the RAW stored string, because
// `useSyncExternalStore` requires the same object back for an unchanged store —
// a fresh parse per call reads as a change on every render and loops. Keyed on
// the string rather than held as module state, so a wipe (`clearSidebarRail`, or
// another tab's sign-out clearing storage) is seen on the next read rather than
// masked by a cached copy of the previous account's rail.
let railCache: { raw: string | null; value: SidebarRail } = {
  raw: null,
  value: DEFAULT_SIDEBAR_RAIL,
};

// Where the rail lives when storage REFUSES the write (absent, disabled, over
// quota): this tab's memory, so the toggle still works for the session — it just
// isn't remembered. Dropped again by the next write storage accepts, and by the
// wipe.
let railFallback: SidebarRail | null = null;

function parseSidebarRail(raw: string | null): SidebarRail {
  if (!raw) return DEFAULT_SIDEBAR_RAIL;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SIDEBAR_RAIL;
    const { collapsed, width } = parsed as Record<string, unknown>;
    return {
      collapsed: collapsed === true,
      width: typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null,
    };
  } catch {
    return DEFAULT_SIDEBAR_RAIL;
  }
}

// The current rail, identity-stable while the stored value is unchanged. The
// default when nothing is stored, storage is unreadable, or the value is corrupt
// — a bad read docks the rail at its default width, never hides it.
export function getSidebarRail(): SidebarRail {
  if (railFallback) return railFallback;
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(RAIL_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== railCache.raw) railCache = { raw, value: parseSidebarRail(raw) };
  return railCache.value;
}

export function subscribeSidebarRail(listener: () => void): () => void {
  railListeners.add(listener);
  return () => railListeners.delete(listener);
}

// Merge `patch` into the rail, persist it, and notify every subscriber.
export function writeSidebarRail(patch: Partial<SidebarRail>): void {
  const next = { ...getSidebarRail(), ...patch };
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('no localStorage');
    storage.setItem(RAIL_STORAGE_KEY, JSON.stringify(next));
    railFallback = null;
  } catch {
    railFallback = next;
  }
  for (const listener of railListeners) listener();
}

// Drop the stored rail — the sign-out teardown (clear-data.ts), beside the
// collapsed ids. Subscribers are told, though on sign-out none are mounted.
export function clearSidebarRail(): void {
  railFallback = null;
  try {
    globalThis.localStorage?.removeItem(RAIL_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing stored to clear.
  }
  for (const listener of railListeners) listener();
}
