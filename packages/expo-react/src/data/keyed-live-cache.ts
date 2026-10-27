// A shared, batched, live cache of small per-key reads — what a FlashList row
// asks of the store by KEY (a host's favicon verdict, a file's on-disk uri)
// rather than by query. useFaviconUri and useImageFileUri read through one each;
// docs/client-queries.md, _the expo port_, carries the why.
//
// The shape it replaces was a `useKeyedLiveRead` per row and per slot. Each row
// mount — and each RECYCLE, since a recycled row's key changes under it — tore
// down and rebuilt an expo-sqlite change listener, ran its own synchronous
// drizzle query (and a file stat) on the JS thread, and rendered again when the
// answer came back. On a fling that is every cell FlashList brings in, twice
// over, in the frames the scroll needs; and with ~40 rows mounted, each write to
// a watched table fanned out to ~80 listeners. A list layout pays it ~4× as often
// per scrolled pixel as the card layout, because its cells are that much shorter.
//
// So, three things, all keyed by the read's own key:
//
//  - SHARED. A key asked for by any number of rows is read once and held. A row
//    recycled onto a key already seen answers in the render that changed its key
//    — no in-flight beat, no second render, no query. Unwatched entries are kept
//    up to RETAIN, so a scroll back up the list finds what it passed.
//  - BATCHED. Keys first asked for in one commit (a fling brings in several rows
//    at once) are read together, on a microtask, in one `readMany` — an
//    `IN (…)`, not one statement per row.
//  - LIVE, ONCE. One change listener per cache, not per row. A write to a watched
//    table re-reads every WATCHED key in one batch and notifies only the keys
//    whose value moved (`equals`), and drops the unwatched ones, which would
//    otherwise be served stale. It honors `holdLiveReads` the way useLiveRead
//    does (data/live-read-invalidation.ts): while held a change only marks the
//    cache as having missed one, caught up on the next flush.
//
// The listener exists only while some key is watched; when the last watcher goes
// the cache drops its listener AND its entries, since nothing would keep them
// current. A LiveReadPause is the hook's business (use-keyed-live-cache.ts), not
// this module's: it suppresses a paused subtree's notifications, while the reads
// themselves stay one batch per change.
//
// Reads are serialized — one batch in flight at a time — so a batch that started
// before a write can't land after the batch that started after it.

import { addDatabaseChangeListener } from 'expo-sqlite';

import { DB_NAME } from './db';
import {
  liveReadsHeld,
  subscribeToHeldFlushes,
  subscribeToLiveReadInvalidations,
} from './live-read-invalidation';

// Unwatched entries kept for a scroll back. The values are a short string or a
// small row; a few thousand of them is nothing, and a library scrolled further
// than this just re-reads.
const RETAIN = 2000;

// An entry is boxed so a snapshot keeps its identity until the VALUE changes —
// what useSyncExternalStore needs from `peek`.
export interface CacheEntry<V> {
  readonly value: V;
}

export interface KeyedLiveCache<K, V> {
  // The entry for `key`, or undefined while it has never been read (in flight).
  peek(key: K): CacheEntry<V> | undefined;
  // Watch `key`: read it if it isn't held, and call `onChange` whenever its entry
  // changes. Returns the unsubscribe.
  subscribe(key: K, onChange: () => void): () => void;
  // Specs only: forget everything, listener included.
  reset(): void;
}

export function createKeyedLiveCache<K, V>(options: {
  tables: readonly string[];
  // Must answer every key it is given.
  readMany: (keys: K[]) => Promise<Map<K, V>>;
  equals?: (a: V, b: V) => boolean;
}): KeyedLiveCache<K, V> {
  const { tables, readMany } = options;
  const equals = options.equals ?? Object.is;

  const entries = new Map<K, CacheEntry<V>>();
  const watchers = new Map<K, Set<() => void>>();
  let watching = 0;

  const queued = new Set<K>();
  // The batch being read right now, so a second watcher of a key already in it
  // doesn't queue the same read again behind it.
  let reading = new Set<K>();
  let running = false;
  let microtaskQueued = false;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let missed = false;
  let teardown: (() => void) | null = null;

  const notify = (key: K) => {
    const set = watchers.get(key);
    if (set) for (const onChange of set) onChange();
  };

  const store = (key: K, value: V) => {
    const prev = entries.get(key);
    if (prev && equals(prev.value, value)) return;
    // Delete first, so the re-insert moves it to the young end of the LRU order.
    entries.delete(key);
    entries.set(key, { value });
    notify(key);
  };

  const evict = () => {
    if (entries.size <= RETAIN) return;
    for (const key of entries.keys()) {
      if (entries.size <= RETAIN) break;
      if (!watchers.has(key)) entries.delete(key);
    }
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queued.size > 0) {
        const keys = [...queued];
        queued.clear();
        reading = new Set(keys);
        try {
          const values = await readMany(keys);
          // A cache torn down mid-read has nobody to tell.
          if (teardown === null) return;
          for (const [key, value] of values) store(key, value);
          evict();
        } catch {
          // A read failing (no account, a closing store) leaves those keys as they
          // were — in flight if new, last-known otherwise — until the next change.
        }
      }
    } finally {
      running = false;
      reading = new Set();
    }
  };

  const enqueue = (key: K) => {
    queued.add(key);
    if (microtaskQueued) return;
    microtaskQueued = true;
    void Promise.resolve().then(() => {
      microtaskQueued = false;
      void drain();
    });
  };

  // Every watched key, re-read in one batch; every unwatched one, dropped.
  const refresh = () => {
    for (const key of [...entries.keys()]) if (!watchers.has(key)) entries.delete(key);
    for (const key of watchers.keys()) queued.add(key);
    void drain();
  };

  // A change event fires per ROW written, so a burst is coalesced into one
  // refresh on the next macrotask, as useLiveRead's scheduleRun does.
  const onChange = () => {
    if (liveReadsHeld()) {
      missed = true;
      return;
    }
    if (changeTimer !== null) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      refresh();
    }, 0);
  };

  const start = () => {
    const subscription = addDatabaseChangeListener((event) => {
      if (!event.databaseFilePath.endsWith(`/${DB_NAME}`)) return;
      if (!tables.includes(event.tableName)) return;
      onChange();
    });
    const offInvalidations = subscribeToLiveReadInvalidations((changed) => {
      if (changed.some((table) => tables.includes(table))) onChange();
    });
    const offFlushes = subscribeToHeldFlushes(() => {
      if (!missed) return;
      missed = false;
      onChange();
    });
    teardown = () => {
      subscription.remove();
      offInvalidations();
      offFlushes();
      if (changeTimer !== null) clearTimeout(changeTimer);
      changeTimer = null;
      missed = false;
      queued.clear();
      entries.clear();
    };
  };

  const stop = () => {
    teardown?.();
    teardown = null;
  };

  return {
    peek: (key) => entries.get(key),
    subscribe(key, onKeyChange) {
      if (watching === 0) start();
      watching += 1;
      let set = watchers.get(key);
      if (!set) {
        set = new Set();
        watchers.set(key, set);
      }
      set.add(onKeyChange);
      if (!entries.has(key) && !reading.has(key)) enqueue(key);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        const current = watchers.get(key);
        current?.delete(onKeyChange);
        if (current?.size === 0) watchers.delete(key);
        watching -= 1;
        if (watching === 0) stop();
      };
    },
    reset() {
      stop();
      watchers.clear();
      watching = 0;
    },
  };
}
