'use client';

// A host's favicon as an <img>-ready object URL — the per-HOST sibling of
// useImageFileUrl, and the same two halves: the read is the LOCAL cached bytes only
// (readFavicon via liveQuery), so the icon appears the moment they land, whether
// this row's own request fetched them or another row on the same host did; the
// fetch fires when the local read RESOLVES stale (unknown host, or a `none` verdict
// aged past FAVICON_RETRY_MS).
//
// Returns the object URL, or undefined while there's nothing to show — the caller
// renders its monogram. Because misses are RECORDED (`none` rows) and hits are
// per-host, a settled library asks the network nothing: this reduces to one
// primary-key get per rendered row.
//
// The URL is revoked when the bytes change and on unmount; a remounted row re-reads
// Dexie and mints a fresh one (cheap — a single-key get, no network once resident).
//
// THE BLOB CARRIES ITS MIME, re-sniffed here rather than stored on the row. An
// object URL is served with the Blob's `type`, and a typeless one gets none: an
// <img> content-sniffs RASTER bytes regardless, but it will NOT sniff SVG —
// without a declared `image/svg+xml` an SVG favicon silently fails to paint. So
// the row stays bytes-only (FaviconRecord in db.ts) and the mime is derived at
// render time by the same `sniffIconMime` the fetch gated on: it's a magic-byte
// read memoized on the bytes, it can't disagree with what was cached, and it
// needs nothing of rows written before SVG rendered at all.

import { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { sniffIconMime } from '@stxapps/shared';

import { useFavicon } from '../contexts/favicon-provider';
import { type FaviconRecord } from '../data/db';
import { isFaviconStale, readFavicon } from '../data/favicon-store';

// The mounted-and-settled gate before a request — rows are virtualized, so this
// keeps a fast scroll from asking for every host it flies past. Matches
// useImageFileUrl's delay.
const REQUEST_SETTLE_MS = 300;

// Sentinel initial value, so "query still in flight" (don't request yet) is
// distinguishable from "resolved: nothing cached" (request the fetch) — the same
// ambiguity useImageFileUrl's LOADING resolves.
const LOADING = Symbol('loading');

export function useFaviconUrl(host: string | undefined): string | undefined {
  const { requestFavicon } = useFavicon();

  const record = useLiveQuery(
    () => (host ? readFavicon(host) : Promise.resolve(undefined)),
    [host],
    LOADING as FaviconRecord | undefined | typeof LOADING,
  );

  const settled = record === LOADING ? undefined : record;
  // Recomputed per render rather than memoized on `record`: a `none` row's
  // staleness is a function of the CLOCK, not of the row, so a remount after the
  // retry window is what re-asks. Cheap — a subtraction.
  const stale = record !== LOADING && isFaviconStale(settled);

  useEffect(() => {
    if (!host || !stale) return;
    const timer = setTimeout(() => requestFavicon(host), REQUEST_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [host, stale, requestFavicon]);

  const bytes = settled?.status === 'ok' ? settled.bytes : undefined;

  const url = useMemo(() => {
    if (bytes === undefined) return undefined;
    const type = sniffIconMime(bytes);
    // `type` is undefined only for a row written before this verdict existed (or
    // by a future filler that widened it); an untyped Blob is what such a row
    // already rendered as, so it degrades to exactly the old behaviour.
    return URL.createObjectURL(new Blob([bytes as BlobPart], type ? { type } : undefined));
  }, [bytes]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return url;
}
