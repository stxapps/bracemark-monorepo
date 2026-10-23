'use client';

// The per-level guide lines down the left of an indented tree row, one
// `w-6 border-l` span per level of depth. ListCommand is the only web surface
// that draws them — the sidebar and the Lists settings table indent with
// `paddingLeft` — so this is its own leaf for readability, not for sharing.
// bracemark-expo's guide-lines.tsx is the native twin, and that one IS shared:
// the share extension's picker can't import its list-command.tsx.
//
// `-my-2` runs the lines through the row's `py-2` so each spans the FULL row
// height and connects to the next row's. `self-stretch` beats the row's
// `items-center`, which would otherwise collapse each (empty) span to nothing.
//
// `-mr-2` cancels the row's `gap-2` for THIS pair only, and it is what makes
// the lines line up at all. The gap sits between this group and the name, so it
// adds 8 to the name's offset and nothing to the lines: at `w-4` the lines
// landed on 12/28/44 while the names landed on 12/36/52. Only depth 1 agreed —
// and no unit width fixes the rest, because the discrepancy is a constant 8 the
// gap adds once, not a step. With the gap cancelled, a level costs exactly one
// unit on both, so `line_n` IS `text(n-1)`: every line hangs from the left edge
// of the name it belongs to.
//
// `w-6` (24) over `w-4` because 24 is the step the names already had — `w-4`
// plus that `gap-2` — so depth 1 does not move; what changes is depth 2 and
// deeper, which used to step 16 while the first level stepped 24.
// bracemark-expo's guide-lines.tsx is the same pair of numbers.
//
// At most TREE_INDENT_MAX_LEVELS_NARROW of them (@stxapps/shared sync/tree.ts):
// at 24px a level, the four that fit beside a name in a 256px "Move to" submenu.
// Past that a row keeps the indent of the level at it and TreeLevelMarker
// (tree-level-marker.tsx) numbers its level over the last slot — the group is
// `self-stretch`, so the marker is the row's full height and centres its digits
// on the name's line. The bound also caps the elements: every ListCommand row is
// mounted (nothing is virtualized), so a line per level per row was the square
// of a deep chain's length.

import { TREE_INDENT_MAX_LEVELS_NARROW } from '@stxapps/shared';
import { TreeLevelMarker } from '@stxapps/web-ui/components/links/tree-level-marker';

export function GuideLines({ depth }: { depth: number }) {
  return (
    <span aria-hidden className="-my-2 -mr-2 flex self-stretch">
      {Array.from({ length: Math.min(depth, TREE_INDENT_MAX_LEVELS_NARROW) }, (_, i) => (
        <span key={i} className="w-6 border-l border-border" />
      ))}
      <TreeLevelMarker depth={depth} maxLevels={TREE_INDENT_MAX_LEVELS_NARROW} />
    </span>
  );
}
