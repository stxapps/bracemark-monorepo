// One row's read of a KeyedLiveCache (data/keyed-live-cache.ts): the entry for
// `key`, or undefined while it has never been read — the same "in flight"
// sentinel useKeyedLiveRead reported, so a recycled row is never handed the
// PREVIOUS key's value. What changes is how often that beat happens: a key the
// cache already holds answers in the render that changed the key.
//
// Under a LiveReadPause (contexts/live-read-pause.tsx) the cache's change
// notifications are dropped, so a covered subtree doesn't re-render for writes
// nobody can see — the same contract useLiveRead keeps. The un-pause re-renders
// the reader through the context itself, and that render reads the current
// entry, so nothing missed while paused stays missed.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useLiveReadPaused } from '../contexts/live-read-pause';
import { type CacheEntry, type KeyedLiveCache } from '../data/keyed-live-cache';

const noSubscription = () => () => undefined;

export function useKeyedLiveCache<K, V>(
  cache: KeyedLiveCache<K, V>,
  key: K | undefined,
): CacheEntry<V> | undefined {
  const paused = useLiveReadPaused();
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const subscribe = useCallback(
    (onChange: () => void) =>
      key === undefined
        ? noSubscription()
        : cache.subscribe(key, () => {
            if (!pausedRef.current) onChange();
          }),
    [cache, key],
  );
  const getSnapshot = () => (key === undefined ? undefined : cache.peek(key));
  return useSyncExternalStore(subscribe, getSnapshot);
}
