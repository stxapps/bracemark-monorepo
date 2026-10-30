// The row-side read of a KeyedLiveCache (use-keyed-live-cache.ts), against a
// hand-driven cache so each notification is the spec's to fire. The cache's own
// counts are keyed-live-cache.spec.ts's; what is pinned here is the hook's half
// of the contract:
//
//   - a recycled row is never handed the PREVIOUS key's entry;
//   - under a LiveReadPause a change does not re-render the row (the point of
//     the pause: a covered screen doesn't repaint for writes nobody sees) —
//     and lifting the pause shows what changed meanwhile, so nothing missed
//     stays missed;
//   - no key, no subscription.

import { type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react-native';

import { LiveReadPause } from '../contexts/live-read-pause';
import type { CacheEntry, KeyedLiveCache } from '../data/keyed-live-cache';
import { useKeyedLiveCache } from './use-keyed-live-cache';

function fakeCache(initial: Record<string, string>) {
  const entries = new Map<string, CacheEntry<string>>(
    Object.entries(initial).map(([key, value]) => [key, { value }]),
  );
  const watchers = new Map<string, Set<() => void>>();
  const cache: KeyedLiveCache<string, string> = {
    peek: (key) => entries.get(key),
    subscribe(key, onChange) {
      const set = watchers.get(key) ?? new Set();
      watchers.set(key, set);
      set.add(onChange);
      return () => set.delete(onChange);
    },
    reset: () => undefined,
  };
  // A write the cache saw: a new boxed entry, and its watchers told.
  const write = (key: string, value: string) => {
    entries.set(key, { value });
    for (const onChange of watchers.get(key) ?? []) onChange();
  };
  const watching = (key: string) => watchers.get(key)?.size ?? 0;
  return { cache, write, watching };
}

it("hands a recycled row the next key's entry, or nothing — never the previous key's", () => {
  const { cache } = fakeCache({ a: 'A' });
  const { result, rerender } = renderHook(({ key }) => useKeyedLiveCache(cache, key), {
    initialProps: { key: 'a' as string | undefined },
  });
  expect(result.current?.value).toBe('A');

  rerender({ key: 'b' });
  expect(result.current).toBeUndefined();
});

it('re-renders with a changed entry', () => {
  const { cache, write } = fakeCache({ a: 'A' });
  const { result } = renderHook(() => useKeyedLiveCache(cache, 'a'));

  act(() => write('a', 'A2'));
  expect(result.current?.value).toBe('A2');
});

it('subscribes to nothing without a key, and moves its subscription with the key', () => {
  const { cache, watching } = fakeCache({ a: 'A' });
  const { rerender, unmount } = renderHook(({ key }) => useKeyedLiveCache(cache, key), {
    initialProps: { key: undefined as string | undefined },
  });
  expect(watching('a')).toBe(0);

  rerender({ key: 'a' });
  expect(watching('a')).toBe(1);
  rerender({ key: 'b' });
  expect(watching('a')).toBe(0);
  expect(watching('b')).toBe(1);
  unmount();
  expect(watching('b')).toBe(0);
});

describe('under a LiveReadPause', () => {
  let paused = false;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveReadPause paused={paused}>{children}</LiveReadPause>
  );

  beforeEach(() => {
    paused = false;
  });

  it('does not re-render for a change, and shows it once the pause lifts', () => {
    const { cache, write } = fakeCache({ a: 'A' });
    let renders = 0;
    const { result, rerender } = renderHook(
      () => {
        renders += 1;
        return useKeyedLiveCache(cache, 'a');
      },
      { wrapper },
    );
    paused = true;
    rerender({});
    const before = renders;

    act(() => write('a', 'A2'));
    expect(renders).toBe(before);

    paused = false;
    rerender({});
    expect(result.current?.value).toBe('A2');
  });
});
