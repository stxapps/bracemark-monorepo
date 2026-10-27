// Specs for the shared per-key read cache behind every FlashList row's favicon and
// preview image (keyed-live-cache.ts). Its whole reason to exist is a COUNT — how
// many reads, and how many re-renders, a scroll costs — and a count is exactly what
// nothing else in the suite sees: a cache that read every key on every mount would
// render the same rows, pass the hooks' specs, and put the per-row query back on the
// scroll's frames. So each case below pins a number of `readMany` calls or of
// notifications, with the value read beside it so a cache that stopped reading
// altogether can't pass on the counts alone.

import { DB_NAME } from './db';
import { createKeyedLiveCache } from './keyed-live-cache';
import { holdLiveReads } from './live-read-invalidation';

// Every `mock`-prefixed binding is closed over by a jest.mock factory below.
const mockListeners = new Set<(event: { databaseFilePath: string; tableName: string }) => void>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (
    listener: (event: { databaseFilePath: string; tableName: string }) => void,
  ) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  },
}));

function emit(tableName: string): void {
  for (const listener of [...mockListeners]) {
    listener({ databaseFilePath: `/data/databases/${DB_NAME}`, tableName });
  }
}

// The store under the cache: a value per key, and a log of every batch asked of it.
function storeOf(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const batches: string[][] = [];
  const cache = createKeyedLiveCache<string, string | null>({
    tables: ['items'],
    readMany: async (keys) => {
      batches.push([...keys].sort());
      return new Map(keys.map((key) => [key, values.get(key) ?? null]));
    },
  });
  return { values, batches, cache };
}

// Microtasks (a batch is queued on one) and then a macrotask (a change refresh is
// coalesced onto one), and the reads both start.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => undefined);

afterEach(() => {
  mockListeners.clear();
});

describe('reads', () => {
  // A fling brings several rows in at once; their keys are one statement, not one
  // each.
  it('batches the keys first asked for together into one read', async () => {
    const { batches, cache } = storeOf({ a: 'A', b: 'B', c: 'C' });
    const off = ['a', 'b', 'c'].map((key) => cache.subscribe(key, () => undefined));
    await settle();

    expect(batches).toEqual([['a', 'b', 'c']]);
    expect(cache.peek('b')?.value).toBe('B');
    off.forEach((unsubscribe) => unsubscribe());
  });

  // THE POINT for a recycling list: a row handed a key the cache holds answers at
  // once — no read, and so no in-flight render before the real one.
  it('answers a key it holds without reading it again', async () => {
    const { batches, cache } = storeOf({ a: 'A' });
    const first = cache.subscribe('a', () => undefined);
    await settle();
    const second = cache.subscribe('a', () => undefined);
    await settle();

    expect(cache.peek('a')?.value).toBe('A');
    expect(batches).toHaveLength(1);
    first();
    second();
  });

  // Unwatched isn't forgotten while something else is still watched: a scroll back
  // up the list finds the rows it passed.
  it('keeps an unwatched key while the cache is live', async () => {
    const { batches, cache } = storeOf({ a: 'A', b: 'B' });
    const keepAlive = cache.subscribe('b', () => undefined);
    cache.subscribe('a', () => undefined)();
    await settle();
    const again = cache.subscribe('a', () => undefined);
    await settle();

    expect(cache.peek('a')?.value).toBe('A');
    expect(batches).toEqual([['a', 'b']]);
    keepAlive();
    again();
  });
});

describe('a write', () => {
  // One refresh for a burst of change events (they fire per ROW written), covering
  // every watched key, telling only the key whose value moved.
  it('re-reads the watched keys once and notifies only the ones that changed', async () => {
    const { values, batches, cache } = storeOf({ a: 'A', b: 'B' });
    const changed = { a: 0, b: 0 };
    const offA = cache.subscribe('a', () => (changed.a += 1));
    const offB = cache.subscribe('b', () => (changed.b += 1));
    await settle();
    changed.a = 0;
    changed.b = 0;
    batches.length = 0;

    values.set('a', 'A2');
    emit('items');
    emit('items');
    emit('items');
    await settle();

    expect(batches).toEqual([['a', 'b']]);
    expect(cache.peek('a')?.value).toBe('A2');
    expect(changed).toEqual({ a: 1, b: 0 });
    offA();
    offB();
  });

  // An unwatched entry would otherwise be served stale on the next mount.
  it('drops what nobody watches, so the next mount reads it fresh', async () => {
    const { values, cache } = storeOf({ a: 'A', b: 'B' });
    const keepAlive = cache.subscribe('b', () => undefined);
    cache.subscribe('a', () => undefined)();
    await settle();

    values.set('a', 'A2');
    emit('items');
    await settle();
    expect(cache.peek('a')).toBeUndefined();

    const again = cache.subscribe('a', () => undefined);
    await settle();
    expect(cache.peek('a')?.value).toBe('A2');
    keepAlive();
    again();
  });

  it('ignores tables it does not read', async () => {
    const { batches, cache } = storeOf({ a: 'A' });
    const off = cache.subscribe('a', () => undefined);
    await settle();
    emit('favicons');
    await settle();

    expect(batches).toHaveLength(1);
    off();
  });

  // A bulk writer's hold (data/live-read-invalidation.ts): nothing re-reads under
  // it, and the change is caught up when it lets go — not lost.
  it('waits out a hold, then catches up', async () => {
    const { values, batches, cache } = storeOf({ a: 'A' });
    const off = cache.subscribe('a', () => undefined);
    await settle();
    batches.length = 0;

    // Released in `finally`: a hold left on keeps its flush interval running, and
    // a failure above would then hang the worker instead of reporting.
    const release = holdLiveReads();
    try {
      values.set('a', 'A2');
      emit('items');
      await settle();
      expect(batches).toHaveLength(0);
    } finally {
      release();
    }
    await settle();
    expect(batches).toEqual([['a']]);
    expect(cache.peek('a')?.value).toBe('A2');
    off();
  });
});

describe('the last watcher leaving', () => {
  // Nothing keeps an entry current once the listener is gone, so the entries go
  // with it rather than outliving it stale.
  it('removes the listener and forgets every entry', async () => {
    const { cache } = storeOf({ a: 'A' });
    const off = cache.subscribe('a', () => undefined);
    await settle();
    expect(mockListeners.size).toBe(1);

    off();
    expect(mockListeners.size).toBe(0);
    expect(cache.peek('a')).toBeUndefined();
  });
});
