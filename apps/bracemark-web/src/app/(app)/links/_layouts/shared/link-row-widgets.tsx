'use client';

// The small per-row action widgets shared by both layouts: the bulk-edit
// checkbox (the options menu's stand-in) and the pinned/note badges. The
// options menu itself is link-row-menu.tsx.

import { Pin, StickyNote } from 'lucide-react';

import { type LinkView } from '@stxapps/web-react';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';

import { useLinksViewState } from '../../_contexts/view-state-provider';

// The bulk-edit selection checkbox, shown while `bulkEditing` is on. Each layout
// places it to fit its form factor: the card overlays it at the banner corner
// (where its menu floats), while the list gives it a leading-edge column and
// hides the menu. Sized to the menu trigger's footprint (size-8) so it reads as a
// peer of the row's other action widgets.
// It toggles the same hoisted selection the row's own click does (in bulk mode
// the layouts intercept the anchor click) — the checkbox is the visible state
// plus a small dedicated target, not a separate mechanism. Shift-click extends a
// range over `links` (the displayed order) just like the row click. We drive it
// off the checkbox's `onClick` rather than `onCheckedChange` because only the
// mouse event carries `shiftKey`; keyboard activation (space) fires a click with
// `shiftKey` false, so it still plain-toggles.
export function LinkRowSelect({ link, links }: { link: LinkView; links: readonly LinkView[] }) {
  const { selectedLinks, toggleSelected, selectRange } = useLinksViewState();

  return (
    <span className="flex size-8 shrink-0 items-center justify-center">
      <Checkbox
        checked={selectedLinks.has(link.path)}
        onClick={(e) => {
          if (e.shiftKey) selectRange(link, links);
          else toggleSelected(link);
        }}
        aria-label="Select link"
      />
    </span>
  );
}

// A small pin glyph marking a pinned row at a glance.
export function PinnedBadge() {
  return <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />;
}

// Its sibling for the link's note, used by BOTH layouts. Both are fixed-height
// (the row/card estimate must stay exact for the virtualizer), so an inline note
// would cost its line on every row, noteless ones included — and most links have
// none. So the badge marks that a note exists and the text stays one hover
// (`title`) or one row menu "View note" away. `title` is why this is a <span>
// wrapper rather than the bare icon — the tooltip needs a box, and this sits
// inside the row's <a>, so it must stay non-interactive.
export function NoteBadge({ note }: { note: string }) {
  return (
    <span className="flex shrink-0 items-center" title={note}>
      <StickyNote className="size-3.5 text-muted-foreground" aria-label="Has note" />
    </span>
  );
}
