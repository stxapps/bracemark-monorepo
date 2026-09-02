import { useId } from 'react';

/**
 * SSR-stable unique id restricted to `[A-Za-z0-9_-]`, with an optional readable
 * prefix.
 *
 * React documents `useId`'s return value as opaque and has already changed its
 * shape once — React 18 emitted `:r0:`, React 19 emits `«r0»`. Rather than track
 * that, this normalises whatever React returns down to characters that need no
 * escaping as an HTML `id`, as a CSS selector, or as a URI fragment. Only the
 * format's delimiters fall away; the counter React varies is all in the allowed
 * set, so ids stay unique.
 *
 * This is hardening against an unspecified upstream, not a fix for a known
 * browser bug: both `«r0»` and `:r0:` in fact resolve through `url(#…)` in
 * current Chromium and WebKit. What it buys is that no later reader has to
 * re-derive which of those three contexts React's current format happens to
 * satisfy — and that the next format change is a no-op here rather than a silent
 * one, which is how the colon-only version of this line went stale.
 *
 * Use it whenever a value is referenced by both an element's `id` and a `url(#…)`
 * (SVG gradients, clip paths, filters) or an `htmlFor`/`aria-*` pairing, so the
 * id stays unique even when the component is rendered many times on one page.
 */
export function useStableId(prefix?: string): string {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  return prefix ? `${prefix}-${id}` : id;
}
