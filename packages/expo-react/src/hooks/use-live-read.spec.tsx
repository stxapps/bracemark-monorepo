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
//   - …AND ITS KEYED OPT-OUT. `useKeyedLiveRead` is for the caller whose value means nothing
//     under another key: a FlashList-recycled row, handed the next link while it is still
//     holding the previous link's answer. There the beat has to read as "in flight".
//   - THE PAUSE. A covered screen's reads only note a change and catch up when it shows
//     again. One that never catches up shows stale rows once Settings closes.
//   - THE BULK-WRITE HOLD. An import holds live reads so they re-run on a flush every
//     HELD_FLUSH_MS instead of after every write chunk. Too loose and the restore stalls
//     on a re-render per chunk again; too tight and a read that missed a change is never
//     re-run, or the user's own mid-import edit stays hidden until the import ends.
//
// expo-sqlite's change listener is stubbed to a plain emitter — it is the OS seam, and what
// is under test is everything the hook does with its events.

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { LiveReadPause } from '../contexts/live-read-pause';
import { DB_NAME } from '../data/db';
import { HELD_FLUSH_MS, holdLiveReads, invalidateLiveReads } from '../data/live-read-invalidation';
import { useKeyedLiveRead, useLiveRead } from './use-live-read';

type ChangeEvent = {
  databaseName: string;
  databaseFilePath: string;
  tableName: string;
  rowId?: number;
};

// Both carry the `mock` prefix because the jest.mock factory below closes over them.
const mockListeners: ((event: ChangeEvent) => void)[] = [];
const mockRemove = jest.fn();

jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (listener: (event: ChangeEvent) => void) => {
    mockListeners.push(listener);
    return { remove: () => mockRemove() };
  },
}));

function emit(
  tableName: string,
  databaseFilePath = `/data/user/0/com.bracemark.app/databases/${DB_NAME}`,
): void {
  // Native reports the attached SQLite schema here (`main`), not the file name.
  for (const listener of mockListeners) {
    listener({ databaseName: 'main', databaseFilePath, tableName });
  }
}

// One macrotask, which is what the hook defers its re-run by.
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

// The hold is process-wide; a test that fails while holding must not hold the next one.
let releaseHold: (() => void) | undefined;

beforeEach(() => {
  mockListeners.length = 0;
  mockRemove.mockClear();
});

