import { act, render } from '@testing-library/react';

import { type CollisionPadding, useCollisionPadding } from './use-collision-padding';

// Drives the REAL chain — `lib/window.ts`'s probe → the window-metrics store →
// this hook — with only `getComputedStyle` faked, because the probe is where the
// insets actually come from and a mocked `useWindowInsets` would assert nothing
// about it.
//
// What is being pinned is the DEFAULT: every Radix floating surface in this
// package gets the safe-area insets plus a gutter unless its caller says
// otherwise. Radix's own default is 0, which under `viewport-fit=cover`
// (bracemark-web's layout) lets a flipped or shifted menu land under the notch or
// the home indicator — visible only in an installed PWA or in landscape, on a
// device, with something open. Nothing about it type-checks or lints
// (docs/safe-area.md, _popups & dialogs_).

const insets = { top: 0, right: 0, bottom: 0, left: 0 };

beforeAll(() => {
  const real = window.getComputedStyle.bind(window);
  // `lib/window.ts` reads the RESOLVED padding of a hidden fixed probe rather
  // than the `env()` custom properties, precisely because several browsers hand
  // those back as the literal `env(...)` string. jsdom resolves neither, so the
  // probe is recognised by the inline style it is created with and answered here.
  jest.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
    const style = (el as HTMLElement).style;
    if (style?.position === 'fixed' && style?.pointerEvents === 'none') {
      return {
        paddingTop: `${insets.top}px`,
        paddingRight: `${insets.right}px`,
        paddingBottom: `${insets.bottom}px`,
        paddingLeft: `${insets.left}px`,
      } as CSSStyleDeclaration;
    }
    return real(el as Element);
  }) as typeof window.getComputedStyle);
});

const setInsets = (next: Partial<typeof insets>) => {
  Object.assign(insets, { top: 0, right: 0, bottom: 0, left: 0 }, next);
};

function probe(override?: CollisionPadding) {
  let value!: CollisionPadding;
  function Probe() {
    value = useCollisionPadding(override);
    return null;
  }
  const view = render(<Probe />);
  return {
    get value() {
      return value;
    },
    rerender: () => view.rerender(<Probe />),
    unmount: view.unmount,
  };
}

beforeEach(() => setInsets({}));

describe('useCollisionPadding', () => {
  it('is the 8px gutter alone when there is no safe area', () => {
    const { value, unmount } = probe();

    expect(value).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    unmount();
  });

  // The case the default exists for: an installed PWA on a device with a dynamic
  // island makes all four insets live. A bare `collisionPadding={8}` clamps a
  // shifted surface to 8px from the RAW viewport edge — i.e. ~51px up inside the
  // island.
  it('adds the gutter on top of live safe-area insets', () => {
    setInsets({ top: 59, bottom: 34 });
    const { value, unmount } = probe();

    expect(value).toEqual({ top: 67, right: 8, bottom: 42, left: 8 });
    unmount();
  });

  it('follows a rotation', () => {
    setInsets({ top: 59, bottom: 34 });
    const view = probe();
    expect(view.value).toEqual({ top: 67, right: 8, bottom: 42, left: 8 });

    // Landscape on the same device: the notch becomes a side inset.
    setInsets({ left: 59, right: 59, bottom: 21 });
    act(() => window.dispatchEvent(new Event('orientationchange')));

    expect(view.value).toEqual({ top: 8, right: 67, bottom: 29, left: 67 });
    view.unmount();
  });

  // The opt-out has to survive a falsy value: `0` means "sit flush against the
  // boundary", and a `override || default` spelling would silently hand back the
  // safe-area default instead — the one override value a caller passes when they
  // have measured that they want none.
  it('honours an explicit 0 rather than falling back to the default', () => {
    setInsets({ top: 59 });
    const { value, unmount } = probe(0);

    expect(value).toBe(0);
    unmount();
  });

  it('passes a per-side override straight through', () => {
    setInsets({ top: 59 });
    const { value, unmount } = probe({ top: 0, bottom: 24 });

    expect(value).toEqual({ top: 0, bottom: 24 });
    unmount();
  });
});
