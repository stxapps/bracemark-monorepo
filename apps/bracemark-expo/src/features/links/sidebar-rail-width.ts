import { useSyncExternalStore } from 'react';
import { useWindowDimensions } from 'react-native';

import {
  getSidebarRailWidths,
  type SidebarRailWindowShape,
  subscribeSidebarRailWidths,
} from '@stxapps/expo-react';

// The docked links rail's width: five widths 40 apart, not a continuous drag, and
// remembered per window SHAPE (docs/safe-area.md, _wide windows on native_).
// Docked means at or above WIDE_MIN_WIDTH (lib/window-class.ts) — kept apart
// from that file because this one reads a store and that one is on the iOS share
// extension's import path, which must not reach `@stxapps/expo-react`
// (docs/share-sheet.md). The rail is the user's to step (sidebar-rail.tsx, its
// edge grip). The settings rail is none of this: it has a fixed width of its own
// ((app)/settings/_layout.tsx).
//
// - Steps, because a touch screen has neither the hover that finds web's
//   splitter nor the precision to land a pixel, and because the rail's width
//   feeds the card grid's column count: a free drag would re-compose the grid
//   every frame, a snap re-composes it once. 40 apart because the grip SNAPS as
//   it is dragged — the user drags until it looks right rather than picking
//   from a list — so a finer grid costs nothing and 40 is still a change the
//   eye takes in at each snap.
// - 240 is web's default and the floor: the rows are touch rows, and each list
//   row also carries a 32pt "Lock list" button where web reveals one on hover.
//   280 is the width this rail was fixed at.
// - 400 is web's ceiling, for its reason — past it a wider rail stops buying
//   label and starts costing the list — and here a concrete one: the 13" iPad
//   on its side (1366) keeps three card columns only while the rail is at most
//   402 (main.tsx's MIN_CARD_WIDTH + CARD_H_CHROME, ×3, plus the grid's 16). A
//   name longer than ~40 characters is what holding the row is for
//   (components/ui/peek.tsx), not a wider rail.
// - Per window SHAPE, not device orientation: iPad Split View, Stage Manager and
//   Android freeform windows hand a landscape device a portrait-shaped window
//   (a ⅔ split is 981×1024), and it is the window the rail has to share.
//
// What is stored is the width in points (`sidebar_view.railWidths`), snapped to
// this grid on every read, so a width stored before the grid moved lands on the
// nearest step rather than off it.
//
// As an OVERLAY (below WIDE_MIN_WIDTH, or put away) the rail keeps
// react-navigation's own width (360, or the window minus 56), since there it
// covers the list instead of sharing it.
export type WindowShape = SidebarRailWindowShape;

export const RAIL_WIDTH = { min: 240, max: 400, step: 40 } as const;

// Every width the rail docks at, narrowest first: 240, 280, 320, 360, 400.
export const RAIL_STEPS: readonly number[] = Array.from(
  { length: (RAIL_WIDTH.max - RAIL_WIDTH.min) / RAIL_WIDTH.step + 1 },
  (_, i) => RAIL_WIDTH.min + i * RAIL_WIDTH.step,
);

// What a screen reader announces for each step — the grip's adjustable value. A
// name rather than the number: a point count means nothing heard aloud.
const RAIL_STEP_LABELS = ['Narrowest', 'Narrow', 'Medium', 'Wide', 'Widest'];

export function railWidthLabel(width: number): string {
  return RAIL_STEP_LABELS[RAIL_STEPS.indexOf(width)] ?? `${width} points`;
}

// Where a shape starts before the user steps it. A portrait-shaped window has the
// less width to give, and on the upright 11" iPad (820) only 240 leaves the link
// rows the 576 their date column needs (link-row.tsx).
export const DEFAULT_RAIL_WIDTH: Record<WindowShape, number> = {
  portrait: 240,
  landscape: 280,
};

