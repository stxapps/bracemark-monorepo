'use client';

// The CONTAINER half of "Move to": ListCommand (list-command.tsx) in a surface
// that stands on its own, for the widths and the callers where an anchored
// submenu can't. The body is the same picker the editors' ListSelect and the two
// row menus embed — only the box around it differs, which is the whole point of
// keeping it here rather than in each caller.
//
// WHY IT EXISTS. A `DropdownMenuSubContent` at `w-64` (256px) needs its parent
// menu's `min-w-48` (192) plus two 8px collision gutters beside it — 464px of
// demand against a 375px phone. Radix doesn't clip that: the submenu flips, then
// the shift middleware clamps it to the gutter, so it lands on top of the parent
// menu, covering the row it grew out of. Two things the arithmetic doesn't show
// make it worse: a hover-intent submenu is a mouse gesture, and past
// SEARCH_THRESHOLD ListCommand renders a filter input whose soft keyboard the
// floating layer cannot see — Floating UI measures the LAYOUT viewport, which
// the keyboard does not shrink (link-add-surface.tsx's header is the long form
// of this, and docs/safe-area.md, _popups & dialogs_).
//
// TWO CONTAINERS, SPLIT AT `md` — the same fork quick-add makes for the same
// reason. Below it a bottom sheet, thumb-reachable and edge-anchored; at and
// above it a centred dialog. Callers that still have a good anchored surface at
// the wide end (the row menus keep their submenu, where hover-and-pick is the
// better mouse gesture) simply don't render this there.
//
// `wide` IS A PROP, NOT A `useMediaQuery` CALL IN HERE, for two reasons. This
// mounts on interaction, and useMediaQuery seeds `false` and corrects in an
// effect — so an internal call would flash a bottom sheet at a desktop user for
// one frame before swapping to the dialog. Hoisting it to a host that's mounted
// continuously settles the boolean long before anything opens. It also means one
// matchMedia listener per PAGE instead of one per virtualized row.
//
// bracemark-expo does NOT mirror this split: it has no sheet primitive, and
// Dialog is already the idiom for every picker it renders (its move-to-dialog.tsx
// is the counterpart). The two clients agree on the picker, not on its box.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@stxapps/web-ui/components/ui/sheet';

import { ListCommand } from './list-command';

export function MoveToSurface({
  wide,
  title,
  busy,
  onOpenChange,
  value,
  excludeIds,
  disabledIds,
  root,
  onSelect,
}: {
  // Render as a centred dialog (true) or a bottom sheet (false). See the header
  // for why the caller owns this boolean.
  wide: boolean;
  // The accessible name, and the visible heading: "Move to" for a link move,
  // "Move “X” to" where the thing being moved isn't otherwise on screen.
  title: string;
  // While the pick is being written: shown INSTEAD of the picker, and dismissal
  // is refused until it clears. A picker has no submit button — selecting IS
  // submitting — so this is the only place progress can live.
  busy?: string;
  onOpenChange: (open: boolean) => void;
  // Straight through to ListCommand. `onCreate` is deliberately NOT offered:
  // this is a destination picker, and minting a list inside one is a different
  // intent wearing the same clothes (docs/editors.md).
  value?: string;
  excludeIds?: readonly string[];
  disabledIds?: readonly string[];
  root?: { label: string; selected: boolean; onSelect: () => void };
  onSelect: (listId: string) => void;
}) {
  // `bg-transparent p-0`: ListCommand's root is styled to BE a popover (its own
  // background and padding), which it isn't here — the surface already provides
  // both, and doubling them boxes the list inside a second panel.
  const body = busy ? (
    // Progress, not an error — `status` announces politely and doesn't interrupt
    // (docs/accessibility.md; `alert` is for the message that means it failed).
    <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">
      {busy}
    </p>
  ) : (
    <ListCommand
      value={value}
      excludeIds={excludeIds}
      disabledIds={disabledIds}
      root={root}
      onSelect={onSelect}
      className="bg-transparent p-0"
    />
  );

  // One guard for both branches: Escape, the overlay and the ✕ all route here,
  // and none of them may strand a half-written multi-link move.
  const handleOpenChange = (open: boolean) => {
    if (!open && busy) return;
    onOpenChange(open);
  };

  if (wide) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        {/* No description: "Move to" over a list of lists says it. Radix warns
            about a missing one unless it's opted out of explicitly. */}
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">{title}</DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open onOpenChange={handleOpenChange}>
      {/* `max-h-[85dvh]` and the rounded top edge match the quick-add sheet — the
          two bottom sheets on this app should read as one shape. Padding stays
          on the CHILDREN: SheetContent's side variant carries `pb-safe`, and a
          `p-*` in this className would be merged over it, dropping the home-bar
          inset from a surface defined by touching that edge. */}
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="max-h-[85dvh] rounded-t-2xl"
        // The picker is a LIST first and a search box second, so don't summon
        // the keyboard on open: Radix would focus the filter input, and the
        // keyboard it raises covers the rows the sheet exists to show (and
        // can't be measured from here anyway — see the header). Focus moves to
        // the panel instead, NOT nowhere: FocusScope gives the content
        // `tabIndex={-1}` for exactly this, and dropping focus on the body would
        // send a keyboard user back to the top of the page behind the overlay.
        // The wide branch keeps Radix's default — on a desktop, landing in the
        // filter box is the fast path, and there's no keyboard to raise.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
      >
        {/* `pt-5` levels the title with the close button: that button is `top-3`
            at size-8, so its centre is at 28px, and the title is a 16px
            `leading-none` box — the same derivation the quick-add sheet spells
            out. */}
        <SheetHeader className="px-4 pt-5 pb-4">
          <SheetTitle className="truncate">{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
