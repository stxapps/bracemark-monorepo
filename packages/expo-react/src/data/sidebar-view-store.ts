// Read/write helpers over the device-local links-drawer view row (the collapsed
// nav sections/rows, and whether the docked rail is put away on a wide window)
// — the expo home of what bracemark-web's sidebar keeps in localStorage. Its own single-row JSON bag (SidebarViewValue in db.ts), kept
// separate from the device SETTINGS bag on purpose (see the table note). The
// sole owner of the constant key and the read-write, so the sidebar hook stays
// shape-only. Synchronous like subscription-store (drizzle's expo driver is a
// sync driver) and best-effort — the collapse toggle must never throw over a
// storage hiccup; a failed read just starts everything expanded, matching web.

import { eq } from 'drizzle-orm';

import { getDb, sidebarView, type SidebarViewValue } from './db';

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

function writeValue(patch: Partial<SidebarViewValue>): void {
  try {
    const current = readValue();
    const value: SidebarViewValue = {
      collapsedIds: Array.isArray(current?.collapsedIds) ? current.collapsedIds : [],
      ...(current?.railCollapsed === true ? { railCollapsed: true } : {}),
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
