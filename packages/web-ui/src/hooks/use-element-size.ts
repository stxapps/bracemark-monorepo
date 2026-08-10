'use client';
import { useEffect, useState } from 'react';

/**
 * Reactive content-box width of `element`, in CSS pixels, via ResizeObserver.
 * Use this over `useWindowSize` when you need the width of a specific container —
 * a scroll region inside a collapsible sidebar, the extension popup — rather than
 * the viewport: the two diverge whenever chrome around the element changes width
 * without the window resizing. The content box excludes padding and the scrollbar
 * gutter, so it's exactly the space a child grid has to lay out in.
 *
 * Pass the ELEMENT itself — typically captured with a callback ref into state
 * (`const [el, setEl] = useState<HTMLElement | null>(null); … ref={setEl}`) — not
 * a RefObject. A RefObject has a stable identity, so an effect keyed on it can't
 * notice `.current` going from null to a node: the observer would attach only if
 * the element happened to be mounted on the first run and never re-attach for a
 * conditionally-rendered / late-mounted container. Keying on the element value
 * re-observes on every mount, unmount, or swap.
 *
 * Returns 0 until the first measurement lands (SSR, the pre-observer first paint,
 * or while `element` is null) — guard callers against a 0 width.
 */
export function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentBoxSize is the padding/scrollbar-excluded inline width; fall back
      // to contentRect where the newer field is unavailable.
      const next = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      setWidth(next);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return width;
}
