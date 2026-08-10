'use client';
import { useSyncExternalStore } from 'react';

import { getScrollbarWidth, getWindowInsets, type Insets } from '../lib/window';

export interface WindowSize {
  width: number;
  height: number;
}

/**
 * The visual viewport — the actually-visible region, shrunk by pinch-zoom and
 * the on-screen keyboard. `offsetLeft/offsetTop` are its offset from the layout
 * viewport (non-zero when pinch-panned or keyboard-pushed); `scale` is the
 * pinch-zoom factor.
 */
export interface VisualViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  scale: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const ZERO_SIZE: WindowSize = { width: 0, height: 0 };
const ZERO_VISUAL: VisualViewport = { width: 0, height: 0, offsetLeft: 0, offsetTop: 0, scale: 1 };

/*
 * One store, one subscription, one DOM read per event — shared by every
 * `useWindowInsets` / `useWindowSize` / `useVisualViewport` / `useScrollbarWidth`
 * consumer in the app. `getWindowInsets`/`getScrollbarWidth` both touch layout
 * (`getComputedStyle`, `clientWidth`), so we measure every slice together once
 * per event rather than once per component.
 *
 * Each slice keeps a stable reference until its own value changes; `useSync-
 * ExternalStore` bails out of re-rendering a component whose slice is `Object.is`
 * unchanged. So a keyboard opening (which moves only the visual viewport)
 * re-renders `useVisualViewport` consumers, not inset or window-size consumers.
 */
const listeners = new Set<() => void>();
let insetsSnapshot: Insets = ZERO_INSETS;
let sizeSnapshot: WindowSize = ZERO_SIZE;
let visualSnapshot: VisualViewport = ZERO_VISUAL;
let scrollbarSnapshot = 0;
let started = false;

const sameInsets = (a: Insets, b: Insets) =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

const sameVisual = (a: VisualViewport, b: VisualViewport) =>
  a.width === b.width &&
  a.height === b.height &&
  a.offsetLeft === b.offsetLeft &&
  a.offsetTop === b.offsetTop &&
  a.scale === b.scale;

const readVisual = (): VisualViewport => {
  const vv = window.visualViewport;
  if (!vv) {
    // No visualViewport API → fall back to the layout viewport, unzoomed.
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
    };
  }
  return {
    width: vv.width,
    height: vv.height,
    offsetLeft: vv.offsetLeft,
    offsetTop: vv.offsetTop,
    scale: vv.scale,
  };
};

const readAll = () => {
  insetsSnapshot = getWindowInsets();
  sizeSnapshot = { width: window.innerWidth, height: window.innerHeight };
  visualSnapshot = readVisual();
  scrollbarSnapshot = getScrollbarWidth();
};

const recompute = () => {
  let changed = false;

  const nextInsets = getWindowInsets();
  if (!sameInsets(nextInsets, insetsSnapshot)) {
    insetsSnapshot = nextInsets;
    changed = true;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width !== sizeSnapshot.width || height !== sizeSnapshot.height) {
    sizeSnapshot = { width, height };
    changed = true;
  }

  const nextVisual = readVisual();
  if (!sameVisual(nextVisual, visualSnapshot)) {
    visualSnapshot = nextVisual;
    changed = true;
  }

  const scrollbar = getScrollbarWidth();
  if (scrollbar !== scrollbarSnapshot) {
    scrollbarSnapshot = scrollbar;
    changed = true;
  }

  if (changed) for (const notify of listeners) notify();
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  if (!started) {
    started = true;
    readAll();
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    window.visualViewport?.addEventListener('resize', recompute);
    // `scroll` keeps offsetLeft/offsetTop current during pinch-pan / keyboard.
    window.visualViewport?.addEventListener('scroll', recompute);
  }
  listeners.add(onStoreChange);

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      started = false;
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
      window.visualViewport?.removeEventListener('resize', recompute);
      window.visualViewport?.removeEventListener('scroll', recompute);
    }
  };
};

/**
 * Reactive safe-area insets in CSS pixels. Re-renders only when an inset value
 * changes (e.g. device rotation). Returns zeros during SSR.
 */
export function useWindowInsets(): Insets {
  return useSyncExternalStore(
    subscribe,
    () => insetsSnapshot,
    () => ZERO_INSETS,
  );
}

/**
 * Reactive layout-viewport size (`innerWidth`/`innerHeight`, scrollbar included —
 * matches what CSS media-query breakpoints see). Returns zeros during SSR.
 */
export function useWindowSize(): WindowSize {
  return useSyncExternalStore(
    subscribe,
    () => sizeSnapshot,
    () => ZERO_SIZE,
  );
}

/**
 * Reactive visual viewport — the visible region after pinch-zoom and the
 * on-screen keyboard. Use this (not `useWindowSize`) to size/position popups so
 * they stay clear of the keyboard. Falls back to the layout viewport where the
 * `visualViewport` API is unavailable. Returns zeros during SSR.
 */
export function useVisualViewport(): VisualViewport {
  return useSyncExternalStore(
    subscribe,
    () => visualSnapshot,
    () => ZERO_VISUAL,
  );
}

/**
 * Reactive classic-scrollbar width in CSS pixels (0 for overlay scrollbars).
 * Returns 0 during SSR.
 */
export function useScrollbarWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => scrollbarSnapshot,
    () => 0,
  );
}
