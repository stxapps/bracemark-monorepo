// Read/write helpers over the device-local links-drawer view row (the collapsed
// nav sections/rows, whether the docked rail is put away on a wide window, and
// the width it is docked at) — the expo home of what bracemark-web's sidebar keeps in localStorage. Its own single-row JSON bag (SidebarViewValue in db.ts), kept
// separate from the device SETTINGS bag on purpose (see the table note). The
// sole owner of the constant key and the read-write, so the sidebar hook stays
// shape-only. Synchronous like subscription-store (drizzle's expo driver is a
// sync driver) and best-effort — the collapse toggle must never throw over a
// storage hiccup; a failed read just starts everything expanded, matching web.

import { eq } from 'drizzle-orm';

import {
  getDb,
  type SidebarRailWidths,
  type SidebarRailWindowShape,
  sidebarView,
  type SidebarViewValue,
} from './db';

// The constant primary key — one view bag per device (db.ts).
const SIDEBAR_VIEW_ID = 'singleton' as const;

// The stored bag, or null when there is none or it can't be read. Both writers
// go through it so each keeps the OTHER field: one row holds both, and a write
// that spelled out only its own half would silently reset the rest.
function readValue(): Partial<SidebarViewValue> | null {
  try {
    const row = getDb().select().from(sidebarView).where(eq(sidebarView.id, SIDEBAR_VIEW_ID)).get();
    const value: unknown = row?.value;
    return typeof value === 'object' && value !== null
      ? (value as Partial<SidebarViewValue>)
      : null;
  } catch {
    return null;
  }
}

// The device's persisted collapse ids, or [] when none is stored / the row is
// unreadable or corrupt. Defensive about the stored shape (untrusted JSON): a
// non-array or a stray non-string entry degrades to a clean string list, never
// a crash — a bad id would just fail to match any section/row and stay inert.
export function readSidebarCollapsedIds(): string[] {
  const ids: unknown = readValue()?.collapsedIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

// Every field, re-validated from what is stored, so a writer of one field
// carries the others through. Spelled out field by field rather than spreading
// the stored bag: a write is also where an unknown or corrupt field gets dropped
// — and a field this list forgets is one every OTHER writer silently erases (the
// rail width, added later, was the specimen: the old writer rebuilt the bag from
// the two fields it knew).
function writeValue(patch: Partial<SidebarViewValue>): void {
  try {
    const current = readValue();
    const railWidths = parseRailWidths(current?.railWidths);
    const value: SidebarViewValue = {
      collapsedIds: Array.isArray(current?.collapsedIds) ? current.collapsedIds : [],
      ...(current?.railCollapsed === true ? { railCollapsed: true } : {}),
      ...(Object.keys(railWidths).length > 0 ? { railWidths } : {}),
      ...patch,
    };
    getDb()
      .insert(sidebarView)
      .values({ id: SIDEBAR_VIEW_ID, value })
      .onConflictDoUpdate({ target: sidebarView.id, set: { value } })
      .run();
  } catch {
    // Storage unavailable — skip persistence.
  }
}

// Persist the full collapse set (the hook passes the whole set each toggle, like
// web's localStorage write). A no-op on storage failure — the in-memory set
// still drives this session's UI.
export function writeSidebarCollapsedIds(collapsedIds: string[]): void {
  writeValue({ collapsedIds });
}

// Whether the docked links rail is put away. Only `true` counts — a missing
// field (a row from before it existed), a corrupt value or an unreadable store
// all read as SHOWN, which is the rail's default and the safe direction: a rail
// that appears unasked is one tap from gone, a rail that never appears is a
// navigation the user has to rediscover.
export function readSidebarRailCollapsed(): boolean {
  return readValue()?.railCollapsed === true;
}

export function writeSidebarRailCollapsed(railCollapsed: boolean): void {
  writeValue({ railCollapsed });
}

// --- The docked rail's width, one per window shape ---
//
// Read by TWO layouts that must agree — the links rail and the settings rail,
// which docks at the same width so crossing between them moves nothing — so this
// half is an external store (subscribe + snapshot) for `useSyncExternalStore`,
// like web-react's `getSidebarRail`, rather than a read each caller makes on
// mount: a width changed in the links rail has to reach a settings layout
// already mounted under it in the stack.
//
// The snapshot is held in memory, not re-read per call: `getSnapshot` runs on
// every render of every reader, and here that is a sqlite query. It is loaded on
// first read and dropped by `forgetSidebarRailWidths`, which the sign-out
// teardown calls (clear-data.ts) — a cached copy would otherwise hand the next
// account in this process the previous one's widths, past the table wipe.
// A write the store refuses still updates the cache, so the rail keeps the width
// for the session — it just isn't remembered (web's `railFallback`).

const NO_RAIL_WIDTHS: SidebarRailWidths = {};

let railWidthsCache: SidebarRailWidths | null = null;
const railWidthsListeners = new Set<() => void>();

// Untrusted JSON: only a finite positive number under a known shape survives;
// anything else reads as unset, i.e. that shape's default. The bounds are the
// rail's to apply (see db.ts).
function parseRailWidths(raw: unknown): SidebarRailWidths {
  if (typeof raw !== 'object' || raw === null) return NO_RAIL_WIDTHS;
  const widths: SidebarRailWidths = {};
  for (const shape of ['portrait', 'landscape'] as const) {
    const width: unknown = (raw as Record<string, unknown>)[shape];
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[shape] = width;
  }
  return Object.keys(widths).length > 0 ? widths : NO_RAIL_WIDTHS;
}

// The stored widths, identity-stable until the next write or wipe. Empty when
// nothing is stored or the row is unreadable — every shape at its default.
export function getSidebarRailWidths(): SidebarRailWidths {
  railWidthsCache ??= parseRailWidths(readValue()?.railWidths);
  return railWidthsCache;
}

export function subscribeSidebarRailWidths(listener: () => void): () => void {
  railWidthsListeners.add(listener);
  return () => railWidthsListeners.delete(listener);
}

// Set one shape's width, or clear it back to the default with `null`. The other
// shape's width is kept.
export function writeSidebarRailWidth(shape: SidebarRailWindowShape, width: number | null): void {
  const next: SidebarRailWidths = { ...getSidebarRailWidths() };
  if (width === null) delete next[shape];
  else next[shape] = width;
  railWidthsCache = next;
  writeValue({ railWidths: next });
  for (const listener of railWidthsListeners) listener();
}

// Drop the cached widths, so the next read goes back to the (now wiped) table.
// The sign-out teardown's half of this store (clear-data.ts).
export function forgetSidebarRailWidths(): void {
  railWidthsCache = null;
  for (const listener of railWidthsListeners) listener();
}
