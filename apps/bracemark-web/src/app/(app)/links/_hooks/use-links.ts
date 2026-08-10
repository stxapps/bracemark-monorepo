'use client';

// Reactive, paginated read of the link library for the main pane. `useLiveQuery`
// re-runs whenever the underlying `items` rows change — which is exactly when the
// sync engine reconciles a pull or the UI commits a local edit — so the read
// stays live with no manual invalidation. It also re-runs when `query` or `limit`
// change (the deps below), since those reshape the query.
//
// Pagination is pushed into the read (`readLinks`): the active view reads only
// its page through the `item*` indexes (db.ts), never the whole library, so this
// scales to a large library without loading and sorting it in memory. "Show more"
// grows `limit`, which re-runs the query for the larger page. `total` is
// `undefined` when the read can't cheaply count it (an active text search) — see
// LinksResult.
//
// Staged repaint. The list is index-virtualized and sorted newest-first, so
// blindly rendering every live result would shift the rows under a user who's
// scrolled down or has a row menu open (a touched link floats to the top; the
// menu's row moves or unmounts). So `live` keeps flowing but we render a held
// `displayed` snapshot, promoting it only when a repaint won't disrupt:
//   - first paint, and any query/limit change (navigation / "show more") — these
//     are the user's own action, never staged.
//   - just after a local edit on this device (localWriteNonce grace window) — the
//     optimistic write AND the sync cycle it kicks both land here, and they're the
//     user's change, so they apply at once.
//   - while idle (not engaged — see view-state-provider).
// Otherwise we stage: `displayed` stays put and `hasPending` lights the refresh
// pill, which calls `applyPending` to swap the latest results in on demand.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { TRASH_ID } from '@stxapps/shared';
import {
  excludeLists,
  type LinkItem,
  type LinksResult,
  readLinks,
  useLocks,
  useSync,
} from '@stxapps/web-react';

import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';

const PAGE_SIZE = 50;

// How long after a local edit incoming results still apply eagerly. Covers both
// re-runs the edit triggers (the optimistic write, then the sync cycle it kicks)
// without depending on their exact ordering or timing.
const LOCAL_WRITE_GRACE_MS = 1500;

export interface UseLinksResult {
  links: LinkItem[];
  // How many leading entries of `links` are pinned (LinksResult). The layouts use
  // it to mark pinned rows and enable their move-up/down menu items.
  pinnedCount: number;
  // Exact match count, or `undefined` when it isn't known: an active text search
  // (not cheaply countable — LinksResult) or the first query still in flight.
  // Distinct from `0`, which is a real empty result.
  total?: number;
  hasMore: boolean;
  showMore: () => void;
  // undefined while the first query is in flight (useLiveQuery's initial value).
  isLoading: boolean;
  // True when a background sync produced results that differ from what's rendered
  // and they're being held back (the user is scrolled down / a menu is open). The
  // layouts surface a refresh pill; `applyPending` swaps the held results in.
  hasPending: boolean;
  applyPending: () => void;
}

// A cheap content fingerprint: equal iff the rendered page would look the same.
// Lets us tell a real update from a re-run that returns identical content — a
// write to an unrelated record (or another list) still re-fires the live query,
// and we don't want that to light the pill.
function signatureOf(result: LinksResult): string {
  const rows = result.links.map((link) => `${link.path}:${link.updatedAt}`).join('|');
  return `${rows}#${result.pinnedCount}/${result.total ?? '?'}/${result.hasMore}`;
}

