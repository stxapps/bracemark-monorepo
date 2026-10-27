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
//  - The read rides a shared, batched cache over `favicons`
//    (data/keyed-live-cache.ts), with the resolved-empty state mapped to `null`
//    inside the read (use-image-file-uri's sentinel note: `undefined` means
//    "not read yet"). KEYED, because the caller is a FlashList-recycled row:
//    the same instance is handed the next link's host, and must never be told
//    the previous host's verdict. A host the cache holds — and with a few
//    hundred hosts across a library, most are, a screen into a scroll —
//    answers in the render that changed it. Web has no such beat to guard —
//    its rows are keyed by link path and remount.
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
  readFavicons,
} from '../data/favicon-store';
import { createKeyedLiveCache } from '../data/keyed-live-cache';
import { useKeyedLiveCache } from './use-keyed-live-cache';

// The mounted-and-settled gate before a request — rows are virtualized, so this
// keeps a fast scroll from asking for every host it flies past. Matches
// use-image-file-uri's delay.
const REQUEST_SETTLE_MS = 300;

// One for the app: every row's favicon reads through it. Compared by what a row
// renders from — a re-read hands back fresh row objects, and identity alone
// would re-render every mounted favicon on every `favicons` write.
const faviconRecords = createKeyedLiveCache<string, FaviconRecord | null>({
  tables: ['favicons'],
  readMany: async (hosts) => {
    const records = await readFavicons(hosts);
    return new Map(hosts.map((host) => [host, records.get(host) ?? null]));
  },
  equals: (a, b) =>
    a === b || (a !== null && b !== null && a.status === b.status && a.fetchedAt === b.fetchedAt),
});

export function useFaviconUri(host: string | undefined): string | undefined {
  const { requestFavicon } = useFavicon();

  // `undefined` = not read yet, which includes the beat after `host` changes
  // under a recycled row onto a host the cache doesn't hold; `null` = resolved
  // with no cached row.
  const record = useKeyedLiveCache(faviconRecords, host)?.value;

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
  // Settled: the verdict answers, and a host without an icon builds no File.
  if (record !== undefined) return record?.status === 'ok' ? faviconFileFor(host).uri : undefined;
  // In flight: the disk answers — see the header.
  const file = faviconFileFor(host);
  return file.exists ? file.uri : undefined;
}
