import { useId } from 'react';

/**
 * SSR-stable unique id whose value is also a valid CSS selector.
 *
 * React's built-in `useId` embeds colons (e.g. `:r0:`). Those are valid in an
 * HTML `id` attribute but must be escaped in a CSS selector and are awkward
 * inside SVG `url(#…)` references, so this strips them. An optional `prefix`
 * keeps the rendered id readable when inspecting the DOM.
 *
 * Use it whenever a value is referenced by both an element's `id` and a `url(#…)`
 * (SVG gradients, clip paths, filters) or an `htmlFor`/`aria-*` pairing, so the
 * id stays unique even when the component is rendered many times on one page.
 */
export function useStableId(prefix?: string): string {
  const id = useId().replace(/:/g, '');
  return prefix ? `${prefix}-${id}` : id;
}
