import { act, render } from '@testing-library/react';

import { useRootFontScale } from './use-root-font-scale';

// The hook exists because Tailwind v4 builds spacing as well as type out of rem
// against an assumed 16px root, and that 16 is a USER PREFERENCE — so a
// hand-computed pixel budget (a virtualizer's `estimateSize`) drifts out of
// proportion with the rem-built rows it is measuring the moment anyone changes
// their browser's default font size. There is no event for that, which is why
// the reading goes through an observed 1rem-tall probe rather than
// `getComputedStyle(documentElement).fontSize`.
//
// jsdom lays nothing out and has no ResizeObserver, so both are stubbed — but the
// probe's own contract (one element for all consumers, removed when the last one
// goes, hidden from the a11y tree) is asserted against the real DOM it creates.

let rootFontSizePx = 16;
type Observer = { callback: ResizeObserverCallback; targets: Set<Element> };
const observers = new Set<Observer>();

const isProbe = (el: Element) =>
  el instanceof HTMLElement &&
  el.style.position === 'absolute' &&
  el.style.pointerEvents === 'none' &&
  el.getAttribute('aria-hidden') === 'true';

const probeElements = (): HTMLElement[] =>
  Array.from(document.body.children).filter((el): el is HTMLElement => isProbe(el));

beforeAll(() => {
  class StubResizeObserver {
    private entry: Observer;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      observers.delete(this.entry);
    }
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;

  // The probe is declared `height: 1rem`, so its measured height IS the root font
  // size in px. jsdom always measures 0, so answer for it here.
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { height: isProbe(this) ? rootFontSizePx : 0 } as DOMRect;
  });
});

/** A root-font-size change, as the ResizeObserver would deliver it. */
const setRootFontSize = (px: number) => {
  rootFontSizePx = px;
  act(() => {
    for (const observer of observers) {
      observer.callback(
        Array.from(observer.targets, (target) => ({ target }) as ResizeObserverEntry),
        {} as ResizeObserver,
      );
    }
  });
};

function probe() {
  const seen: number[] = [];
  function Probe() {
    seen.push(useRootFontScale());
    return null;
  }
  const view = render(<Probe />);
  return { seen, unmount: view.unmount };
}

beforeEach(() => (rootFontSizePx = 16));

describe('useRootFontScale', () => {
  it('is 1 at the 16px baseline Tailwind assumes', () => {
    const { seen, unmount } = probe();

    expect(seen.at(-1)).toBe(1);
    unmount();
  });

  // The value is a RATIO, not a size: callers multiply a px budget by it. A hook
  // that handed back the raw 20 would make every budget 20× too big, which is
  // exactly the kind of thing that still "works" on the default setting.
  it('reports the ratio, and picks it up on the first render after subscribing', () => {
    rootFontSizePx = 20;
    const { seen, unmount } = probe();

    // Seeded inside `subscribe`, before React re-reads the snapshot — so a
    // non-default setting lands without an explicit notify.
    expect(seen.at(-1)).toBe(1.25);
    unmount();
  });

  it('follows a change to the root font size', () => {
    const { seen, unmount } = probe();
    expect(seen.at(-1)).toBe(1);

    setRootFontSize(24);
    expect(seen.at(-1)).toBe(1.5);

    setRootFontSize(16);
    expect(seen.at(-1)).toBe(1);
    unmount();
  });

  it('falls back to 1 rather than 0 when nothing can be measured', () => {
    rootFontSizePx = 0;
    const { seen, unmount } = probe();

    // A 0 here would multiply every caller's budget to nothing — a virtualizer
    // with `estimateSize: 0` renders an infinite number of rows.
    expect(seen.at(-1)).toBe(1);
    unmount();
  });

  // One probe and one observer for the whole app, however many consumers: this is
  // a module-level store precisely so a page full of consumers doesn't append a
  // page full of hidden divs to <body>.
  it('shares one probe across consumers and removes it with the last one', () => {
    expect(probeElements()).toHaveLength(0);

    const first = probe();
    const second = probe();
    expect(probeElements()).toHaveLength(1);

    first.unmount();
    // Still mounted somewhere, so the probe stays — tearing it down here would
    // leave the remaining consumer unsubscribed and frozen at its last value.
    expect(probeElements()).toHaveLength(1);

    second.unmount();
    expect(probeElements()).toHaveLength(0);
    expect(observers.size).toBe(0);
  });

  // It exists only to be measured. Left in the a11y tree it is an empty node a
  // screen reader walks past on every page.
  it('keeps the probe out of the accessibility tree and out of layout', () => {
    const { unmount } = probe();

    const [el] = probeElements();
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.visibility).toBe('hidden');
    expect(el.style.width).toBe('0px');
    unmount();
  });
});
