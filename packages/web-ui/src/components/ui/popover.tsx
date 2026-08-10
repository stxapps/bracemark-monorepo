import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

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
  // Never let the popover outgrow the viewport: cap it at Radix's
  // collision-computed available height (via the max-h below, leaving an 8px
  // gutter) and scroll inside. Same idiom as select/dropdown content. Without
  // this a tall popover — the quick-add form with Advanced open on a
  // short/landscape screen, or the list picker near a screen edge — runs
  // off-screen with its bottom (Save button / last list row) unreachable.
  collisionPadding = 8,
  // Portal to <body> by default. Pass `portal={false}` when the popover opens
  // from inside a modal Dialog: a portalled popover escapes the Dialog's
  // scroll-lock subtree (react-remove-scroll), which then swallows every
  // wheel/touchmove over the popover — mouse-wheel and trackpad scrolling stop
  // working (only dragging the scrollbar thumb still moves it). Rendering inline
  // keeps the popover inside the lock's allowed subtree so scrolling works.
  portal = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { portal?: boolean }) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 flex max-h-(--radix-popover-content-available-height) w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-4 overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
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
