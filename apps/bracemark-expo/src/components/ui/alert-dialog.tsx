import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';
import * as AlertDialogPrimitive from '@rn-primitives/alert-dialog';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';
import { buttonTextVariants, buttonVariants } from './button';
import { NativeOnlyAnimatedView } from './native-only-animated-view';
import { TextClassContext } from './text';

// react-native-reusables `alert-dialog` (uniwind variant), copied from the
// registry — see docs/setup.md for why the copy is manual (the CLI needs
// tsconfig path aliases; this app uses relative imports). Local changes vs
// upstream: imports rewritten to relative, plus AlertDialogAction accepts a
// button `variant` (web-ui's alert-dialog does the same — the destroy
// confirmation renders its action destructive). Content renders through
// @rn-primitives/portal — the root `_layout.tsx` mounts the default
// `<PortalHost />` it lands in.

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

function AlertDialogOverlay({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Overlay>, 'asChild'> & {
  children?: React.ReactNode;
}) {
  // The insets gutter, identical to DialogOverlay's in dialog.tsx and carrying
  // the same reasoning: this subtree is PORTALED to the root PortalHost, so it
  // sits outside every screen's SafeAreaView and inherits nothing from it, and
  // "centred, so it never reaches an unsafe edge" only held while every alert
  // dialog was short. It isn't: link-destroy-confirm.tsx interpolates a link
  // TITLE — unbounded, and the text scales with the OS font setting while
  // Uniwind's baked-rem padding does not — so its description can outgrow the
  // window, and a centred box that outgrows the window puts its title under the
  // dynamic island. Applied here because the overlay is the box the dialog
  // centres in; the `max-h-full` cap on AlertDialogContent below is the other
  // half. Native only: on web the overlay is `position: fixed` inside a document
  // that already handles this, so `p-2` stays.
  //
  // No KeyboardAvoidingView, unlike dialog.tsx — an alert dialog has no input,
  // so it can't summon a keyboard, and the `max-h-full` below therefore resolves
  // against this box directly rather than against an avoider inside it.
  const insets = useSafeAreaInsets();

  return (
    <FullWindowOverlay>
      <AlertDialogPrimitive.Overlay
        className={cn(
          'absolute top-0 right-0 bottom-0 left-0 z-50 flex items-center justify-center bg-black/50',
          Platform.select({
            web: 'animate-in fade-in-0 fixed p-2',
          }),
          className,
        )}
        style={Platform.select({
          native: {
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom + 8,
            paddingLeft: insets.left + 8,
            paddingRight: insets.right + 8,
          },
        })}
        {...props}
        asChild={Platform.OS !== 'web'}
      >
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(200).delay(50).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          {children}
        </NativeOnlyAnimatedView>
      </AlertDialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}

function AlertDialogContent({
  className,
  portalHost,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  portalHost?: string;
}) {
  return (
    <AlertDialogPortal hostName={portalHost}>
      <AlertDialogOverlay>
        <AlertDialogPrimitive.Content
          className={cn(
            // `gap-6`, matching web-ui's AlertDialogContent — and the sibling
            // dialog.tsx, which carries the note for both.
            // `max-h-full`, ported from DialogContent for the same reason: the
            // percentage resolves against the overlay above, whose height IS
            // definite (`absolute` on all four edges), so this one class means
            // "the window, minus the overlay's inset gutter" without measuring
            // anything. Without it the box is content-sized and centred, and a
            // description taller than that space overflows off the TOP, losing
            // the title — which is the half of the problem the gutter alone
            // cannot reach. A caller whose body can grow pairs this with
            // `shrink` on its own scroller (link-destroy-confirm.tsx), since RN
            // children do not shrink by default.
            'z-50 flex max-h-full flex-col gap-6 rounded-lg border border-border bg-background p-6 shadow-lg shadow-black/5 sm:max-w-lg',
            Platform.select({
              web: 'animate-in fade-in-0 zoom-in-95 duration-200 web:max-w-[calc(100%-2rem)]',
            }),
            className,
          )}
          {...props}
        />
      </AlertDialogOverlay>
    </AlertDialogPortal>
  );
}

// `gap-1.5`, matching web-ui's AlertDialogHeader — deliberately tighter than the
// `gap-2` both platforms' plain `DialogHeader` uses. An alert dialog's description
// is one clause finishing the sentence its title starts ("Delete permanently?" /
// "…can't be undone"), where a dialog's is a standalone line, so it binds closer.
// Only the gap ports: web's header is a grid with a centering and media-slot
// machinery that has no counterpart on this side.
function AlertDialogHeader({ className, ...props }: ViewProps) {
  return (
    <TextClassContext.Provider value="text-center sm:text-left">
      <View className={cn('flex flex-col gap-1.5', className)} {...props} />
    </TextClassContext.Provider>
  );
}

function AlertDialogFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
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
      className={cn('text-lg font-semibold text-foreground', className)}
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
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<VariantProps<typeof buttonVariants>, 'variant'>) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ className, variant })}>
      <AlertDialogPrimitive.Action
        className={cn(buttonVariants({ variant }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ className, variant: 'outline' })}>
      <AlertDialogPrimitive.Cancel
        className={cn(buttonVariants({ variant: 'outline' }), className)}
        {...props}
      />
    </TextClassContext.Provider>
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
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
