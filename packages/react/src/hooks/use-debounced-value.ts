'use client';

import { useEffect, useState } from 'react';

// Returns `value` delayed by `delayMs`, resetting the timer on each change.
// Used to throttle the live username-availability query to one request per pause
// in typing rather than one per keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
