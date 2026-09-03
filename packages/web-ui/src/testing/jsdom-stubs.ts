// The browser APIs jsdom does not implement, stubbed just enough for the
// component specs in this package to mount real cmdk and real Radix.
//
// These are SEAMS, not subjects. Nothing in this package's specs asserts on the
// values below — they exist so that rendering a picker or a dialog doesn't throw
// on an API jsdom omits, which is a different thing from testing layout. Where a
// spec does care about a measurement (`use-element-size.spec.tsx`,
// `use-root-font-scale.spec.tsx`, `use-collision-padding.spec.tsx`), it installs
// its own controllable stub instead of using this one — a shared observer that
// silently reports nothing is exactly what would make such a spec pass while
// measuring nothing.

const noop = (): undefined => undefined;

/**
 * Install the no-op DOM APIs cmdk and Radix reach for at mount. Call from a
 * `beforeAll` in any spec that renders one of them.
 */
export function installJsdomStubs(): void {
  if (!('ResizeObserver' in globalThis)) {
    // cmdk observes its list to keep the selected row in view.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      // Nothing is ever measured through this one; a spec that cares about a
      // measurement installs its own observer instead.
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    };
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = noop;
  }

  // Radix's pointer-based dismiss/press handling.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = noop;
    Element.prototype.releasePointerCapture = noop;
  }

  if (!('matchMedia' in window)) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
        dispatchEvent: () => false,
      }),
    });
  }
}
