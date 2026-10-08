import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

// A panel that slides in from an edge — the shape a fixed rail takes when the
// viewport is too narrow to give it a column. Radix `Dialog` underneath (same
// primitive as `dialog.tsx`), so it inherits the portal, the focus trap, the
// Escape/outside-click dismissal and the `aria-modal` wiring; only the geometry
// differs, and that's what `side` picks.
//
// SAFE AREA IS THIS COMPONENT'S JOB, unlike Dialog's. Portaled content mounts on
// `document.body` — outside whatever screen opened it, and bracemark-web insets
// per screen (docs/safe-area.md) — so nothing here inherits insets. A centred dialog
// doesn't care: it never reaches an edge. A sheet is *defined* by reaching one,
// so each side variant carries the per-side padding for the edges it touches
// (docs/safe-area.md, _applying safe area_ — the per-side case, where a bar
// bleeds to the edge with only its contents inset, rather than the whole-surface
// blanket). Padding paints inside the box, so the panel's background still
// bleeds under the notch while its content clears it.

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/50 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

// The four edges. Each variant sets the axis it fills, the axis it sizes, the
// border facing the content it covers, the slide it animates, and the safe-area
// padding for the edges it actually touches (a left sheet spans top-to-bottom,
// so it needs all three of top/bottom/left).
//
// NONE OF THEM SETS A FILL — that is SheetContent's base, `bg-popover`, on every
// side. A sheet is by construction a panel over the `bg-black/50` scrim above,
// and in dark the page's own colour leaves it nothing to stand on: the scrim
// cannot darken a 0.145 page, so a `bg-background` panel measured APCA Lc 0.7
// against its own backdrop (75 in light). `bg-popover` is the fill every other
// floating surface has (docs/theme.md, _elevation_).
//
// The fill used to be `bottom`'s alone, with left and right left on the page's
// colour because they are rails — the page's sidebar arriving from an edge —
// whose full-height `border-r` cannot be mistaken for a row divider the way a
// bottom sheet's `border-t` can. True, and still not enough: that hairline
// (Lc 9.5) was then the ONLY thing separating the drawer from the page in dark,
// one 1px line down the screen with the same colour on both sides of it. A rail
// is the page's colour where it is a COLUMN of the page (bracemark-web's
// `links/_panes/sidebar.tsx` `<aside>`, which stays `bg-background`); slid over
// a scrim it is a floating surface like any other, and takes the fill and the
// edge together (Lc 13.0 for the edge on the lifted fill).
const SIDES = {
  left: 'inset-y-0 left-0 h-full w-3/4 max-w-sm border-r pt-safe pb-safe pl-safe data-open:slide-in-from-left data-closed:slide-out-to-left',
  right:
    'inset-y-0 right-0 h-full w-3/4 max-w-sm border-l pt-safe pr-safe pb-safe data-open:slide-in-from-right data-closed:slide-out-to-right',
  top: 'inset-x-0 top-0 h-auto border-b pt-safe pr-safe pl-safe data-open:slide-in-from-top data-closed:slide-out-to-top',
  bottom:
    'inset-x-0 bottom-0 h-auto border-t pr-safe pb-safe pl-safe data-open:slide-in-from-bottom data-closed:slide-out-to-bottom',
} as const;

// The corner X, and `onClose` the guarded-editor escape hatch — dialog.tsx's
// DialogCloseButton verbatim, for the same reason: a caller that swallows
// `onOpenChange(false)` while dirty (docs/editors.md, invariant 3) cannot tell
// this aimed click from a stray overlay tap, so given `onClose` the button stops
// being a `SheetPrimitive.Close` and calls that directly.
function SheetCloseButton({ onClose }: { onClose?: () => void }) {
  const button = (
    <Button
      type="button"
      data-slot="sheet-close"
      variant="ghost"
      size="icon-sm"
      className="absolute top-3 right-3"
      onClick={onClose}
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </Button>
  );
  return onClose ? button : <SheetPrimitive.Close asChild>{button}</SheetPrimitive.Close>;
}

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  onClose,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: keyof typeof SIDES;
  showCloseButton?: boolean;
  onClose?: () => void;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-sm shadow-lg outline-none',
          'border-border transition ease-in-out data-open:animate-in data-open:duration-300 data-closed:animate-out data-closed:duration-200',
          SIDES[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && <SheetCloseButton onClose={onClose} />}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex shrink-0 flex-col gap-1', className)}
      {...props}
    />
  );
}

// Radix requires a Title for the dialog's accessible name. When the sheet's own
// chrome already says what it is (a nav rail's brand lockup), wrap it in
// `sr-only` rather than dropping it — a nameless dialog is announced as nothing.
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
