export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// A single hidden, fixed-position element whose padding is the safe-area insets.
// Reading its *resolved* computed padding gives real pixels — unlike reading the
// `--env-safe-area-inset-*` custom properties, which several browsers hand back
// as the literal `env(...)` string. Created lazily and reused across calls.
let probe: HTMLDivElement | null = null;

/**
 * Current safe-area insets in CSS pixels. Returns zeros during SSR / before the
 * DOM is available. Re-read after orientation changes or `visualViewport`
 * resizes; the value is not reactive on its own.
 */
export const getWindowInsets = (): Insets => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { ...ZERO_INSETS };
  }
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) ' +
      'env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
};

// There is deliberately no `getScrollbarWidth()` here, and re-adding one is a
// trap. The obvious implementation — `innerWidth - documentElement.clientWidth`
// — does not measure the platform's scrollbar; it measures whatever the ROOT
// scroll container is currently reserving, which this repo varies per route:
// `styles.css` reserves a gutter with `scrollbar-gutter: stable` but releases it
// under `[data-no-scrollbar-gutter]`, so the same browser answers 15 on /sign-in
// and 0 on /links. Worse, that flip happens on a client-side navigation, which
// fires no `resize` — so any cached value is stale with no event to invalidate
// it. Measure the specific element you care about with `useElementWidth`
// instead: its content box already excludes that element's own scrollbar, which
// is the number layout math actually wants. → docs/safe-area.md.
