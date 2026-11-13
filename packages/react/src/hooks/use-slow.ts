'use client';

import { useEffect, useState } from 'react';

// True once `active` has stayed true for `delayMs`; false again the moment it turns
// false. For a "loading" state that should explain itself only when it drags on: long
// enough by default that a normal fetch never shows it, so the usual cause past it is
// a file this device never downloaded, opened offline (the reader's copies).
export function useSlow(active: boolean, delayMs = 4000): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);

  return slow;
}
