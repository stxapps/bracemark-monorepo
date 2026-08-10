'use client';
import { useSyncExternalStore } from 'react';

// Tailwind v4 expresses nearly everything in rem against an assumed 16px root —
// not just font sizes (`--text-sm: 0.875rem`, `--text-xs: 0.75rem`) but SPACING
// too, since `--spacing: 0.25rem` backs every `p-*`, `gap-*`, `h-*`, `size-*`
// (`h-10` compiles to `calc(var(--spacing) * 10)`). Borders are the notable
// exception — `border-2` really is 2px.
//
// That 16px assumption is a USER PREFERENCE, not a constant: browsers expose a
// default-font-size setting that moves the rem baseline, and this app pins no
// root `font-size` (neither bracemark-web's globals.css nor web-ui's styles.css
// declares one), so a rem-built layout really does grow while any raw-pixel
// number computed in JS does not.
//
// Note this is NOT browser zoom, which scales px and rem alike and needs no
// compensation. It's specifically the default-font-size preference.
//
// The native analogue (bracemark-expo's lib/font-scale.ts) looks similar but is NOT
// the same arithmetic: RN has no rem, Uniwind resolves spacing to fixed dp, and
// the OS font scale multiplies fontSize ALONE — so there a budget splits into
// scaled-text and unscaled-box parts, while here it scales as a whole.
const ASSUMED_ROOT_FONT_SIZE = 16;

let probe: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let snapshot = 1;
const listeners = new Set<() => void>();

// The probe is declared `height: 1rem`, so its measured height IS the current
// root font size in px. Reading `getComputedStyle(documentElement).fontSize`
// would give the same number, but there is no event for it changing — an
// observed element is what makes this reactive at all.
const read = (): number => {
  const px = probe?.getBoundingClientRect().height ?? ASSUMED_ROOT_FONT_SIZE;
  return px > 0 ? px / ASSUMED_ROOT_FONT_SIZE : 1;
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);

  if (!probe) {
    probe = document.createElement('div');
    // Out of flow, zero-width, invisible, untabbable, hidden from AT — it
    // exists only to be measured and must not affect layout or the a11y tree.
    probe.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:1rem;visibility:hidden;pointer-events:none';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
    // Seed before the observer's first callback. React re-reads the snapshot
    // right after subscribing, so a value that differs from the SSR default
    // still lands without an explicit notify here.
    snapshot = read();
    observer = new ResizeObserver(() => {
      const next = read();
      if (next === snapshot) return;
      snapshot = next;
      for (const notify of listeners) notify();
    });
    observer.observe(probe);
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size > 0) return;
    observer?.disconnect();
    probe?.remove();
    observer = null;
    probe = null;
  };
};

/**
 * The browser's root font size as a RATIO of the 16px Tailwind assumes — 1 at
 * the default, 1.25 if the user set 20px, and so on. Multiply any hand-computed
 * pixel budget that measures rem-built content by this to keep the box and its
 * contents in proportion.
 *
 * ONLY for budgets that must exist as a JS number — a virtualizer's
 * `estimateSize`, which has to be px because TanStack Virtual compares its
 * offsets against `scrollElement.scrollTop`. Anything you can express in CSS
 * should just BE rem and scale on its own, needing nothing from this hook;
 * reaching for it in markup would mean re-implementing rem by hand.
 *
 * Returns 1 during SSR and on the first client render, then re-renders with the
 * real ratio once measured — so it is hydration-safe, but a caller that paints
 * a fixed height will do one frame at the 16px baseline before correcting.
 */
export function useRootFontScale(): number {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => 1,
  );
}
