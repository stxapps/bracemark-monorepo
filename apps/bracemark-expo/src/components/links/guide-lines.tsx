// The per-level guide lines down the left of an indented tree row — web-ui's
// ListCommand rendered literally, one `w-6 border-l` view per level of depth.
// Both list pickers draw them: the in-app ListCommand and the share sheet's
// snapshot-fed copy, which is why this is its own leaf module rather than an
// export of either (the share bundle may reach a presentational file under
// components/links — it already takes TagPickerRows — but not list-command.tsx,
// whose live `useLists` read is the whole thing that file is kept away from.
// docs/share-sheet.md, _keep index.share.js lean_).
//
// THE INDENT IS THE LINES, which is the point of porting them rather than the
// number: this used to be `paddingLeft: depth * 12 + 12` on the row, a step of
// 12 against web's 16 and no line at all. Depth read as "this name starts
// further right", with nothing tying a child to the parent it belongs to.
//
// `-my-2.5` cancels the row's own `py-2.5` so each line spans the FULL row
// height. That is what makes a column of them read as one continuous guide:
// rows stack with no gap, so a line that stopped at the padding box would break
// every 44pt. Web says `-my-2` over its `py-2` for the same reason — the number
// differs because native rows are a step taller, the cancel does not.
//
// `self-stretch` beats the row's `items-center`, and it has to: centred, each
// line would collapse to the height of its own (empty) content and paint
// nothing. There is no width here beyond the views' own, so a row with no depth
// renders none of this and keeps its plain `px-3`.
//
// `-mr-2` CANCELS THE ROW'S `gap-2` for this pair, and without it the lines
// cannot align at any unit width. The gap falls between this group and the name,
// so it adds 8 to the name and nothing to the lines: the names step
// 12/36/60 while the lines would sit at 12/36/60 minus a constant 8 from level 2
// on. Depth 1 looks right either way, which is what makes the rest easy to miss.
// With it cancelled a level costs exactly one unit on both sides, so `line_n` is
// `text(n-1)` — every line hangs from the left edge of the name it belongs to.
// `w-6` is that unit: 24, the step the names already had (`w-4` plus the gap),
// so depth 1 does not move and only depth 2+ changes. web-ui's
// links/guide-lines.tsx carries the same pair and the same derivation.
//
// AT MOST `TREE_INDENT_MAX_LEVELS_NARROW` LINES, whatever `depth` says — the
// four that leave a name room at 24 a level (@stxapps/shared sync/tree.ts).
// Past that a row keeps the indent of the level at it and TreeLevelMarker
// (tree-level.tsx, a leaf the share bundle may reach too) numbers its level
// over the last slot, the full row height like the lines. The bound also caps
// the views: both pickers mount every row in a ScrollView, so a view per level
// per row is the square of a deep `parentId` chain's length — and how deep a
// chain is gets decided by a restored backup or another device, not here.
// web-ui's links/guide-lines.tsx carries the same bound.

import { View } from 'react-native';

import { TREE_INDENT_MAX_LEVELS_NARROW } from '@stxapps/shared';

import { TreeLevelMarker } from './tree-level';

export function GuideLines({ depth }: { depth: number }) {
  return (
    <View aria-hidden className="-my-2.5 -mr-2 flex-row self-stretch">
      {Array.from({ length: Math.min(depth, TREE_INDENT_MAX_LEVELS_NARROW) }, (_, i) => (
        <View key={i} className="w-6 border-l border-border" />
      ))}
      <TreeLevelMarker depth={depth} maxLevels={TREE_INDENT_MAX_LEVELS_NARROW} />
    </View>
  );
}
