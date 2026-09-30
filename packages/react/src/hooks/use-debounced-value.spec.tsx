import { act, renderHook } from '@testing-library/react';

import { useDebouncedValue } from './use-debounced-value';

// What this hook buys is the RESET on every change: without it each keystroke would
// schedule its own timer and every one would fire, turning a debounce into a delay
// and putting the username check back to one request per keystroke. That failure is
// invisible from the app — the field still behaves, the answers still land, the only
// symptom is a burst of requests against an endpoint whose per-IP cap is the thing
// the debounce exists to stay under.
describe('useDebouncedValue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // No flash of empty on mount: the first value is the value, so a field rendered
  // with a restored draft doesn't debounce its way up from ''.
  it('starts at the current value', () => {
    const { result } = renderHook(() => useDebouncedValue('alice', 400));
    expect(result.current).toBe('alice');
  });

  it('holds the old value until the delay elapses', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 400), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'ab' });
    act(() => void jest.advanceTimersByTime(399));
    expect(result.current).toBe('a');

    act(() => void jest.advanceTimersByTime(1));
    expect(result.current).toBe('ab');
  });

  // THE property. Typing steadily inside the window must settle ONCE, on the last
  // value — not once per keystroke, and never on an intermediate one.
  it('settles once, on the last value, however fast the changes come', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ value }) => {
        seen.push(useDebouncedValue(value, 400));
        return null;
      },
      { initialProps: { value: 'a' } },
    );

    for (const value of ['al', 'ali', 'alic', 'alice']) {
      rerender({ value });
      act(() => void jest.advanceTimersByTime(100));
    }
    // Every render so far read 'a'. Not a count of them: StrictMode renders twice.
    expect(new Set(seen)).toEqual(new Set(['a']));

    act(() => void jest.advanceTimersByTime(400));
    expect(seen.at(-1)).toBe('alice');
    // 'al', 'ali' and 'alic' were each superseded before their timer fired.
    expect(new Set(seen)).toEqual(new Set(['a', 'alice']));
  });

  // An unmount mid-window must not fire — a setState on a gone component is a warning
  // in dev and a leak in a long session, and the field it fed is already gone.
  it('drops a pending value on unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 400), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'ab' });
    unmount();
    expect(() => act(() => void jest.advanceTimersByTime(1000))).not.toThrow();
  });
});
