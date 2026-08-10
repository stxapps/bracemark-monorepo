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

/**
 * Width of the classic scrollbar in CSS pixels (0 for overlay scrollbars). The
 * gap between the breakpoint-relevant `innerWidth` and the layout `clientWidth`.
 */
export const getScrollbarWidth = (): number => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth);
};
