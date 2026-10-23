// The level number a tree row shows once its indent has stopped — the other
// half of the indent ceiling (TREE_INDENT_MAX_LEVELS and its narrow twin,
// @stxapps/shared sync/tree.ts). Past the ceiling every row sits at the same
// indent, so a chain below it reads as a column of siblings; the number is
// what tells them apart. It renders nothing until `depth` is past `maxLevels`,
// so a tree within the ceiling looks exactly as it did.
//
// It sits IN the indent, not beside it: `-ml-6` pulls its 24px box back over
// the indent's last 24px (every surface's indent past its ceiling is at least
// 4 levels, wider than that), so the row's content does not move by a pixel
// when the number appears — and a drag in the Lists table, where the indent
// stops moving at the ceiling, still shows the projected level changing.
// `justify-end` keeps the digits against the content; a number wider than the
// box (a chain past level 999) overflows leftwards into the indent rather than
// into the name. A host whose row has a `gap` cancels it with `className`
// (`-mr-1` under `gap-1`), so the content keeps its offset there too.
//
// `depth + 1` because the user-facing scale starts at 1 — the same "level" the
// import receipts count in (data-section.tsx, "placed at level 100").
// aria-hidden like the indent it stands in for: no tree surface exposes its
// depth to assistive tech yet, and a bare number read before every deep row's
// name would be noise rather than structure. `bracemark-expo`'s
// components/links/tree-level-marker.tsx is the native twin.

import { cn } from '@stxapps/web-ui/lib/utils';

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
    <span
      aria-hidden
      title={`Level ${depth + 1}`}
      className={cn(
        '-ml-6 flex w-6 shrink-0 items-center justify-end pr-1 text-[10px] leading-none text-muted-foreground tabular-nums',
        className,
      )}
    >
      {depth + 1}
    </span>
  );
}
