// Specs for this platform's stand-in for Dexie's liveQuery. It exists because drizzle's own
// `useLiveQuery` subscribes ONE query builder, while the read layer's entry points each run
// several statements and a JS post-pass — so instead of tracking touched ranges it re-runs
// the whole read on a table change. Four behaviours carry that trade, and each fails
// silently: the screen just shows the wrong thing, or does too much work, with no error.
//
//   - COALESCING. Every ROW of a sync-cycle transaction fires its own change event. Without
//     the deferred, serialized re-run, a 200-row pull would run the read 200 times — the
//     symptom is a janky list during sync, never a failure.
//   - THE TABLE FILTER. Callers name what they touch so an unrelated table's churn
//     (`pending_ops` during a drain) doesn't re-fire every read on screen.
//   - KEEP THE LAST GOOD VALUE. A transient read error must not blank a rendered screen —
//     returning `undefined` on a failure would flash every list empty mid-sync.
//   - THE STALE BEAT. `undefined` until the first read resolves, and the PREVIOUS value for
//     one beat after `deps` change. use-links depends on exactly that to tell a stale page
//     from a fresh one via the echoed page identity, so "clear on deps change" would look
//     tidier and would break paging.
//
// expo-sqlite's change listener is stubbed to a plain emitter — it is the OS seam, and what
// is under test is everything the hook does with its events.

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { DB_NAME } from '../data/db';
import { useLiveRead } from './use-live-read';

type ChangeEvent = { databaseName: string; tableName: string; rowId?: number };

// Both carry the `mock` prefix because the jest.mock factory below closes over them.
const mockListeners: ((event: ChangeEvent) => void)[] = [];
const mockRemove = jest.fn();

jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (listener: (event: ChangeEvent) => void) => {
    mockListeners.push(listener);
    return { remove: () => mockRemove() };
  },
}));

function emit(tableName: string, databaseName = DB_NAME): void {
  for (const listener of mockListeners) listener({ databaseName, tableName });
}

// One macrotask, which is what the hook defers its re-run by.
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

beforeEach(() => {
  mockListeners.length = 0;
  mockRemove.mockClear();
});

describe('the first read', () => {
  it('is undefined until the read resolves, then the value', async () => {
    const { result } = renderHook(() => useLiveRead(async () => 'rows', [], ['items']));

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe('rows'));
  });

  it('runs once on mount, with no change event needed', async () => {
    const read = jest.fn(async () => 1);

    renderHook(() => useLiveRead(read, [], ['items']));

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });
});

describe('change events', () => {
  it('re-runs the read when a named table changes', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('items'));
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  // THE TABLE FILTER. `pending_ops` churns on every write of a sync drain; a read that
  // re-fired on it would re-run for every queued op of a cycle it doesn't depend on.
  it('ignores a table the caller did not name', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('pending_ops'));
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });

  // Several tables can feed one read (the link views join the tag junction), and a change
  // to any of them has to re-run it — a read that watched only the first would go stale on
  // a re-tag with nothing to indicate it.
  it('re-runs for any of the tables the caller named', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items', 'item_tag_ids']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('item_tag_ids'));
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  // The share extension writes to its own database in the same process. A read that
  // re-fired on those would run against tables it doesn't watch, for an account context it
  // isn't in.
  it('ignores changes to another database', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('items', 'some-other.db'));
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });

  // THE COALESCE. Every row of one transaction fires its own event; the burst has to become
  // ONE trailing read, or a 200-row pull runs the read 200 times.
  it('collapses a burst of per-row events into a single re-run', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => {
      for (let i = 0; i < 50; i += 1) emit('items');
    });
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  // …but a change that lands WHILE a read is in flight must not be lost: the read already
  // running was started before that write, so the loop has to run once more or the screen
  // silently sits on pre-write data until something else changes.
  it('runs once more for a change that landed during an in-flight read', async () => {
    let release: (() => void) | undefined;
    const read = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    );

    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('items'));
    await flush();
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await flush();

    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('failures', () => {
  // A transient read error must not blank a rendered screen — returning undefined here
  // would flash every list empty mid-sync, which reads as data loss.
  it('keeps the last good value when a re-read throws', async () => {
    let shouldFail = false;
    const { result } = renderHook(() =>
      useLiveRead(
        async () => {
          if (shouldFail) throw new Error('database is locked');
          return 'rows';
        },
        [],
        ['items'],
      ),
    );
    await waitFor(() => expect(result.current).toBe('rows'));

    shouldFail = true;
    act(() => emit('items'));
    await flush();

    expect(result.current).toBe('rows');
  });

  // …and the next event retries: a failure must not latch the read off for the life of the
  // screen.
  it('retries on the next change event', async () => {
    let shouldFail = true;
    const { result } = renderHook(() =>
      useLiveRead(
        async () => {
          if (shouldFail) throw new Error('database is locked');
          return 'rows';
        },
        [],
        ['items'],
      ),
    );
    await flush();
    expect(result.current).toBeUndefined();

    shouldFail = false;
    act(() => emit('items'));

    await waitFor(() => expect(result.current).toBe('rows'));
  });
});

describe('deps', () => {
  // THE STALE BEAT, and it is deliberate: use-links reads the ECHOED page identity off the
  // held value to tell a stale render from a fresh one. Clearing to `undefined` on a deps
  // change would look tidier and would break paging.
  it('holds the previous value for a beat after the deps change', async () => {
    let query = 'a';
    const { result, rerender } = renderHook(() =>
      useLiveRead(async () => `rows for ${query}`, [query], ['items']),
    );
    await waitFor(() => expect(result.current).toBe('rows for a'));

    query = 'b';
    rerender(undefined);

    expect(result.current).toBe('rows for a');
    await waitFor(() => expect(result.current).toBe('rows for b'));
  });

  // The caller's keys ARE the dependency list; `read` and `tables` identities are
  // deliberately untracked so callers can pass inline literals without memoizing them —
  // tracking them would re-run the read on every single render.
  it('does not re-run for a fresh read function identity alone', async () => {
    const read = jest.fn(async () => 1);
    const { rerender } = renderHook(() => useLiveRead(() => read(), [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    rerender(undefined);
    rerender(undefined);
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('teardown', () => {
  // The listener is process-wide; a screen that unmounts without removing its subscription
  // leaks a read per event, forever, against a component that is gone.
  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useLiveRead(async () => 1, [], ['items']));
    await flush();

    unmount();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  // A read still in flight when the screen unmounts must not set state on the way back —
  // that is React's "update on an unmounted component", and it is a real leak here because
  // the read can outlive the screen by seconds during a sync.
  it('does not apply a read that resolves after unmount', async () => {
    let release: ((value: number) => void) | undefined;
    const { unmount } = renderHook(() =>
      useLiveRead(() => new Promise<number>((resolve) => void (release = resolve)), [], ['items']),
    );
    const noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    unmount();
    await act(async () => {
      release?.(1);
      await Promise.resolve();
    });

    expect(noise).not.toHaveBeenCalled();
    noise.mockRestore();
  });
});
