// Where the links page was when you left it for Settings or the reader — read/write
// over two sessionStorage keys (the view, and the row in it), and the sole owner of
// both.
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
// CLEARED WHEN THE ACCOUNT IT BELONGED TO LEAVES THIS TAB (the root layout's
// Initializer observes account changes) — not by clear-data.ts, which cannot reach
// it: that runs once, in the tab that signed out, and sessionStorage is per tab,
// so every tab has to drop its own. This used to have no teardown at all, on the argument
// that a previous account's list/tag id can't resolve for the next one (the links
// page's stale-selection guard sends an unresolvable id home) and that system ids
// are shared by design. Both true, and neither covers the third thing the URL
// carries: a SEARCH. `/links?q=…` resolves for anyone, so the next account signed
// in from this tab closed Settings onto the previous one's search text.
//
// A SECOND key holds the ROW the reader was opened from, for the same reason one
// level down. The route brings you back to the right view, but the view comes back
// at its top, with its first page: the links tree is unmounted by the trip, and the
// pane's scroll offset and "show more" depth lived in it. After reading a link 300
// rows down you would land 300 rows from it. So the reader records the link it
// showed, and the links page — once, on the mount that follows — pages until that
// link is loaded and scrolls it into view (`useRestoreReturnRow`, links/_layouts).
// It stores an ID and the view it was in, never an offset: an offset is meaningless
// against a list that has been re-sorted, edited or re-paged since, and an id is
// the one thing that still names the same row. The view is stored with it so the
// row is only restored in the view it was opened from — the link would otherwise
// be hunted for, page by page, in a list that does not hold it.
//
// Same lifetime and same teardown as the route (session storage, cleared by
// `clearLinksReturn` when the account leaves the tab): a link id is as much that
// account's as a search is.
//
// Every operation is best-effort — closing Settings must never throw over a
// storage hiccup; a failed read just means the bare `/links` we had before.

const STORAGE_KEY = 'bracemark:links-return';
const ROW_STORAGE_KEY = 'bracemark:links-return-row';

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

// The href of a links view given its query string (no leading `?`; empty for the
// bare view). The one spelling of it: the provider records it, and the row restore
// compares against it.
export function linksHrefOf(queryString: string): string {
  return queryString ? `${LINKS_HOME}?${queryString}` : LINKS_HOME;
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

// Remember the link the reader is showing as the row to come back to, in the view
// the ✕ will return to (the last one the links page recorded). Called by the reader
// when it opens a link, so the browser's Back button restores the row as well as
// the ✕ does.
export function recordReturnRow(linkId: string): void {
  try {
    globalThis.sessionStorage?.setItem(
      ROW_STORAGE_KEY,
      JSON.stringify({ href: readLinksReturn(), id: linkId }),
    );
  } catch {
    // Storage unavailable — the view comes back at its top.
  }
}

// The link id to scroll to in the view at `href`, or undefined — nothing stored,
// the record is for another view, or the value is not the shape this module wrote
// (sessionStorage is user-writable; an id is only ever compared with ids, but a
// malformed record is discarded rather than guessed at). A peek, not a take: the
// restore can run twice before it finishes (a dev double-mount, a re-render while
// it pages) and the second run must find the same row; `clearReturnRow` is what
// ends it.
export function peekReturnRow(href: string): string | undefined {
  try {
    const raw = globalThis.sessionStorage?.getItem(ROW_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { href: storedHref, id } = parsed as { href?: unknown; id?: unknown };
    if (typeof storedHref !== 'string' || typeof id !== 'string' || !id) return undefined;
    return storedHref === href ? id : undefined;
  } catch {
    return undefined;
  }
}

// The restore is over — it found the row, gave up, or the user took the scroll.
export function clearReturnRow(): void {
  try {
    globalThis.sessionStorage?.removeItem(ROW_STORAGE_KEY);
  } catch {
    // Best-effort, like the rest.
  }
}

// Forget where the links page was, and the row in it.
export function clearLinksReturn(): void {
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort, like the rest.
  }
  clearReturnRow();
}
