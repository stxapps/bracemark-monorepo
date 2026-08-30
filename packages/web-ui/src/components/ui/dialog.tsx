import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

// The corner X. Given `onClose` it is a plain button calling that handler
// directly; otherwise it is a `DialogPrimitive.Close` routing through the
// Root's `onOpenChange`. See DialogContent's `onClose` for why the fork exists.
function DialogCloseButton({ onClose }: { onClose?: () => void }) {
  const button = (
    <Button
      type="button"
      data-slot="dialog-close"
      variant="ghost"
      className="absolute top-4 right-4"
      size="icon-sm"
      onClick={onClose}
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </Button>
  );
  return onClose ? button : <DialogPrimitive.Close asChild>{button}</DialogPrimitive.Close>;
}

// `onClose` is the GUARDED-EDITOR escape hatch, and it exists because Radix
// gives a dialog exactly one close callback. An editor that swallows a close
// while dirty (docs/editors.md, invariant 3) does it in `onOpenChange`, and the
// corner X arrives there alongside Escape and the backdrop — so the guard cannot
// tell an aimed click on a control named Close from a stray click on the
// overlay, and the X goes visibly dead at the moment it is most wanted, with
// nothing to announce the refusal. Passing `onClose` makes the button call the
// caller's UNGUARDED close directly, the way its Cancel does: a deliberate door,
// not an accidental vector. Escape and the backdrop keep going through
// `onOpenChange`, which is the whole point — those are the strays. The same
// division link-add-surface's sheet and bracemark-expo's link-edit-screen draw
// by hand. `showCloseButton={false}` still drops the button entirely.
function DialogContent({
  className,
  children,
  showCloseButton = true,
  onClose,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  onClose?: () => void;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // `max-h-(--dialog-max-h)` is the web counterpart of the `max-h-full` on
        // bracemark-expo's DialogContent, and it lives HERE rather than on the
        // overlay because the two platforms centre a dialog differently: expo's
        // DialogOverlay is a flex box the content centres inside, so the inset
        // gutter can be its padding and a percentage cap resolves against it,
        // whereas Radix places this element itself with `top-1/2 left-1/2
        // -translate-1/2` and leaves the overlay a mere sibling backdrop —
        // there is nothing for a `max-h-full` to resolve against. The token
        // bakes in the doubled-inset arithmetic a transform-centred box needs
        // (web-ui/styles.css). It matters most in an installed PWA, where
        // `display: standalone` (bracemark-web's manifest.json) makes all four
        // insets live and the top one ~59px.
        //
        // The cap does NOT come with `overflow-y-auto`, and that is deliberate
        // rather than an omission — it is the same contract as expo, where a
        // caller whose body can grow pairs the cap with `shrink` on its own
        // scroller. The reason it can't be defaulted here is the `-translate-*`
        // above: a transform makes this element the containing block for
        // `position: fixed` descendants, and Radix's Popper defaults to
        // `strategy: 'fixed'` — so an `overflow` on THIS box (unlike one on any
        // div inside it, which is below the containing block and clips nothing)
        // would newly clip the NON-PORTALLED popovers ListSelect and TagsField
        // open inside the edit dialog, whose whole reason for being inline is
        // the modal scroll-lock (see PopoverContent's `portal` prop). So a
        // growable caller gives ITSELF the scroller, one level in, where it also
        // gets to keep its header and footer pinned: link-edit-dialog.tsx
        // (`flex flex-col` + an inner `min-h-0 flex-1` scroller) and
        // bulk-tags-dialog.tsx (a capped scroller around the chip area) are the
        // two worked examples.
        //
        // The WIDTH cap is one `min()` rather than the usual shadcn pair
        // (`max-w-[calc(100%-2rem)]` capped by a `sm:max-w-*`), because that
        // pair is non-monotonic: below the `sm` breakpoint only the gutter rule
        // applies, and 40rem of viewport minus 2rem is 38rem — WIDER than the
        // 28rem it is capped to the moment `sm` engages. Dragging a window down
        // through 640px made every dialog jump ~160px wider as the window got
        // narrower. `min()` states the two constraints at once — never wider
        // than the cap, never closer than 1rem to either edge — so the width
        // falls monotonically and no breakpoint is involved at all.
        //
        // `--dialog-max-w` is the caller's knob (`[--dialog-max-w:24rem]`) and
        // is deliberately NOT declared in `:root` the way `--dialog-max-h` is:
        // the default belongs to this component, and there is no global value a
        // page would want to set. Being an arbitrary PROPERTY rather than a
        // `max-w-*` class, it is also invisible to tailwind-merge — which is the
        // point. A caller's `sm:max-w-sm` would merge as a different key from an
        // unprefixed base and silently apply only above 640px, leaving the
        // narrow dialogs uncapped across exactly the band this is fixing.
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-(--dialog-max-h) w-full max-w-[min(var(--dialog-max-w,28rem),calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-4xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/5 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && <DialogCloseButton onClose={onClose} />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
