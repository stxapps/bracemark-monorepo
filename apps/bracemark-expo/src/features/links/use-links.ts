// Reactive, paginated read of the link library for the links screen — the expo
// port of bracemark-web's `(app)/links/_hooks/use-links.ts` (canonical doc: the
// staged repaint — `live` keeps flowing, a held `displayed` snapshot renders,
// promotion rules, the localWriteNonce grace window, why suppression lives at
// the read edge and not in page-provider). Divergences here:
//
//  - The live read is expo-react's useLiveRead over expo-sqlite's change
//    listener (readLinks touches `items` + the tag junction) instead of Dexie's
//    useLiveQuery.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  excludeLists,
  type LinkItem,
  type LinksResult,
  readLinks,
  useLiveRead,
  useLocks,
  useSync,
} from '@stxapps/expo-react';
import { TRASH_ID } from '@stxapps/shared';

import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

const PAGE_SIZE = 50;

// How long after a local edit incoming results still apply eagerly — covers
// both re-runs the edit triggers (optimistic write, then its sync cycle).
const LOCAL_WRITE_GRACE_MS = 1500;

// Web's UseLinksResult, verbatim — see there for each field's contract.
export interface UseLinksResult {
  links: LinkItem[];
  pinnedCount: number;
  total?: number;
  hasMore: boolean;
  showMore: () => void;
  isLoading: boolean;
  hasPending: boolean;
  applyPending: () => void;
}

// A cheap content fingerprint: equal iff the rendered page would look the same
// (a write to an unrelated record still re-fires the live read; don't light the
// pill for it).
function signatureOf(result: LinksResult): string {
  const rows = result.links.map((link) => `${link.path}:${link.updatedAt}`).join('|');
  return `${rows}#${result.pinnedCount}/${result.total ?? '?'}/${result.hasMore}`;
}

export function useLinks(): UseLinksResult {
  const { query: urlQuery } = useLinksPage();
  const { localWriteNonce } = useSync();
  const { engaged } = useLinksViewState();
  const { lockedListIds } = useLocks();
  const [limit, setLimit] = useState(PAGE_SIZE);

  // The list ids the reads suppress, for two independent reasons (web
  // use-links's rationale, verbatim — see there): LOCKS — lock-provider's
  // coverage set (descendants included), ALWAYS; this is the lock's
  // enforcement EDGE, so every read path (Show All, tag views, search)
  // excludes a locked list's links, and no query can opt out. TRASH — unless
  // the query ASKS for it (Trash is a destination you visit, not content that
  // resurfaces in browse/search). `lockedListIds` is identity-stable from
  // lock-provider's memo, so this memo is stable per URL.
  const suppressedListIds = useMemo(() => {
    if (urlQuery.lists.any.includes(TRASH_ID)) return lockedListIds;
    return new Set([...lockedListIds, TRASH_ID]);
  }, [urlQuery, lockedListIds]);

  // The query the reads actually run — `excludeLists` shapes the exclusion to
  // preserve the single-list fast path (see shared link-query.ts). Memoized so
  // its identity is stable: it changes only when the URL or the suppressed set
  // changes, and `excludeLists` returns the SAME reference when there's nothing
  // to exclude.
  const query = useMemo(
    () => excludeLists(urlQuery, suppressedListIds),
    [urlQuery, suppressedListIds],
  );

  // Reset pagination when the view changes — state adjusted DURING render so
  // `limit` is corrected before the live read below reads it (web's rationale).
  const [queryForLimit, setQueryForLimit] = useState(query);
  if (query !== queryForLimit) {
    setQueryForLimit(query);
    setLimit(PAGE_SIZE);
  }

  // The always-current result. Kept flowing; we choose WHEN to show it.
  const live = useLiveRead(
    () => readLinks(query, limit),
    [query, limit],
    ['items', 'item_tag_ids'],
  );
  const liveRef = useRef(live);
  liveRef.current = live;

  // What's actually rendered — a snapshot promoted from `live`.
  const [displayed, setDisplayed] = useState<LinksResult>();

  // Local-edit grace: a bump moves the window forward and promotes immediately.
  const graceUntilRef = useRef(0);
  useEffect(() => {
    if (localWriteNonce === 0) return; // initial mount, not an edit
    graceUntilRef.current = Date.now() + LOCAL_WRITE_GRACE_MS;
    if (liveRef.current !== undefined) setDisplayed(liveRef.current);
  }, [localWriteNonce]);

  // Promotion — web's rules, verbatim: first paint, the user's own
  // query/limit change (page identity read off the result's echoed
  // `query`/`limit`), the local-edit grace window, or idle.
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
