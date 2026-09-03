import { act, render } from '@testing-library/react';

import { useVisualViewport, useWindowInsets, useWindowSize } from './use-window-metrics';

// One module-level store backs all three hooks, and its contract is the thing
// worth a spec: each slice keeps a STABLE REFERENCE until its own value changes,
// so `useSyncExternalStore` can bail out of re-rendering a component whose slice
// didn't move. Break that — seed unconditionally with a fresh object literal, or
// reassign a slice on every event — and nothing fails: every hook still returns
// the right numbers. What you lose is invisible in a test that only reads values
// and only shows up on a device, as every consumer in the app re-rendering on
// each of the four events this listens to, several of which fire continuously
// while a keyboard animates or a user pinch-pans.
//
// So these assertions are about RENDER COUNTS and REFERENCE IDENTITY, which is
// the only place that rule is observable.

const setLayoutViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

// jsdom ships no `visualViewport`. This stub is installed per-test so the
// no-API fallback can also be exercised.
type VisualStub = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  scale: number;
  listeners: Set<() => void>;
};
const freshVisual = (init: Partial<VisualStub> = {}): VisualStub => ({
  width: 1024,
  height: 768,
  offsetLeft: 0,
  offsetTop: 0,
  scale: 1,
  listeners: new Set(),
  ...init,
});

// Never null, so the stub's getters need no assertions; `removeVisualViewport`
// takes the API off `window` rather than emptying this.
let visual: VisualStub = freshVisual();

const installVisualViewport = (init: Partial<VisualStub> = {}) => {
  visual = freshVisual(init);
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      get width() {
        return visual.width;
      },
      get height() {
        return visual.height;
      },
      get offsetLeft() {
        return visual.offsetLeft;
      },
      get offsetTop() {
        return visual.offsetTop;
      },
      get scale() {
        return visual.scale;
      },
      addEventListener: (_: string, l: () => void) => visual.listeners.add(l),
      removeEventListener: (_: string, l: () => void) => visual.listeners.delete(l),
    },
  });
};

const removeVisualViewport = () => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
};

/** The on-screen keyboard opening: the visual viewport shrinks, the layout one doesn't. */
const notifyVisualViewport = () =>
  act(() => {
    for (const l of visual.listeners) l();
  });

const shrinkVisualViewport = (height: number) => {
  visual.height = height;
  notifyVisualViewport();
};

const resizeWindow = (width: number, height: number) => {
  setLayoutViewport(width, height);
  act(() => window.dispatchEvent(new Event('resize')));
};

/** Renders all three hooks as separate components, counting each one's renders. */
function renderConsumers() {
  const renders = { size: 0, insets: 0, visual: 0 };
  const last = {} as {
    size: ReturnType<typeof useWindowSize>;
    insets: ReturnType<typeof useWindowInsets>;
    visual: ReturnType<typeof useVisualViewport>;
  };

  function Size() {
    renders.size++;
    last.size = useWindowSize();
    return null;
  }
  function Insets() {
    renders.insets++;
    last.insets = useWindowInsets();
    return null;
  }
  function Visual() {
    renders.visual++;
    last.visual = useVisualViewport();
    return null;
  }

  const view = render(
    <>
      <Size />
      <Insets />
      <Visual />
    </>,
  );
  return { renders, last, unmount: view.unmount };
}

beforeEach(() => {
  setLayoutViewport(1024, 768);
  installVisualViewport();
});

describe('the window-metrics store', () => {
  it('reports the layout viewport and follows a resize', () => {
    const { last, unmount } = renderConsumers();
    expect(last.size).toEqual({ width: 1024, height: 768 });

    resizeWindow(390, 844);
    expect(last.size).toEqual({ width: 390, height: 844 });

    unmount();
  });

  // THE LOAD-BEARING CASE. A soft keyboard opening moves the visual viewport and
  // nothing else — it does not shrink the layout viewport and it does not touch
  // the safe-area insets. Every popup that sizes itself against the visible
  // region has to hear about it; nothing else may re-render, and on a phone this
  // event arrives repeatedly while the keyboard animates.
  it('re-renders only the visual-viewport consumer when only the visual viewport moves', () => {
    const { renders, last, unmount } = renderConsumers();
    const sizeBefore = renders.size;
    const insetsBefore = renders.insets;
    const visualBefore = renders.visual;
    const sizeSliceBefore = last.size;

    shrinkVisualViewport(432);

    expect(last.visual.height).toBe(432);
    expect(renders.visual).toBeGreaterThan(visualBefore);
    expect(renders.size).toBe(sizeBefore);
    expect(renders.insets).toBe(insetsBefore);
    // The slice was not reassigned, which is what let React bail out above.
    expect(last.size).toBe(sizeSliceBefore);

    unmount();
  });

  // The mirror image: a real window resize moves the layout viewport AND (here)
  // the visual one, so both move — but the insets slice still must not be
  // reassigned when the insets themselves didn't change.
  it('keeps the insets slice stable across a resize that does not move them', () => {
    const { renders, last, unmount } = renderConsumers();
    const insetsBefore = renders.insets;
    const insetsSliceBefore = last.insets;

    resizeWindow(390, 844);

    expect(last.size).toEqual({ width: 390, height: 844 });
    expect(last.insets).toBe(insetsSliceBefore);
    expect(renders.insets).toBe(insetsBefore);

    unmount();
  });

  // "Snapshots deliberately survive teardown rather than being reset to the
  // ZERO_* constants: a remount that finds the window unchanged then keeps its
  // references and re-renders nobody." An unconditional seeder inside `subscribe`
  // — which this store used to have alongside `recompute` — hands back a fresh
  // object literal here, and every consumer in a remounted subtree re-renders for
  // nothing. Reference identity across the teardown is the only way to see it.
  it('keeps its slices across a full teardown and remount', () => {
    const first = renderConsumers();
    const sizeSlice = first.last.size;
    const insetsSlice = first.last.insets;
    first.unmount();

    const second = renderConsumers();
    expect(second.last.size).toBe(sizeSlice);
    expect(second.last.insets).toBe(insetsSlice);

    second.unmount();
  });

  it('falls back to the layout viewport where the visualViewport API is missing', () => {
    removeVisualViewport();
    setLayoutViewport(800, 600);

    const { last, unmount } = renderConsumers();

    expect(last.visual).toEqual({
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
    });

    unmount();
  });

  // Pinch-pan and keyboard-push move the visible region without resizing it, so
  // the offsets have to ride the visualViewport `scroll` event as well as its
  // `resize` — a popup positioned against the visible region is otherwise
  // correct in size and wrong in place.
  it('tracks pinch-zoom scale and offsets', () => {
    const { last, unmount } = renderConsumers();

    visual.scale = 2;
    visual.offsetLeft = 120;
    visual.offsetTop = 80;
    notifyVisualViewport();

    expect(last.visual.scale).toBe(2);
    expect(last.visual.offsetLeft).toBe(120);
    expect(last.visual.offsetTop).toBe(80);

    unmount();
  });
});