afterEach(() => {
  releaseHold?.();
  releaseHold = undefined;
  jest.useRealTimers();
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
  // THE NATIVE EVENT SHAPE. `databaseName` is `main`; `databaseFilePath` carries
  // `bracemark-data.db`. Confusing the two silently drops every device event and
  // leaves all live reads stale until remount/relaunch.
  it('re-runs the read for the native main-schema event from the data database', async () => {
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

  // Another SQLite database can report the same `main` schema and table name. A read that
  // re-fired on it would run against a store it doesn't watch, for an account context it
  // isn't in.
  it('ignores changes to another database', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('items', '/data/user/0/com.bracemark.app/databases/some-other.db'));
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });

  // A bare DELETE FROM table uses SQLite's truncate optimization. The native
  // sqlite3_update_hook emits no row event for it, so bulk writers use the
  // explicit table channel rather than making a large wipe delete row by row.
  it('re-runs for an explicit invalidation of a named table', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => invalidateLiveReads(['locks', 'items']));
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ignores an explicit invalidation of unrelated tables', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => invalidateLiveReads(['locks', 'favicons']));
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

describe('the bulk-write hold', () => {
  it('notes a change while held and re-runs once when the hold is released', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    releaseHold = holdLiveReads();
    act(() => {
      for (let i = 0; i < 5; i += 1) emit('items');
      invalidateLiveReads(['items']);
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    act(() => releaseHold?.());
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  // The reason for the periodic flush: the app stays usable during an import, and an
  // edit the user makes meanwhile must show within one interval, not after the import.
  it('re-runs on the periodic flush while the hold is still taken', async () => {
    jest.useFakeTimers();
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(1);

    releaseHold = holdLiveReads();
    act(() => emit('items'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(HELD_FLUSH_MS - 1);
    });
    expect(read).toHaveBeenCalledTimes(1);

    // The interval, then the hook's own zero-delay deferral (which the fake clock, like
    // a real one, rounds up to a millisecond).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  // A flush is not a change: a read with nothing missed stays put, so a long import's
  // flushes don't re-run the reads that don't depend on what it writes.
  it('does not re-run a read that missed nothing', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['pending_ops']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    releaseHold = holdLiveReads();
    act(() => emit('items'));
    act(() => releaseHold?.());
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });

  // A screen opened mid-import must not sit blank until the import ends.
  it('never holds the first read', async () => {
    releaseHold = holdLiveReads();

    const { result } = renderHook(() => useLiveRead(async () => 'rows', [], ['items']));

    await waitFor(() => expect(result.current).toBe('rows'));
  });

  // Holds nest (an import inside another bulk writer): only the LAST release flushes,
  // and releasing the same hold twice must not release someone else's.
  it('flushes on the last release only, and each release counts once', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    const outer = holdLiveReads();
    const inner = holdLiveReads();
    releaseHold = outer;
    act(() => emit('items'));
    act(() => {
      inner();
      inner();
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    act(() => outer());
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops listening for flushes on unmount', async () => {
    const read = jest.fn(async () => 1);
    const { unmount } = renderHook(() => useLiveRead(read, [], ['items']));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    releaseHold = holdLiveReads();
    act(() => emit('items'));
    unmount();
    act(() => releaseHold?.());
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('the pause', () => {
  // The pause arrives through context, so each test renders under a wrapper whose
  // `paused` it flips.
  let paused = false;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveReadPause paused={paused}>{children}</LiveReadPause>
  );

  beforeEach(() => {
    paused = false;
  });

  it('notes a change while paused and re-runs once when it lifts', async () => {
    const read = jest.fn(async () => 1);
    const { rerender } = renderHook(() => useLiveRead(read, [], ['items']), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    paused = true;
    rerender(undefined);
    act(() => {
      emit('items');
      emit('items');
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    paused = false;
    rerender(undefined);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not re-run on lift when nothing changed', async () => {
    const read = jest.fn(async () => 1);
    const { rerender } = renderHook(() => useLiveRead(read, [], ['items']), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    paused = true;
    rerender(undefined);
    paused = false;
    rerender(undefined);
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
  });

  // A hold's flush is not a lift: a paused screen stays paused through it, or every
  // flush of an import would re-render the screen the pause is hiding.
  it('stays paused through a hold flush, and catches up when the pause lifts', async () => {
    const read = jest.fn(async () => 1);
    const { rerender } = renderHook(() => useLiveRead(read, [], ['items']), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    paused = true;
    rerender(undefined);
    releaseHold = holdLiveReads();
    act(() => emit('items'));
    act(() => releaseHold?.());
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    paused = false;
    rerender(undefined);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  // Coming back to the links screen during an import reveals it: it catches up at
  // once rather than waiting out the hold's next flush.
  it('catches up at once when the pause lifts mid-hold', async () => {
    const read = jest.fn(async () => 1);
    const { rerender } = renderHook(() => useLiveRead(read, [], ['items']), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    paused = true;
    rerender(undefined);
    releaseHold = holdLiveReads();
    act(() => emit('items'));
    paused = false;
    rerender(undefined);
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  // The first read is never paused: a screen mounted behind another must still
  // have its data when it shows.
  it('never pauses the first read', async () => {
    paused = true;

    const { result } = renderHook(() => useLiveRead(async () => 'rows', [], ['items']), {
      wrapper,
    });

    await waitFor(() => expect(result.current).toBe('rows'));
  });

  it('pauses under any paused ancestor', async () => {
    const read = jest.fn(async () => 1);
    renderHook(() => useLiveRead(read, [], ['items']), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <LiveReadPause paused>
          <LiveReadPause paused={false}>{children}</LiveReadPause>
        </LiveReadPause>
      ),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => emit('items'));
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
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

describe('the keyed read', () => {
  // THE RECYCLED ROW. FlashList hands a mounted row the next link, so the hook instance
  // that answered for one key is asked about another — and useFaviconUri once paired the
  // held `ok` verdict with the NEW host, deriving a path to an icon that was never
  // fetched. Under a key the held value is the previous key's, so it must not be reported.
  it("reports in flight, never the previous key's value, until the new key's read lands", async () => {
    let release: (() => void) | undefined;
    const read = jest.fn((key: string) =>
      key === 'a'
        ? Promise.resolve('value for a')
        : new Promise<string>((resolve) => {
            release = () => resolve(`value for ${key}`);
          }),
    );
    const seen: { key: string; value: string | undefined }[] = [];
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => {
        const value = useKeyedLiveRead(key, read, ['items']);
        seen.push({ key, value });
        return value;
      },
      { initialProps: { key: 'a' } },
    );
    await waitFor(() => expect(result.current).toBe('value for a'));

    rerender({ key: 'b' });
    await flush();
    expect(result.current).toBeUndefined();

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toBe('value for b'));

    // Every render, not just the settled ones: the beat is a single commit.
    expect(seen.filter((s) => s.key === 'b').map((s) => s.value)).not.toContain('value for a');
    expect(read).toHaveBeenLastCalledWith('b');
  });

  // The control for the case above: dropping the held value is for a KEY change only. A
  // re-read under the same key keeps the value on screen while it runs — blanking there
  // would flicker every icon and thumbnail on each sync write to their table.
  it('holds its value through a re-read for the same key', async () => {
    let version = 1;
    const seen: (string | undefined)[] = [];
    const { result } = renderHook(() => {
      const value = useKeyedLiveRead('a', async (key) => `${key} v${version}`, ['items']);
      seen.push(value);
      return value;
    });
    await waitFor(() => expect(result.current).toBe('a v1'));
    const settled = seen.length;

    version = 2;
    act(() => emit('items'));
    await waitFor(() => expect(result.current).toBe('a v2'));

    expect(seen.slice(settled)).not.toContain(undefined);
  });

  // The cost of the rule, pinned so it stays a decision: useLiveRead keeps its last good
  // value when a read throws, and after a key change that value is the OLD key's — so the
  // keyed read stays in flight rather than answering for the wrong key, and the next
  // change event is what retries it.
  it("stays in flight when the new key's read fails, and recovers on the next change", async () => {
    let failing = false;
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useKeyedLiveRead(
          key,
          async (k) => {
            if (failing) throw new Error('database is locked');
            return `value for ${k}`;
          },
          ['items'],
        ),
      { initialProps: { key: 'a' } },
    );
    await waitFor(() => expect(result.current).toBe('value for a'));

    failing = true;
    rerender({ key: 'b' });
    await flush();
    expect(result.current).toBeUndefined();

    failing = false;
    act(() => emit('items'));
    await waitFor(() => expect(result.current).toBe('value for b'));
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
