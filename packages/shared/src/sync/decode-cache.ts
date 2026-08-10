// Memoized decoded links, keyed by the local store's `items` path and versioned
// by the record's blob-write timestamps. Platform-agnostic on purpose — a pure
// Map over types that already live here (sync/items.ts) — so web-react (Dexie)
// and expo-react (expo-sqlite) share one cache implementation: both read layers
// have the same O(loaded)-per-reactive-tick decode problem (Dexie liveQuery and
// drizzle useLiveQuery both re-run whole queries on any table write). Each
// platform's sign-out wipe (clear-data.ts there) calls clearDecodeCache without
// the write/sync layer having to import the read layer: this module depends on
// nothing but types, so the reader (queries), the writer, and the clearer can
// all point at it without inverting the layering.
//
// Why cache at all: decoding a link (parseBlob → JSON.parse + zod) is the costliest
// step of a read, and the live link views re-read and re-decode the whole loaded
// prefix on every `items` write. Memoizing turns that O(loaded) zod work per tick
// into O(changed) — a record is re-decoded only when its bytes change.
//
// Version = the PAIR (`updatedAt`, `itemUpdatedAt`). Neither alone tracks every
// byte change, but the two axes cover each other's blind spot:
//   - `updatedAt` (server R2-LastModified, the platform db.ts) is restamped by
//     sync — download, commit, conflict merge, migration — but the local write
//     edge FREEZES it at the pre-edit base (mutations.ts keeps it for reconcile),
//     so a local edit before sync leaves it unchanged. `updatedAt` alone would
//     serve a stale decode across that whole window.
//   - `itemUpdatedAt` (the in-blob "date modified", projection.ts) is bumped by
//     every local edit, catching exactly that window. It can't drift from the
//     bytes — the projector recomputes it in the SAME `put` that writes `data` —
//     and the read path ALREADY depends on it being current: it backs the
//     `[itemType+itemUpdatedAt]` / `[itemListId+itemUpdatedAt]` sort indexes,
//     so a stale value would mis-order the views, not just the cache.
//     But a server-side rewrite can change the bytes while leaving it untouched
//     (a merge/migration that keeps the modified time), so it's insufficient solo.
// Together they cover every rewrite EXCEPT one, and the exception is why the local
// write edge also drops explicitly (dropCachedPath below): `itemUpdatedAt` is
// `Date.now()`, so TWO local writes to the same path inside one millisecond leave
// BOTH axes unchanged and the first one's decode is served for the second's bytes —
// until some later write or a sync restamp moves a version. That is not exotic: the
// extension's titleImage capture writes the title, then the terminal facet state,
// back to back with nothing but a transaction between them whenever the page has no
// preview image to resize; a settings picker fires one write per keystroke. Raising
// the clock's resolution isn't available (the value is a persisted, synced "date
// modified", not a cache token), so the writer invalidates instead — which also
// makes the pair's job purely about writes this device didn't make.
// (A content hash would also work but costs an O(bytes) pass per resident link per
// reactive tick — pure overhead on the all-hits hot path.)
//
// Two caches, same versioning: `links/` and `extractions/`. The writer-split means a
// list row now joins both blobs (the user-authored link + the machine-derived
// extraction — see docs/link-extraction.md), and both are re-read on every reactive
// tick, so both need the same O(changed) memo. The tiny lists/tags/pins namespaces
// read whole and skip the cache.

import type { ExtractionItem, LinkItem } from './items';

// Bounded so the cache can't grow without limit, but MAX sits WELL ABOVE the
// largest plausible loaded working set (a fully-scrolled large library), so for
// normal libraries eviction never fires — the cache effectively holds the whole
// resident set, and only an outlier library past MAX distinct links ever evicts.
// Sizing it under the working set would be self-defeating: a fully-expanded 10k
// list re-reads all 10k each reactive tick, and a too-small cache would evict
// on-screen entries and re-decode them on the very next tick (thrash).
//
// Eviction is INSERTION (FIFO) order, not true LRU. Recency tracking would cost a
// Map delete+set on every cache HIT — and a hit happens for ~every resident link
// on every tick, i.e. tens of thousands of Map ops per refresh on a big list. The
// hot path here is all-hits, so that bookkeeping is pure overhead; and since MAX
// is above the working set, eviction almost never runs, so FIFO behaves the same
// as LRU in practice while costing nothing on reads.
const MAX = 50000;

