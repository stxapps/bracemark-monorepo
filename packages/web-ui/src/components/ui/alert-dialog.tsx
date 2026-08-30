'use client';

import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: 'default' | 'sm';
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        // `max-h-(--dialog-max-h)`, the same cap DialogContent carries and for
        // the same reason — this box is transform-centred over the viewport, so
        // once its body outgrows the room it has, its title goes under the
        // notch. The one caller today (link-destroy-confirm.tsx) interpolates a
        // link TITLE into its description, which is unbounded, so "an alert
        // dialog is always short" is not a property anything enforces. See
        // dialog.tsx for the full note, including why no `overflow-y-auto` comes
        // with it and where a growable caller puts its scroller instead.
        //
        // The width caps carry `min(…, calc(100%-2rem))` for the same reason
        // DialogContent does, but for the OTHER half of that bug: this box had
        // no gutter rule at all, so `max-w-xs` ran it edge to edge at a 320px
        // viewport — the cap and the viewport are the same 20rem. The `sm:`
        // step here is NOT the non-monotonic pair dialog.tsx describes; it
        // widens 20rem → 28rem as the viewport GROWS, in step with the layout
        // switch the header, footer, title and media slots all make at the same
        // breakpoint for `size=default` (centred and stacked below it,
        // left-aligned beside the media above it). So it stays a breakpoint,
        // and only the gutter is added.
        //
        // Spelled per size rather than through DialogContent's
        // `--dialog-max-w`: the two values belong to the `size` variant, not to
        // the caller, and a token set here by a variant would fight a caller's
        // own `[--dialog-max-w:…]` by source order rather than losing to it
        // cleanly. `data-[size=sm]:max-w-xs` is gone — it was the unprefixed
        // default repeated, since only `default` takes the `sm:` step.
        className={cn(
          'group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid max-h-(--dialog-max-h) w-full max-w-[min(20rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-4xl bg-popover p-6 text-popover-foreground ring-1 ring-foreground/5 duration-100 outline-none data-[size=default]:sm:max-w-[min(28rem,calc(100%-2rem))] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-16 items-center justify-center rounded-full bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        'text-lg font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        'text-sm text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  );
}

function AlertDialogCancel({
  className,
  variant = 'outline',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...props}
      />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
