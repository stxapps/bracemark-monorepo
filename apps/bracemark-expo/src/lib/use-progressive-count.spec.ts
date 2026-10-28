// The tree surfaces' slicing (use-progressive-count.ts). What a regression
// looks like on a device is a frozen screen — every row mounted in the commit
// the tap made — and nothing in jest renders slowly enough to show it, so this
// pins the schedule that prevents it instead.

import { act, renderHook } from '@testing-library/react-native';

import { FIRST_SLICE, SLICE, useProgressiveCount } from './use-progressive-count';

// One requestAnimationFrame under modern fake timers.
const frame = () => act(() => jest.advanceTimersByTime(16));

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a long list mounts a screenful at once and the rest a slice a frame', () => {
  const total = FIRST_SLICE + 2 * SLICE + 3;
  const { result } = renderHook(() => useProgressiveCount(total));

  // The commit the navigation makes carries only the first slice.
  expect(result.current).toBe(FIRST_SLICE);
  frame();
  expect(result.current).toBe(FIRST_SLICE + SLICE);
  frame();
  expect(result.current).toBe(FIRST_SLICE + 2 * SLICE);
  frame();
  expect(result.current).toBe(total);
  // Filled: nothing is left scheduled to move it.
  frame();
  expect(result.current).toBe(total);
});

test('a short list mounts whole in the first commit', () => {
  const { result } = renderHook(() => useProgressiveCount(FIRST_SLICE - 1));
  expect(result.current).toBe(FIRST_SLICE - 1);
});

test('rows a sync adds after the fill arrive in slices too', () => {
  const { result, rerender } = renderHook(({ total }) => useProgressiveCount(total), {
    initialProps: { total: FIRST_SLICE },
  });
  expect(result.current).toBe(FIRST_SLICE);

  const grown = FIRST_SLICE + 3 * SLICE;
  rerender({ total: grown });
  // Not all at once: the commit that brought them carries none of them.
  expect(result.current).toBe(FIRST_SLICE);
  frame();
  expect(result.current).toBe(FIRST_SLICE + SLICE);
  frame();
  frame();
  expect(result.current).toBe(grown);
});
