'use client';

// The small per-row action widgets shared by both layouts: the bulk-edit
// checkbox (the options menu's stand-in) and the pinned/note badges. The
// options menu itself is link-row-menu.tsx.

import { Pin, StickyNote } from 'lucide-react';

import { hasPositiveNoteClause } from '@stxapps/shared';
import { type LinkView } from '@stxapps/web-react';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { cn } from '@stxapps/web-ui/lib/utils';

import { useLinksPage } from '../../_contexts/page-provider';
import { useLinksViewState } from '../../_contexts/view-state-provider';

// The bulk-edit selection checkbox, shown while `bulkEditing` is on. Each layout
// places it to fit its form factor, and passes the wrapper's classes to say so —
// `size-8` either way, the ⋯ trigger's footprint, so it reads as a peer of the
// item's other action widgets.
//
// The list gives it a leading-edge column: one checkbox per row at the same x,
// scannable straight down the pane. A CARD has no such column — the equivalent
// slot is the meta line's trailing edge, where the ⋯ menu sits, and a 16px box
// dropped in there shares its line with the favicon, the host and the badges and
// simply isn't found. So the card floats it over the banner's top-leading corner
// instead, on a translucent plate that holds up over a photo and over the hue
// panel alike. That is the same rule the list follows — the item's leading edge —
// and it is where a grid of previews has taught people to look (Photos, Drive,
// Files). The card's own `relative` is what it positions against.
// It toggles the same hoisted selection the item's own click does — the checkbox
// is the visible state plus a small dedicated target, not a separate mechanism.
// Shift-click extends a range over `links` (the displayed order) just like the
// item click. We drive it off the checkbox's `onClick` rather than
// `onCheckedChange` because only the mouse event carries `shiftKey`; keyboard
// activation (space) fires a click with `shiftKey` false, so it still
// plain-toggles.
//
// `stopPropagation` because in bulk mode the item owns a click of its own, and in
// list-layout that handler is on an ANCESTOR of this checkbox: an un-stopped
// click would toggle here and again on the row, landing back where it started —
// a checkbox that visibly does nothing. (In card-layout the handler is on the
// title anchor, a sibling, so there it is only insurance.)
export function LinkRowSelect({
  link,
  links,
  className = 'flex size-8 shrink-0 items-center justify-center',
  checkboxClassName,
}: {
  link: LinkView;
  links: readonly LinkView[];
  className?: string;
  // The control's own size, for the card's corner. `cn` is tailwind-merge, so a
  // `size-*` here replaces the component's `size-4` rather than racing it.
  checkboxClassName?: string;
}) {
  const { selectedLinks, toggleSelected, selectRange } = useLinksViewState();

  return (
    <span className={className}>
      <Checkbox
        className={checkboxClassName}
        checked={selectedLinks.has(link.path)}
        onClick={(e) => {
          e.stopPropagation();
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

// Its sibling for the link's note, used by BOTH layouts. Neither reserves a line
// for the note itself: an inline note would cost its line on every row, noteless
// ones included — and most links have none. (The rows are measured now, so this
// is a design choice rather than the arithmetic it once was: a note line would
// still be dead space on the majority of rows.) So the badge marks that a note
// exists and the text stays one hover (`title`) or one row menu "Edit note"
// away. `title` is why this is a <span> wrapper rather than the bare icon — the
// tooltip needs a box. It must stay NON-INTERACTIVE either way: in the list it
// sits inside the row's <a>, and on a card it sits under the title anchor's
// full-card overlay, lifted just far enough (`relative z-10` on its wrapper
// there) for the tooltip to be reachable.
//
// It carries a MATCHED state, because that "no read-only surface" is exactly what
// an advanced `note` search runs into: every other field a query can name is
// legible on the row (the title verbatim, the host under it), so only a note hit
// lands on a row with no visible reason for being in the result. Lit, the badge
// IS that reason — and the note text is already one hover away.
//
// It reads the query itself rather than taking a prop, for the same reason
// LinkRowSelect reads the selection: one call site, so the two layouts can't
// drift, and the derivation stays in `shared` (hasPositiveNoteClause, which is
// also where the "positive terms only" rule is argued — a `none`-only clause
// matches by ABSENCE and must not light this).
//
// Ink, not a hue. `--primary` is a hair off `--foreground` in this theme (there
// is no brand hue), so the step that reads as "this one is answering your search"
// is muted → full ink — the same lever the topbar's filter dot picked, and one
// that holds in light and dark alike. The `aria-label` moves with it: a colour
// change alone is not a state for a screen reader (docs/accessibility.md).
export function NoteBadge({ note }: { note: string }) {
  const { query } = useLinksPage();
  const matched = hasPositiveNoteClause(query);

  return (
    <span className="flex shrink-0 items-center" title={note}>
      <StickyNote
        className={cn('size-3.5', matched ? 'text-foreground' : 'text-muted-foreground')}
        aria-label={matched ? 'Note matches search' : 'Has note'}
      />
    </span>
  );
}
