// A `files/` image as an <Image>-ready plaintext `file://` uri, local-first
// with an on-demand fetch — the expo port of web-react's use-image-file-url
// (that header is canonical: local read half + fetch-on-resolved-empty half,
// mounting as the display signal, the settle delay against fast scrolls).
// Platform divergences:
//
//  - The read is readFileUri via useLiveRead over `items` (the fetch's
//    markItemDataFile touches the row, so the landing re-fires it) instead of
//    readFileBytes via Dexie liveQuery.
//  - The value is the on-disk plaintext's `file://` uri (content lives
//    decrypted on disk — file-store.ts), not a minted object URL, so there's
//    nothing to revoke on unmount.
//  - The resolved-empty sentinel is `null` mapped INSIDE the read (useLiveRead
//    has no initial-value parameter; its `undefined` means "read still in
//    flight"), so "resolved: nothing local" (request the fetch) stays
//    distinguishable from "still loading" (don't request yet).
//  - BOTH SENTINELS ARE RETURNED, where web folds them into one `undefined`.
//    The caller is a FlashList-recycled row, so `fileId` changes under a live
//    instance, and the read is keyed (useKeyedLiveRead) so the previous link's
//    uri is never reported for the next link's id — it reports in flight
//    instead. That beat needs its own rendering: the slot's fallback is a
//    monogram, and painting it between two photos on every recycle is a flash
//    of its own. So `undefined` = in flight (the caller blanks the slot),
//    `null` = no image here — none asked for, or nothing local yet (the caller
//    falls back). Unlike the favicon there is no disk shortcut for the beat: a
//    content file exists before its row says so (sync/engine.ts — the native
//    decrypt writes it, and `hasDataFile` is marked only after), and the slot's
//    memory cache would keep whatever a half-written file decoded to.

import { useEffect } from 'react';

import { useFileContent } from '../contexts/file-content-provider';
import { readFileUri } from '../data/queries';
import { useKeyedLiveRead } from './use-live-read';

// See the module comment — the mounted-and-settled gate before a network request.
const REQUEST_SETTLE_MS = 300;

export function useImageFileUri(fileId: string | undefined): string | null | undefined {
  const { requestFileContent } = useFileContent();

  // `undefined` = query in flight, which includes the beat after `fileId`
  // changes under a recycled row; `null` = resolved with nothing local.
  const uri = useKeyedLiveRead<string | undefined, string | null>(
    fileId,
    (id) => (id ? readFileUri(id).then((u) => u ?? null) : Promise.resolve(null)),
    ['items'],
  );

  // `uri === null` is exactly "resolved with nothing local" — in-flight and a
  // present uri both skip. A fetch that comes back missing leaves `uri` null
  // and the deps unchanged, so this never tight-loops; a remount re-asks and
  // the provider's missing memo makes that a no-op.
  useEffect(() => {
    if (!fileId || uri !== null) return;
    const timer = setTimeout(() => requestFileContent(fileId), REQUEST_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [fileId, uri, requestFileContent]);

  // No id is known without a read — an image-less link falls back at once.
  return fileId ? uri : null;
}