// The rail's one fraction of the window — web's `max-w-[40vw]`, carried over. A
// step wider than this isn't offered on that window, and a stored one resolves
// down to the widest that is: 768 tops out at 280, the upright 11" iPads (820,
// 834) at 320, the 13" upright (1024) and every landscape iPad at 400. The floor
// is always offered. At the 768 threshold the list keeps at least 488 (768 less
// 280), which bulk-edit-bar.tsx's inline actions and main.tsx's card grid were
// sized against.
const RAIL_MAX_WINDOW_FRACTION = 0.4;

// A square window counts as landscape: it has the width to spare that portrait
// is defined by lacking.
export function windowShape(width: number, height: number): WindowShape {
  return width >= height ? 'landscape' : 'portrait';
}

// Onto the grid: the nearest step, within the floor and the ceiling.
export function snapRailWidth(width: number): number {
  const steps = Math.round((width - RAIL_WIDTH.min) / RAIL_WIDTH.step);
  return Math.min(
    RAIL_WIDTH.max,
    Math.max(RAIL_WIDTH.min, RAIL_WIDTH.min + steps * RAIL_WIDTH.step),
  );
}

// Every answer railStepsFor can give, built once: the rail's context carries the
// array, so a fresh one per render would hand every consumer a new value each
// time the provider renders.
const STEP_PREFIXES = RAIL_STEPS.map((_, i) => RAIL_STEPS.slice(0, i + 1));

// The steps this window can dock, narrowest first; never empty, and the same
// array for the same answer.
export function railStepsFor(windowWidth: number): readonly number[] {
  const max = windowWidth * RAIL_MAX_WINDOW_FRACTION;
  const count = RAIL_STEPS.filter((width, i) => i === 0 || width <= max).length;
  return STEP_PREFIXES[count - 1];
}

// The width the rail docks at: the stored one for this shape (or the shape's
// default), snapped to the grid, then stepped down to the widest this window can
// give. Never written back, so the stored width returns on a window wide enough
// for it.
export function resolveRailWidth(
  stored: number | undefined,
  shape: WindowShape,
  windowWidth: number,
): number {
  const wanted = snapRailWidth(stored ?? DEFAULT_RAIL_WIDTH[shape]);
  const available = railStepsFor(windowWidth);
  return Math.min(wanted, available[available.length - 1]);
}

// --- The grip's drag (features/links/sidebar-rail.tsx, RailWidthHandle) ---
//
// The two decisions a drag makes, kept out of the gesture so they can be pinned
// without a device: the gesture runs natively, and jest's stub of it
// (testing/setup.ts) never calls back.

// Where a drag is: the offered step nearest the width the finger implies (the
// width the drag began at, plus how far it has moved), or the collapse zone once
// it is under half the narrowest — the way web's drag folds the rail shut. A tie
// between two steps goes to the narrower.
export function railDragTarget(
  startWidth: number,
  dx: number,
  steps: readonly number[],
): number | 'collapse' {
  const raw = startWidth + dx;
  if (raw < steps[0] / 2) return 'collapse';
  let best = steps[0];
  for (const width of steps) if (Math.abs(width - raw) < Math.abs(best - raw)) best = width;
  return best;
}

// What letting go commits: collapse, a width to remember, or nothing. Nothing
// when the drag never moved or comes back to the width the rail already rests
// at — writing that would pin this shape to what its window resolved a WIDER
// stored width down to (an upright 11" showing a stored 400 as 320), and the 400
// would never come back on a wider window.
export function railDragRelease(
  target: number | 'collapse' | null,
  settledWidth: number,
): number | 'collapse' | null {
  if (target === null || target === settledWidth) return null;
  return target;
}

/**
 * The docked links rail's width on this window — the stored width for its shape,
 * resolved against it. Reactive to the store (a step taken at the grip) and to
 * the window (rotation, a Split View drag).
 */
export function useRailWidth(): { shape: WindowShape; width: number; steps: readonly number[] } {
  const { width, height } = useWindowDimensions();
  const stored = useSyncExternalStore(subscribeSidebarRailWidths, getSidebarRailWidths);
  const shape = windowShape(width, height);
  return {
    shape,
    width: resolveRailWidth(stored[shape], shape, width),
    steps: railStepsFor(width),
  };
}
