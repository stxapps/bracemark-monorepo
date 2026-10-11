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
//  - The read rides useKeyedLiveRead over `favicons`, with the resolved-empty
//    state mapped to `null` inside the read (use-image-file-uri's sentinel note:
//    `undefined` means "read in flight"). KEYED, because the caller is a
//    FlashList-recycled row: the same instance is handed the next link's host,
//    and plain useLiveRead holds the previous host's verdict for a beat after.
//    Web has no such beat to guard — its rows are keyed by link path and remount.
//  - WHILE THE VERDICT IS IN FLIGHT, THE DISK ANSWERS. The uri needs only the
//    file; the row is the fetch gate's bookkeeping. So for that beat — a first
//    mount, or a recycle — the icon is shown iff its file exists, and a row
//    recycled between two icon'd hosts swaps icons in the render that changed
//    the host rather than dropping to its fallback and back. It cannot show a
//    half-written icon: putFavicon writes the file and the row in one
//    synchronous transaction, so no render falls between them. The settled
//    verdict outranks the disk the moment it lands.

import { useEffect } from 'react';

import { useFavicon } from '../contexts/favicon-provider';
import {
  faviconFileFor,
  type FaviconRecord,
  isFaviconStale,
  readFavicon,
} from '../data/favicon-store';
import { useKeyedLiveRead } from './use-live-read';

// The mounted-and-settled gate before a request — rows are virtualized, so this
// keeps a fast scroll from asking for every host it flies past. Matches
// use-image-file-uri's delay.
const REQUEST_SETTLE_MS = 300;

export function useFaviconUri(host: string | undefined): string | undefined {
  const { requestFavicon } = useFavicon();

  // `undefined` = query in flight, which includes the beat after `host` changes
  // under a recycled row; `null` = resolved with no cached row.
  const record = useKeyedLiveRead<string | undefined, FaviconRecord | null>(
    host,
    (h) => (h ? readFavicon(h).then((r) => r ?? null) : Promise.resolve(null)),
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

  if (!host) return undefined;
  const file = faviconFileFor(host);
  // In flight: the disk answers — see the header.
  const present = record === undefined ? file.exists : record?.status === 'ok';
  return present ? file.uri : undefined;
}
