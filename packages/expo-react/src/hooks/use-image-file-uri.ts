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
//  - The in-flight sentinel is `null` mapped INSIDE the read (useLiveRead has
//    no initial-value parameter; its `undefined` means "first read still in
//    flight"), so "resolved: nothing local" (request the fetch) stays
//    distinguishable from "still loading" (don't request yet).

import { useEffect } from 'react';

import { useFileContent } from '../contexts/file-content-provider';
import { readFileUri } from '../data/queries';
import { useLiveRead } from './use-live-read';

// See the module comment — the mounted-and-settled gate before a network request.
const REQUEST_SETTLE_MS = 300;

export function useImageFileUri(fileId: string | undefined): string | undefined {
  const { requestFileContent } = useFileContent();

  // `undefined` = query in flight; `null` = resolved with nothing local.
  const uri = useLiveRead<string | null>(
    () => (fileId ? readFileUri(fileId).then((u) => u ?? null) : Promise.resolve(null)),
    [fileId],
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

  return uri ?? undefined;
}
