'use client';

import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

import {
  type CollisionPadding,
  useCollisionPadding,
} from '@stxapps/web-ui/hooks/use-collision-padding';
import { cn } from '@stxapps/web-ui/lib/utils';

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  // Never let the popover outgrow the room it has: cap it at Radix's
  // collision-computed available height (via the max-h below) and scroll inside.
  // Same idiom as select/dropdown content. Without this a tall popover — the
  // quick-add form with Advanced open on a short/landscape screen, or the list
  // picker near a screen edge — runs off-screen with its bottom (Save button /
  // last list row) unreachable.
  //
  // "The room it has" is the viewport MINUS the safe area, which is why this is
  // a hook and not the bare 8 it used to be: Floating UI clamps to the raw
  // viewport, and under `viewport-fit=cover` that reaches under the notch
  // (useCollisionPadding carries the note). Both the padding and this max-h read
  // from it — the available-height variable Radix exposes is computed from the
  // same collision padding — so the cap and the placement stay in step.
  collisionPadding: collisionPaddingProp,
  // Portal to <body> by default. Pass `portal={false}` when the popover opens
  // from inside a modal Dialog: a portalled popover escapes the Dialog's
  // scroll-lock subtree (react-remove-scroll), which then swallows every
  // wheel/touchmove over the popover — mouse-wheel and trackpad scrolling stop
  // working (only dragging the scrollbar thumb still moves it). Rendering inline
  // keeps the popover inside the lock's allowed subtree so scrolling works.
  portal = true,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Content>, 'collisionPadding'> & {
  // `ring-1 ring-border` below is the panel's EDGE, and in dark mode it is the
  // only thing separating this panel from what it floats on — which is why it is
  // the shared token and not the `foreground/5` whisper it used to be. Two of the
  // three cues a floating panel normally gets are unavailable here: `shadow-2xl`
  // measures APCA Lc 0.0 on a dark surface (a black shadow on near-black), and the
  // fill can't help either, because this popover ALSO opens from inside the
  // quick-add popover and the edit Dialog — both `bg-popover` — so it is the same
  // colour as its own backdrop, Lc 0.0. That left the panel with no boundary at all
  // in dark. See docs/theme.md, _contrast — dark mode, where the edge does the
  // work_; don't drop this back to a foreground/N value on either this or the four
  // sibling surfaces (select, dropdown-menu, dialog, alert-dialog, card).
  collisionPadding?: CollisionPadding;
  portal?: boolean;
}) {
  const collisionPadding = useCollisionPadding(collisionPaddingProp);
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 flex max-h-(--radix-popover-content-available-height) w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-4 overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-1 ring-border outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        className,
      )}
      {...props}
    />
  );
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content;
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-header"
      className={cn('flex flex-col gap-1 text-sm', className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <div data-slot="popover-title" className={cn('text-base font-medium', className)} {...props} />
  );
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="popover-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
