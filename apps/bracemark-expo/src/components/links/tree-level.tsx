// The level number a tree row shows once its indent has stopped — web-ui's
// links/tree-level.tsx on native, which carries the reasoning: past the indent
// ceiling (TREE_INDENT_MAX_LEVELS and its narrow twin, @stxapps/shared
// sync/tree.ts) every row sits at one indent, and the number is what keeps a
// chain below it from reading as a column of siblings. Nothing renders until
// `depth` is past `maxLevels`.
//
// It sits IN the indent: the negative margin pulls its box back over the
// indent's last 32pt (every surface's indent past its ceiling is wider than
// that), so the row's content does not move when the number appears. A host
// whose row has a `gap` cancels it with `className` (`-mr-1` under `gap-1`).
//
// 32 (`w-8`) where web's box is 24, because here the digits cannot overflow
// it: Yoga measures a Text against its row parent's width, so a number wider
// than the box wraps or clips rather than spilling left the way web's does.
// Three digits at the 1.3 font-scale cap (docs/accessibility.md, _font
// scaling_) are about 23pt, which a 24pt box less its `pr-1` does not hold.
// Right-aligned either way, so the digits land where web's do.
//
// Shared by the share sheet's picker (through guide-lines.tsx), so it stays a
// presentational leaf with nothing but `ui/text` under it
// (docs/share-sheet.md, _keep index.share.js lean_).

import { View } from 'react-native';

import { cn } from '../../lib/utils';
import { Text } from '../ui/text';

export function TreeLevelMarker({
  depth,
  maxLevels,
  className,
}: {
  depth: number;
  maxLevels: number;
  className?: string;
}) {
  if (depth <= maxLevels) return null;
  return (
    <View
      aria-hidden
      className={cn('-ml-8 w-8 shrink-0 flex-row items-center justify-end pr-1', className)}
    >
      <Text numberOfLines={1} className="text-[10px] text-muted-foreground tabular-nums">
        {depth + 1}
      </Text>
    </View>
  );
}