export function useLinks(): UseLinksResult {
  const { query: urlQuery } = useLinksPage();
  const { lockedListIds } = useLocks();
  const { localWriteNonce } = useSync();
  const { engaged } = useLinksViewState();
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Why suppression lives HERE (the read edge) and not up in page-provider, next
  // to where `query` is authored: it must run DOWNSTREAM of `selection`. Both locks
  // and trash suppress by adding to `lists.none` (via `excludeLists` below), and
  // `selectionFromQuery` collapses ANY `lists.none` to `{ kind: 'none' }` — so folding
  // suppression into the provider's `query` would strip the sidebar highlight off Show
  // All and every tag/search view (their selection would read as `none`). page-provider
  // derives `selection` from the un-suppressed query on purpose; suppression is a read
  // policy layered on a complete query, not part of authoring it — unlike sort, which
  // IS intrinsic to the query (URL override ?? synced setting) and so resolves up there.
  //
  // The list ids the reads suppress, for two independent reasons:
  //
  //   LOCKS — lock-provider's coverage set (descendants included), ALWAYS. This is
  //     the lock's enforcement EDGE: suppressing here means EVERY read path — Show
  //     All, tag views, text search, the pinned overlay, hand-built deep links —
  //     excludes a locked list's links; the main pane's lock pane is just chrome.
  //
  //   TRASH — unless the query ASKS for it. Removing a link means "stop showing me
  //     this", so Trash is a destination you visit, not content that keeps
  //     resurfacing in the views you browse and search. Without this, a trashed link
  //     is indistinguishable from a live one in Show All / tag views / search (rows
  //     render no list, so the only tell is its row menu collapsing to
  //     Restore/Delete). Archive is deliberately NOT suppressed — archiving means
  //     "keep, just not in my inbox", so those links belong in Show All.
  //
  // The trash gate keys off the QUERY (`lists.any` naming it), not `selection`:
  // selection is a lossy single-axis projection that resolves to `none` for compound
  // filters, so the advanced editor's "Trash + some text" — an explicit request —
  // would be silently emptied if we keyed off it. Asking for Trash is the same act
  // whether it arrives from the sidebar, the search editor, or a deep link.
  //
  // Locks differ precisely here: they're enforcement, so no query can opt out.
  const suppressedListIds = useMemo(() => {
    if (urlQuery.lists.any.includes(TRASH_ID)) return lockedListIds;
    return new Set([...lockedListIds, TRASH_ID]);
  }, [urlQuery, lockedListIds]);

  // The query the reads actually run. The grammar-level HOW — shaping the exclusion
  // to preserve readRest's fast path — lives in `excludeLists`; a positive list view
  // (My List, a user list) keeps its exact-count fast path because the suppressed ids
  // aren't in its `any`, so `excludeLists` returns the query unchanged. Show All and
  // tag/search views pay a `lists.none` clause, which is what actually filters them.
  //
  // Memoized so its identity is stable like the URL query's: it changes only when the
  // URL or the suppressed set changes (an unlock reads as a page change below and
  // repaints immediately — the user's own action). `lockedListIds` is identity-stable
  // from lock-provider's memo, so `suppressedListIds` is stable per URL, and
  // `excludeLists` returns the SAME reference when there's nothing to exclude — so
  // this memo stays stable then too. (The applied sort is already resolved into
  // `urlQuery` by page-provider — URL override or synced setting — so a sort change
  // arrives as a new `urlQuery` and flows through here untouched.)
  const query = useMemo(
    () => excludeLists(urlQuery, suppressedListIds),
    [urlQuery, suppressedListIds],
  );

  // Reset pagination when the view changes: a new query is a fresh page and should
  // start at PAGE_SIZE, not inherit a grown "show more" limit from the previous
  // view. We adjust state DURING render (React's recommended pattern for deriving
  // state from a changed input) so `limit` is corrected before `useLiveQuery` below
  // reads it — an effect would instead let the query run once with the stale larger
  // limit, then re-run. Relies on the same stable `query` reference the deps do.
  const [queryForLimit, setQueryForLimit] = useState(query);
  if (query !== queryForLimit) {
    setQueryForLimit(query);
    setLimit(PAGE_SIZE);
  }

  // The always-current result. Kept flowing; we choose WHEN to show it.
  const live = useLiveQuery(() => readLinks(query, limit), [query, limit]);
  const liveRef = useRef(live);
  liveRef.current = live;

  // What's actually rendered — a snapshot promoted from `live`.
  const [displayed, setDisplayed] = useState<LinksResult>();

  // Local-edit grace: a bump moves the window forward and promotes immediately so
  // the optimistic write shows at once; the sync cycle it kicks lands within the
  // window and promotes too (see LOCAL_WRITE_GRACE_MS).
  const graceUntilRef = useRef(0);
  useEffect(() => {
    if (localWriteNonce === 0) return; // initial mount, not an edit
    graceUntilRef.current = Date.now() + LOCAL_WRITE_GRACE_MS;
    if (liveRef.current !== undefined) setDisplayed(liveRef.current);
  }, [localWriteNonce]);

  // A query/limit change is the user's own action (navigation or "show more"), so
  // the new page replaces the snapshot rather than staging behind it. We read page
  // identity off the result itself — `readLinks` echoes the `query`/`limit` it ran
  // for — rather than diffing against a prev-render ref. This matters because on the
  // render right after a query/limit change, useLiveQuery still returns the PREVIOUS
  // result, which echoes the old page: `liveReflectsCurrentPage` is false until the fresh
  // page lands, so we neither promote the stale value as the new page nor retire the
  // signal early. (`live.query === query` is a reference check — the result stores
  // the exact object the querier was given, and page-provider keeps that reference
  // stable, the same contract the `[query, limit]` deps above already rely on.)
  useEffect(() => {
    if (live === undefined) return;
    const liveReflectsCurrentPage = live.query === query && live.limit === limit;
    const pageChanged =
      displayed === undefined || displayed.query !== live.query || displayed.limit !== live.limit;

    const promoteNow =
      displayed === undefined || // first paint
      (liveReflectsCurrentPage && pageChanged) || // navigation / show more — once the new page arrives
      Date.now() < graceUntilRef.current || // this device just edited
      !engaged; // idle: nothing to disturb

    if (promoteNow) setDisplayed(live);
    // else: hold — `displayed` stays put and `hasPending` lights the pill.
  }, [live, query, limit, engaged, displayed]);

  const liveSig = useMemo(() => (live ? signatureOf(live) : undefined), [live]);
  const displayedSig = useMemo(() => (displayed ? signatureOf(displayed) : undefined), [displayed]);
  const hasPending =
    liveSig !== undefined && displayedSig !== undefined && liveSig !== displayedSig;

  return {
    links: displayed?.links ?? [],
    pinnedCount: displayed?.pinnedCount ?? 0,
    total: displayed?.total,
    hasMore: displayed?.hasMore ?? false,
    showMore: () => setLimit((value) => value + PAGE_SIZE),
    isLoading: displayed === undefined,
    hasPending,
    applyPending: () => {
      if (liveRef.current !== undefined) setDisplayed(liveRef.current);
    },
  };
}
