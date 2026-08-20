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
 *
 * The `false` seed is unconditional ON PURPOSE — it must NOT read `matchMedia`
 * even when `window` exists. A `useState` initializer runs on the client's
 * HYDRATION render too, so seeding from the real value makes the first client
 * render disagree with the server HTML for every visitor the query matches,
 * which is a hydration mismatch rather than a head start. The one frame of
 * `false` is the price, and it is what the `mounted` advice above is for.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync in case the query changed or hydration differed
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * The `md:` breakpoint as a media query — the same string Tailwind matched, so a
 * JS branch and the CSS agree (see above). Shared rather than re-spelled per
 * call site because `md` is where this app changes regime: the topbar's rail
 * becomes a drawer and its search box becomes a summoned row, quick-add's
 * popover becomes a bottom sheet, and the "Move to" pickers give up their
 * anchored submenus. A second literal that drifted by a rem would fork all of
 * that silently.
 */
export const MD_QUERY = '(min-width: 48rem)';