interface Entry<T> {
  updatedAt: number;
  itemUpdatedAt: number;
  value: T;
}

// One path-keyed, version-pair memo. A hit is a single Map lookup + two integer
// compares; stale iff EITHER version axis moved (see the header). No recency
// bookkeeping (FIFO eviction — see the note above).
function makeCache<T>() {
  const cache = new Map<string, Entry<T>>();
  return {
    get(path: string, updatedAt: number, itemUpdatedAt: number): T | undefined {
      const hit = cache.get(path);
      if (!hit || hit.updatedAt !== updatedAt || hit.itemUpdatedAt !== itemUpdatedAt) {
        return undefined;
      }
      return hit.value;
    },
    set(path: string, updatedAt: number, itemUpdatedAt: number, value: T): void {
      cache.set(path, { updatedAt, itemUpdatedAt, value });
      if (cache.size > MAX) {
        cache.delete(cache.keys().next().value as string); // evict oldest-inserted (FIFO)
      }
    },
    drop(path: string): void {
      cache.delete(path);
    },
    clear(): void {
      cache.clear();
    },
  };
}

const linkCache = makeCache<LinkItem>();
const extractionCache = makeCache<ExtractionItem>();

// A live decoded link for `path` whose bytes haven't changed since it was cached, or
// `undefined` (miss / stale) — the caller then decodes and `setCachedLink`s.
export function getCachedLink(
  path: string,
  updatedAt: number,
  itemUpdatedAt: number,
): LinkItem | undefined {
  return linkCache.get(path, updatedAt, itemUpdatedAt);
}

export function setCachedLink(
  path: string,
  updatedAt: number,
  itemUpdatedAt: number,
  link: LinkItem,
): void {
  linkCache.set(path, updatedAt, itemUpdatedAt, link);
}

// Drop one link entry — used when a record's bytes go absent/unparseable, so a later
// re-appearance isn't masked by a stale decode.
export function dropCachedLink(path: string): void {
  linkCache.drop(path);
}

// The `extractions/` counterpart, used by the link↔extraction join in the read layer.
export function getCachedExtraction(
  path: string,
  updatedAt: number,
  itemUpdatedAt: number,
): ExtractionItem | undefined {
  return extractionCache.get(path, updatedAt, itemUpdatedAt);
}

export function setCachedExtraction(
  path: string,
  updatedAt: number,
  itemUpdatedAt: number,
  extraction: ExtractionItem,
): void {
  extractionCache.set(path, updatedAt, itemUpdatedAt, extraction);
}

export function dropCachedExtraction(path: string): void {
  extractionCache.drop(path);
}

// Drop one path from BOTH caches — the LOCAL WRITE EDGE's invalidation hook, called
// by each platform's mutations.ts after the write's transaction commits.
//
// It closes the version pair's one blind spot (see the header): two local writes to
// the same path inside a millisecond are indistinguishable by `(updatedAt,
// itemUpdatedAt)`, so without this the reader keeps serving the first write's decode.
// The writer knows exactly which path changed and has to touch this module anyway to
// stay correct, so the invalidation is exact and costs one Map delete per write —
// against a cache whose whole purpose is amortizing READS.
//
// Namespace-agnostic on purpose: the write edge is generic over paths (one
// `writeBytesWith` serves every namespace), so it shouldn't have to know which of
// the two caches a path could be in. A drop of an absent key is free.
//
// AFTER the commit, never before: a reader racing the window between them would
// otherwise re-cache the pre-write decode under the pre-write version and the drop
// would miss it. Dropping a freshly-cached CORRECT entry instead just costs one
// re-decode.
export function dropCachedPath(path: string): void {
  linkCache.drop(path);
  extractionCache.drop(path);
}

// Drop every cached decode (both caches) — called from each platform's clearData
// on sign-out (alongside the `items` wipe it mirrors), so a second user on the same
// device can't read the first's decoded data.
export function clearDecodeCache(): void {
  linkCache.clear();
  extractionCache.clear();
}
