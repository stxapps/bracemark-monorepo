import { useEffect, useState } from 'react';

// A screenful of rows: enough to fill an iPad's settings table or its docked
// links rail in the first commit, so the slices that follow land below the fold.
export const FIRST_SLICE = 24;
// The rows each later frame adds.
export const SLICE = 16;

// How many of `total` rows to render now — the first FIRST_SLICE at once, then
// SLICE more each frame until all are in. For the surfaces that mount a row per
// list or per tag and are not virtualized: the links sidebar's trees and the
// settings Lists and Tags tables (docs/client-queries.md, _the tree surfaces
// mount every row_).
//
// It does not make a row cheaper; it stops paying for all of them in one
// commit. Rendered at once, `plus-worst`'s 109 lists held the JS thread for
// 1.2 s on the iPad (A16) simulator and 1.4 s on a Pixel 8 emulator as Settings
// switched to them — one stall, with the screen frozen on the section the tap
// left. In slices, the switch paints the header and the first rows straight
// away and the rest arrive over a few frames, each a short block the thread can
// answer a touch between (docs/e2e.md, _the render leg_).
//
// A loading state would not do this: a spinner shown before a single big commit
// freezes with everything else for the length of it.
//
// The count only grows. A shrink (a collapse, a delete) is the slice of a
// shorter list, and a later growth — a new list, a subtree expanded, a sync
// landing — goes in a slice a frame like the first fill did, so the thousandth
// row a pull brings in never arrives as one commit either. The hook's state is
// the component's, so a section that unmounts and remounts (a sidebar section
// collapsed and opened again) fills again from the first slice.
export function useProgressiveCount(total: number): number {
  const [shown, setShown] = useState(FIRST_SLICE);

  useEffect(() => {
    if (shown >= total) return;
    // A frame per slice: the commit lands, the frame paints, the next one adds.
    const frame = requestAnimationFrame(() => setShown((n) => n + SLICE));
    return () => cancelAnimationFrame(frame);
  }, [shown, total]);

  return Math.min(shown, total);
}
