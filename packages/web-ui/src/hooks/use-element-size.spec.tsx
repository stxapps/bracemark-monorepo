import { act, render } from '@testing-library/react';

import { useElementWidth } from './use-element-size';

// jsdom lays nothing out and ships no ResizeObserver, so the observer is stubbed
// — but as a real registry, because what this hook has to get right is WHICH
// element is being observed at any moment (see the late-mount case below), and
// that is only visible if the stub remembers.
type Observer = { callback: ResizeObserverCallback; targets: Set<Element>; disconnected: boolean };
const observers: Observer[] = [];

beforeAll(() => {
  class StubResizeObserver {
    private entry: Observer;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), disconnected: false };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
      this.entry.disconnected = true;
    }
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => (observers.length = 0));

/** Deliver a resize to whichever live observer is watching `target`. */
const resize = (target: Element, entry: Partial<ResizeObserverEntry>) => {
  const observer = observers.find((o) => !o.disconnected && o.targets.has(target));
  if (!observer) throw new Error('nothing is observing that element');
  act(() => {
    observer.callback([{ target, ...entry } as ResizeObserverEntry], {} as ResizeObserver);
  });
};

/** The callback-ref-into-state pattern the hook's doc block prescribes. */
function probe(initial: HTMLElement | null) {
  const seen: number[] = [];
  function Probe({ element }: { element: HTMLElement | null }) {
    seen.push(useElementWidth(element));
    return null;
  }
  const view = render(<Probe element={initial} />);
  const setElement = (el: HTMLElement | null) => act(() => view.rerender(<Probe element={el} />));
  return { seen, setElement, unmount: view.unmount };
}

const box = () => document.createElement('div');

describe('useElementWidth', () => {
  it('reports 0 until a measurement lands', () => {
    const el = box();
    const { seen } = probe(el);

    // SSR, the pre-observer first paint, and a null element all look like this —
    // callers have to guard against it, so it must not be some other number.
    expect(seen.at(-1)).toBe(0);
  });

  it('reports the content-box inline size', () => {
    const el = box();
    const { seen } = probe(el);

    resize(el, { contentBoxSize: [{ inlineSize: 320, blockSize: 40 }] });

    expect(seen.at(-1)).toBe(320);
  });

  // `contentBoxSize` is the newer field; the fallback is what keeps this working
  // where only `contentRect` is populated.
  it('falls back to contentRect where contentBoxSize is unavailable', () => {
    const el = box();
    const { seen } = probe(el);

    resize(el, { contentRect: { width: 256 } as DOMRectReadOnly });

    expect(seen.at(-1)).toBe(256);
  });

  // THE REASON THE HOOK TAKES AN ELEMENT AND NOT A RefObject. A RefObject's
  // identity is stable, so an effect keyed on it cannot notice `.current` going
  // from null to a node — the observer would attach only if the element happened
  // to be mounted on the first run, and a conditionally-rendered container (a
  // collapsible sidebar's scroll region, the extension popup) would never be
  // measured at all. It fails silently: the hook keeps returning 0, which is
  // also its legitimate "not measured yet" answer, so a caller guarding for 0
  // just renders the empty state forever.
  it('observes an element that mounts later', () => {
    const { seen, setElement } = probe(null);
    expect(seen.at(-1)).toBe(0);

    const el = box();
    setElement(el);
    resize(el, { contentBoxSize: [{ inlineSize: 480, blockSize: 40 }] });

    expect(seen.at(-1)).toBe(480);
  });

  it('re-observes when the element is swapped, and lets the old one go', () => {
    const first = box();
    const { seen, setElement } = probe(first);
    resize(first, { contentBoxSize: [{ inlineSize: 100, blockSize: 10 }] });
    expect(seen.at(-1)).toBe(100);

    const second = box();
    setElement(second);
    resize(second, { contentBoxSize: [{ inlineSize: 200, blockSize: 10 }] });
    expect(seen.at(-1)).toBe(200);

    // The observer for `first` is torn down, so nothing is left writing a stale
    // container's width into this component's state.
    expect(observers.some((o) => !o.disconnected && o.targets.has(first))).toBe(false);
  });

  it('stops observing on unmount', () => {
    const el = box();
    const { unmount } = probe(el);

    unmount();

    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});
