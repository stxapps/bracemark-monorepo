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
import { holdLiveReads, invalidateLiveReads } from './live-read-invalidation';

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

// The sign-out wipe deletes whole tables, which SQLite does by truncation — no
// update hook, so no change event at all. clearData announces it instead
// (invalidateLiveReads), and a cache that only heard the sqlite listener would
// go on serving the previous account's favicons and image uris to the next one.
describe('an invalidation with no change event', () => {
  it('re-reads the watched keys for a table it reads, and ignores the rest', async () => {
    const { values, batches, cache } = storeOf({ a: 'A' });
    const off = cache.subscribe('a', () => undefined);
    await settle();
    batches.length = 0;

    invalidateLiveReads(['favicons']);
    await settle();
    expect(batches).toHaveLength(0);

    values.delete('a');
    invalidateLiveReads(['items']);
    await settle();
    expect(batches).toEqual([['a']]);
    expect(cache.peek('a')?.value).toBeNull();
    off();
  });
});

// A read built by hand, so a spec can hold it open and decide when it lands.
function deferredStore() {
  const reads: { keys: string[]; resolve: (values: Record<string, string>) => void }[] = [];
  const cache = createKeyedLiveCache<string, string>({
    tables: ['items'],
    readMany: (keys) =>
      new Promise((resolve) => {
        reads.push({
          keys: [...keys].sort(),
          resolve: (values) => resolve(new Map(keys.map((key) => [key, values[key] ?? '']))),
        });
      }),
  });
  return { reads, cache };
}

describe('a read in flight', () => {
  // One batch at a time: a write's re-read waits for the batch already out, so
  // the older answer can never land on top of the newer one.
  it('runs a write’s re-read after it, never beside it, and ends on the newer value', async () => {
    const { reads, cache } = deferredStore();
    const off = cache.subscribe('a', () => undefined);
    await settle();
    expect(reads).toHaveLength(1);

    emit('items');
    await settle();
    expect(reads).toHaveLength(1);

    reads[0].resolve({ a: 'old' });
    await settle();
    expect(reads).toHaveLength(2);
    reads[1].resolve({ a: 'new' });
    await settle();

    expect(cache.peek('a')?.value).toBe('new');
    off();
  });

  // Every watcher gone before the read landed: the listener is down, so nothing
  // would keep that answer current — it is dropped, not cached stale.
  it('drops an answer that lands after the last watcher left', async () => {
    const { reads, cache } = deferredStore();
    const off = cache.subscribe('a', () => undefined);
    await settle();
    expect(reads).toHaveLength(1);
    off();

    reads[0].resolve({ a: 'A' });
    await settle();
    expect(cache.peek('a')).toBeUndefined();
  });

  // …but a row that comes back for the key while it is still being read is
  // answered by that read, not left waiting for one nobody will queue.
  it('answers a key re-watched while its read is still out', async () => {
    const { reads, cache } = deferredStore();
    const first = cache.subscribe('a', () => undefined);
    await settle();
    expect(reads).toHaveLength(1);
    // The only watcher leaves mid-read (the cache tears down) and another
    // arrives (it starts again) before the answer does — a recycle in a list
    // with one row in it.
    first();
    const onChange = jest.fn();
    const off = cache.subscribe('a', onChange);
    await settle();
    expect(reads).toHaveLength(1);

    reads[0].resolve({ a: 'A' });
    await settle();
    expect(cache.peek('a')?.value).toBe('A');
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('a read that fails', () => {
  // A closing store or a signed-out account: the key stays unread rather than
  // being cached as empty, and the next change reads it again.
  it('leaves the key unread, and reads it again on the next change', async () => {
    let fail = true;
    const cache = createKeyedLiveCache<string, string>({
      tables: ['items'],
      readMany: async (keys) => {
        if (fail) throw new Error('database is closed');
        return new Map(keys.map((key) => [key, key.toUpperCase()]));
      },
    });
    const off = cache.subscribe('a', () => undefined);
    await settle();
    expect(cache.peek('a')).toBeUndefined();

    fail = false;
    emit('items');
    await settle();
    expect(cache.peek('a')?.value).toBe('A');
    off();
  });
});
