'use client';

// A `files/` image as an <img>-ready object URL, local-first with an on-demand
// fetch. The read half is the LOCAL bytes only (readFileBytes via liveQuery —
// same pattern as the link editor's stored-image preview), so it re-renders the
// moment bytes land in Dexie, whether this hook's own request fetched them, a
// local extraction wrote them, or another view already pulled them. The fetch
// half fires when the local read RESOLVES empty: the record exists but its lazy
// blob isn't materialized (or the record is unknown — the provider settles which
// via its missing memo). Mounting is the display signal — callers are
// virtualized rows — and the settle delay keeps a fast scroll from requesting
// every row it flies past: only rows still mounted after REQUEST_SETTLE_MS ask.
//
// Returns the object URL, or undefined while there's nothing to show (caller
// renders its placeholder). The URL is revoked whenever the bytes change and on
// unmount; a remounted row re-reads Dexie and mints a fresh URL (cheap — a
// single-key get, no network once resident).

import { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { useFileContent } from '../contexts/file-content-provider';
import { readFileBytes } from '../data/queries';

// See the module comment — the mounted-and-settled gate before a network request.
const REQUEST_SETTLE_MS = 300;

// Sentinel initial value, so "query still in flight" (don't request yet) is
// distinguishable from "resolved: no local bytes" (request the fetch).
const LOADING = Symbol('loading');

export function useImageFileUrl(fileId: string | undefined): string | undefined {
  const { requestFileContent } = useFileContent();

  const bytes = useLiveQuery(
    () => (fileId ? readFileBytes(fileId) : Promise.resolve(undefined)),
    [fileId],
    LOADING as Uint8Array | undefined | typeof LOADING,
  );

  // `bytes === undefined` is exactly "resolved with nothing local" — the LOADING
  // sentinel and present bytes both skip. A fetch that comes back missing leaves
  // `bytes` undefined and the deps unchanged, so this never tight-loops; a
  // remount re-asks and the provider's missing memo makes that a no-op.
  useEffect(() => {
    if (!fileId || bytes !== undefined) return;
    const timer = setTimeout(() => requestFileContent(fileId), REQUEST_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [fileId, bytes, requestFileContent]);

  const url = useMemo(
    () =>
      bytes !== undefined && bytes !== LOADING
        ? URL.createObjectURL(new Blob([bytes as BlobPart]))
        : undefined,
    [bytes],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return url;
}
