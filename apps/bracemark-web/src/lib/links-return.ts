'use client';

import { useEffect, useRef } from 'react';

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
// CLEARED WHEN THE ACCOUNT IT BELONGED TO LEAVES THIS TAB (useLinksReturnOwner
// below, mounted in the root layout) — not by clear-data.ts, which cannot reach
// it: that runs once, in the tab that signed out, and sessionStorage is per tab,
// so every tab has to drop its own. This used to have no teardown at all, on the argument
// that a previous account's list/tag id can't resolve for the next one (the links
// page's stale-selection guard sends an unresolvable id home) and that system ids
// are shared by design. Both true, and neither covers the third thing the URL
// carries: a SEARCH. `/links?q=…` resolves for anyone, so the next account signed
// in from this tab closed Settings onto the previous one's search text.
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

// Forget where the links page was.
export function clearLinksReturn(): void {
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort, like the rest.
  }
}

// Tie the stored view to the account that browsed it: forget it when that
// account stops being the one signed in to this tab — a sign-out or a revocation
// (username → null), or another tab adopting a different account under this one.
// Keyed on the username because it is the one fact all three share. A tab that
// was never signed in, or whose session merely could not be read, has no
// previous account, so its first render clears nothing — and neither does the
// sign-in that follows, which is what lets the view survive a reload.
export function useLinksReturnOwner(username: string | null): void {
  const last = useRef(username);
  useEffect(() => {
    if (last.current !== null && last.current !== username) clearLinksReturn();
    last.current = username;
  }, [username]);
}
