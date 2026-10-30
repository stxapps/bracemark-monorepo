// The docked links rail's width, resolved from a stored width, the window's shape and
// its width (sidebar-rail-width.ts). Pure arithmetic, but the one place a wrong answer is
// silent: the rail docks at whatever comes back, the card grid subtracts it, and
// nothing renders an error — a 400 rail on an upright 11" iPad just leaves the
// list a phone's width.

import {
  RAIL_STEPS,
  railDragRelease,
  railDragTarget,
  railStepsFor,
  railWidthLabel,
  resolveRailWidth,
  snapRailWidth,
  windowShape,
} from './sidebar-rail-width';

// The module's hook reads the store; these cases never call it.
jest.mock('@stxapps/expo-react', () => ({}));

describe('windowShape', () => {
  // A ⅔ Split View on a landscape iPad is 981×1024: the WINDOW is upright, and it
  // is the window the rail shares.
  it('follows the window, not the device', () => {
    expect(windowShape(1180, 820)).toBe('landscape');
    expect(windowShape(981, 1024)).toBe('portrait');
  });

  it('counts a square window as landscape', () => {
    expect(windowShape(900, 900)).toBe('landscape');
  });
});

describe('the grid', () => {
  it('is 240 to 400 in 40s, each step named', () => {
    expect(RAIL_STEPS).toEqual([240, 280, 320, 360, 400]);
    expect(RAIL_STEPS.map(railWidthLabel)).toEqual([
      'Narrowest',
      'Narrow',
      'Medium',
      'Wide',
      'Widest',
    ]);
  });

  // A stored width is untrusted (another build's grid, a hand edit): it lands on
  // the nearest step, inside the bounds, never between or past them.
  it.each([
    [300, 320],
    [299, 280],
    [100, 240],
    [480, 400],
    [9999, 400],
  ])('snaps %i to %i', (width, expected) => {
    expect(snapRailWidth(width)).toBe(expected);
  });
});

describe('railStepsFor', () => {
  // The 40% limit, at the windows that dock: the wide threshold, the upright 11"
  // iPads, the upright 13", a landscape 11" and 13".
  it.each([
    [768, 280],
    [820, 320],
    [834, 320],
    [1024, 400],
    [1180, 400],
    [1366, 400],
  ])('lets %i dock up to %i', (windowWidth, widest) => {
    const steps = railStepsFor(windowWidth);
    expect(steps[0]).toBe(240);
    expect(steps[steps.length - 1]).toBe(widest);
  });

  // The floor: a rail is never offered nothing, whatever the window.
  it('always offers the narrowest', () => {
    expect(railStepsFor(320)).toEqual([240]);
  });

  // The rail's context carries this array; a new one per call would re-render
  // every consumer whenever the provider renders.
  it('hands back the same array for the same answer', () => {
    expect(railStepsFor(1180)).toBe(railStepsFor(1366));
  });
});

describe('resolveRailWidth', () => {
  it('starts each shape at its own default', () => {
    expect(resolveRailWidth(undefined, 'portrait', 834)).toBe(240);
    expect(resolveRailWidth(undefined, 'landscape', 1180)).toBe(280);
  });

  it('docks at the stored width when the window can give it', () => {
    expect(resolveRailWidth(360, 'landscape', 1180)).toBe(360);
  });

  // Stepped down for this window only — the stored 400 is what a wider window gets
  // back, so nothing here may be written over it.
  it('steps a stored width down to the widest this window offers', () => {
    expect(resolveRailWidth(400, 'portrait', 834)).toBe(320);
  });

  it('snaps a stored width before limiting it', () => {
    expect(resolveRailWidth(345, 'landscape', 1366)).toBe(360);
  });

  // At the threshold the list keeps the 488 bulk-edit-bar.tsx and main.tsx were
  // sized against, whatever was stored.
  it('leaves the list at least 488 at the wide threshold', () => {
    for (const stored of RAIL_STEPS) {
      expect(768 - resolveRailWidth(stored, 'portrait', 768)).toBeGreaterThanOrEqual(488);
    }
  });

  // The ceiling's reason: the 13" on its side keeps three card columns (316
  // each, plus the grid's 16) beside the widest rail.
  it('keeps three card columns on the 13" iPad on its side', () => {
    const pane = 1366 - resolveRailWidth(9999, 'landscape', 1366) - 16;
    expect(Math.floor(pane / 316)).toBe(3);
  });
});

// The grip's drag (sidebar-rail.tsx). The gesture runs natively, so these two are
// the whole of what a drag decides that a spec can reach.
describe('a drag on the grip', () => {
  const all = RAIL_STEPS;
  const upright11 = railStepsFor(820);

  // The rail jumps at each midpoint, not at each step: 19 past 280 is still 280,
  // 21 past is 320.
  it('snaps to the step nearest the finger', () => {
    expect(railDragTarget(280, 19, all)).toBe(280);
    expect(railDragTarget(280, 21, all)).toBe(320);
    expect(railDragTarget(280, -21, all)).toBe(240);
    expect(railDragTarget(240, 160, all)).toBe(400);
  });

  it('goes to the narrower step on a tie', () => {
    expect(railDragTarget(280, 20, all)).toBe(280);
  });

  // However far the finger goes, the rail stops at what this window offers.
  it('stops at the widest step this window offers', () => {
    expect(railDragTarget(320, 400, upright11)).toBe(320);
  });

  // Under half the narrowest — 120 — is the collapse zone; 120 itself is not.
  it('enters the collapse zone under half the narrowest', () => {
    expect(railDragTarget(280, -160, all)).toBe(240);
    expect(railDragTarget(280, -161, all)).toBe('collapse');
  });

  it('collapses, or remembers a new width, on release', () => {
    expect(railDragRelease('collapse', 280)).toBe('collapse');
    expect(railDragRelease(360, 280)).toBe(360);
  });

  // A stored 400 shown as 320 on an upright 11": a drag that starts and ends at
  // 320 must not overwrite the 400, or a wider window never gets it back.
  it('writes nothing for a drag that ends where the rail rests', () => {
    expect(railDragRelease(320, resolveRailWidth(400, 'portrait', 820))).toBeNull();
    expect(railDragRelease(null, 280)).toBeNull();
  });
});
