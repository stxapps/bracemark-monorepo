import { act, renderHook } from '@testing-library/react';

import { useSlow } from './use-slow';

// What this hook buys is that a load which finishes in time never says anything: the
// notice about a copy that "hasn't downloaded yet" must not flash over a normal fetch,
// and must not linger once the load ends.
describe('useSlow', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is false at first, and true once the delay elapses', () => {
    const { result } = renderHook(() => useSlow(true, 4000));
    expect(result.current).toBe(false);

    act(() => void jest.advanceTimersByTime(3999));
    expect(result.current).toBe(false);

    act(() => void jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('waits 4 seconds by default', () => {
    const { result } = renderHook(() => useSlow(true));
    act(() => void jest.advanceTimersByTime(3999));
    expect(result.current).toBe(false);
    act(() => void jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('never fires while inactive', () => {
    const { result } = renderHook(() => useSlow(false, 4000));
    act(() => void jest.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
  });

  // The load finished just in time: the pending timer must be dropped, not left to
  // flip the flag after the copy is already on screen.
  it('drops the timer when the load ends first', () => {
    const { result, rerender } = renderHook(({ active }) => useSlow(active, 4000), {
      initialProps: { active: true },
    });
    act(() => void jest.advanceTimersByTime(3000));
    rerender({ active: false });
    act(() => void jest.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
  });

  it('clears once the load ends, and starts over on the next', () => {
    const { result, rerender } = renderHook(({ active }) => useSlow(active, 4000), {
      initialProps: { active: true },
    });
    act(() => void jest.advanceTimersByTime(4000));
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);

    rerender({ active: true });
    act(() => void jest.advanceTimersByTime(3999));
    expect(result.current).toBe(false);
    act(() => void jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('drops a pending timer on unmount', () => {
    const { unmount } = renderHook(() => useSlow(true, 4000));
    unmount();
    expect(() => act(() => void jest.advanceTimersByTime(10_000))).not.toThrow();
  });
});
