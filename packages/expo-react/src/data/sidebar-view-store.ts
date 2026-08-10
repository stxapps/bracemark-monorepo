// Read/write helpers over the device-local links-drawer view row (the collapsed
// nav sections/rows) — the expo home of what bracemark-web's sidebar keeps in
// localStorage. Its own single-row JSON bag (SidebarViewValue in db.ts), kept
// separate from the device SETTINGS bag on purpose (see the table note). The
// sole owner of the constant key and the read-write, so the sidebar hook stays
// shape-only. Synchronous like subscription-store (drizzle's expo driver is a
// sync driver) and best-effort — the collapse toggle must never throw over a
// storage hiccup; a failed read just starts everything expanded, matching web.

import { eq } from 'drizzle-orm';

import { getDb, sidebarView, type SidebarViewValue } from './db';

// The constant primary key — one view bag per device (db.ts).
const SIDEBAR_VIEW_ID = 'singleton' as const;

// The device's persisted collapse ids, or [] when none is stored / the row is
// unreadable or corrupt. Defensive about the stored shape (untrusted JSON): a
// non-array or a stray non-string entry degrades to a clean string list, never
// a crash — a bad id would just fail to match any section/row and stay inert.
export function readSidebarCollapsedIds(): string[] {
  try {
    const row = getDb().select().from(sidebarView).where(eq(sidebarView.id, SIDEBAR_VIEW_ID)).get();
    const ids = row?.value?.collapsedIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// Persist the full collapse set (the hook passes the whole set each toggle, like
// web's localStorage write). A no-op on storage failure — the in-memory set
// still drives this session's UI.
export function writeSidebarCollapsedIds(collapsedIds: string[]): void {
  try {
    const value: SidebarViewValue = { collapsedIds };
    getDb()
      .insert(sidebarView)
      .values({ id: SIDEBAR_VIEW_ID, value })
      .onConflictDoUpdate({ target: sidebarView.id, set: { value } })
      .run();
  } catch {
    // Storage unavailable — skip persistence.
  }
}
