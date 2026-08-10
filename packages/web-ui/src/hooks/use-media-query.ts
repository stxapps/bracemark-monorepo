'use client';
import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Pass the *same* string the CSS uses so JS
 * branching agrees with what Tailwind matched — e.g. `useMediaQuery('(min-width:
 * 48rem)')` mirrors the `md:` breakpoint, scrollbar and all. Re-deriving a
 * breakpoint from a measured width instead drifts by the scrollbar width.
 *
 * SSR: starts `false` and corrects after mount. The boolean is stable across
 * renders, so it won't loop; but for content that would visibly flash, gate it
 * behind a separate `mounted` flag.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync in case the query changed or hydration differed
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
