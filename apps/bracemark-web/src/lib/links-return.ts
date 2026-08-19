'use client';

// Where the links page was when you left it for Settings — read/write over one
// sessionStorage key, and the sole owner of that key.
//
// The links view is ENTIRELY in the URL (`links/_contexts/page-provider.tsx`),
// so nothing about the view itself needs persisting: this stores a route, not
// state. It exists because Settings is a separate page — navigating there
// unmounts the links tree, and the ✕ that brings you back had no way to know
// which view it was covering, so it went to the bare `/links` and dropped
// whatever list, tag, or search you were on.
//
// SESSION storage, not local. This is per-tab "where I was", not a preference:
// with localStorage a second tab's ✕ would jump to the first tab's filter, and
// opening the app next week would land on a stale tag instead of the inbox. The
// value should die with the tab, which is exactly sessionStorage's lifetime.
//
// No sign-out teardown (unlike sidebar-view-store, which clear-data.ts wipes):
// the value is tab-scoped, and a list/tag id belonging to a previous account
// can't resolve for the next one — the links page's own stale-selection guard
// (page-provider.tsx) sends an unresolvable id home. The system ids are shared
// across accounts by design, and naming one is just a view.
//
// Every operation is best-effort — closing Settings must never throw over a
// storage hiccup; a failed read just means the bare `/links` we had before.

const STORAGE_KEY = 'bracemark:links-return';

// The default the ✕ falls back to whenever there's nothing usable stored.
const LINKS_HOME = '/links';

// A stored value is only ever a links URL this app wrote. Check it anyway:
// sessionStorage is user-writable, and the value goes straight into a `<Link>`,
// where a `//evil.com` or `/\evil.com` would be a live off-site redirect (the
// same class of hole guest-guard.ts rejects on its `?next=` param). Anything
// that isn't `/links` or `/links?…` is discarded rather than sanitized.
function isLinksHref(href: string): boolean {
  return href === LINKS_HOME || href.startsWith(`${LINKS_HOME}?`);
}

// Remember the links view currently on screen. Called from the links page
// provider on every URL change, so the record tracks the live view without any
// call site having to remember to update it.
export function recordLinksReturn(href: string): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, href);
  } catch {
    // Storage unavailable (private mode, quota) — the ✕ falls back to /links.
  }
}

// The links view to return to, or `/links` when nothing valid is stored — this
// tab never visited the links page, storage is unavailable, or the value was
// tampered with.
export function readLinksReturn(): string {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    return raw && isLinksHref(raw) ? raw : LINKS_HOME;
  } catch {
    return LINKS_HOME;
  }
}
