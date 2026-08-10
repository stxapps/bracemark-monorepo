// A host's favicon as an <Image>-ready plaintext `file://` uri — the expo port
// of web-react's use-favicon-url (that header is canonical: the per-HOST two
// halves, why a settled library asks the network nothing) and the per-HOST
// sibling of use-image-file-uri. Divergences:
//
//  - The value is the cached icon file's uri (favicon-store.ts — the row holds
//    the verdict, the bytes live on disk), DERIVED from the host, so a
//    FlashList-recycled remount costs one small row read and no byte
//    handling — no object URL to mint/revoke, no base64. readFavicon already
//    folds the file-existence check, so an `ok` record here always has a file
//    behind its uri.
//  - The read rides useLiveRead over `favicons`, with the resolved-empty state
//    mapped to `null` inside the read (use-image-file-uri's sentinel note:
//    useLiveRead's `undefined` means "first read in flight").

import { useEffect } from 'react';

import { useFavicon } from '../contexts/favicon-provider';
import {
  faviconFileFor,
  type FaviconRecord,
  isFaviconStale,
  readFavicon,
} from '../data/favicon-store';
import { useLiveRead } from './use-live-read';

// The mounted-and-settled gate before a request — rows are virtualized, so this
// keeps a fast scroll from asking for every host it flies past. Matches
// use-image-file-uri's delay.
const REQUEST_SETTLE_MS = 300;

export function useFaviconUri(host: string | undefined): string | undefined {
  const { requestFavicon } = useFavicon();

  // `undefined` = query in flight; `null` = resolved with no cached row.
  const record = useLiveRead<FaviconRecord | null>(
    () => (host ? readFavicon(host).then((r) => r ?? null) : Promise.resolve(null)),
    [host],
    ['favicons'],
  );

  // Recomputed per render rather than memoized on `record`: a `none` row's
  // staleness is a function of the CLOCK, not of the row, so a remount after
  // the retry window is what re-asks. Cheap — a subtraction.
  const stale = record !== undefined && isFaviconStale(record ?? undefined);

  useEffect(() => {
    if (!host || !stale) return;
    const timer = setTimeout(() => requestFavicon(host), REQUEST_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [host, stale, requestFavicon]);

  if (!host || record?.status !== 'ok') return undefined;
  return faviconFileFor(host).uri;
}
