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
import { Text, TextClassContext } from './text';

// react-native-reusables `alert-dialog` (uniwind variant), copied from the
// registry — see docs/setup.md for why the copy is manual (the CLI needs
// tsconfig path aliases; this app uses relative imports). Local changes vs
// upstream: imports rewritten to relative, plus AlertDialogAction accepts a
// button `variant` (web-ui's alert-dialog does the same — the destroy
// confirmation renders its action destructive), plus the content's radius —
// web-ui's `rounded-4xl`, not the registry's `rounded-lg` (docs/theme.md,
// _the radius scale_), the `bg-black/80` overlay and `bg-popover` surface its
// sibling dialog.tsx took at the same time, and a `text-lg font-medium` title —
// web-ui's alert title is a step LARGER than its dialog title and a weight
// lighter than the registry's (docs/theme.md, _the two kits_). Content renders
// through
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
          'absolute top-0 right-0 bottom-0 left-0 z-50 flex items-center justify-center bg-black/80',
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
            // `max-w-lg` is UNPREFIXED for the reason the sibling dialog.tsx
            // spells out — the overlay's `inset + 8` padding is the gutter, so
            // a `sm:` gate on the cap bought nothing and left a sub-640dp
            // tablet uncapped — reaching the full available width wherever the
            // description was long enough to get there, i.e. wider than the
            // same content on a 640dp one. No `w-full` here, deliberately: this
            // box stays content-sized inside the overlay's `items-center`, so a
            // one-line confirmation hugs its text instead of filling.
            'z-50 flex max-h-full max-w-lg flex-col gap-6 rounded-4xl border border-border bg-popover p-6 shadow-lg shadow-black/5',
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
// Only the gap ports: web's header is a grid with a media-slot machinery that
// has no counterpart on this side, and its centring is gone on BOTH sides now —
// the one caller (features/links/link-destroy-confirm.tsx) interpolates an
// unbounded link title into its description, and centring is a ≤ 2-line device.
// This context reaches the title and description below because they render
// through ui/text's Text; see the note on AlertDialogTitle for why they have to.
function AlertDialogHeader({ className, ...props }: ViewProps) {
  return (
    <TextClassContext.Provider value="text-left">
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

// `asChild` + ui/text's Text, diverging from the registry copy, and the reason
// is invisible at this call site: rn-primitives' Title and Description render
// **react-native's own Text** when `asChild` is absent
// (@rn-primitives/alert-dialog `Component = asChild ? Slot : Text`, and the .web
// build does the same inside its Radix wrapper). That is a bare RN Text one
// delegation away, so it takes none of what ui/text.tsx adds — no `font-sans`,
// meaning Inter silently degrades to the system face; no `maxFontSizeMultiplier`,
// meaning these two strings scale past the app-wide 1.3 cap while everything
// around them stops; no TextClassContext; no heading role. Nothing catches it:
// the classes we pass here still apply, so the colour and weight look right, and
// docs/accessibility.md's audit greps THIS repo for `<Text`, which finds nothing
// because the render is in node_modules. The Slot merges the primitive's
// `role='heading'` onto our Text, and ui/text.tsx spreads `{...props}` last, so
// the role survives. dropdown-menu.tsx's Label carries the same fix; dialog.tsx
// needs a DIFFERENT one — its primitive's native build never destructures
// `asChild`, so the Slot there is inert and the bare Text comes back nested. Do
// not copy this spelling to a fourth primitive without reading what its native
// build does with `asChild`.
// → docs/accessibility.md, _font scaling is an accessibility policy_.
function AlertDialogTitle({
  className,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Title>, 'asChild'>) {
  return (
    <AlertDialogPrimitive.Title asChild>
      <Text className={cn('text-lg font-medium text-foreground', className)} {...props} />
    </AlertDialogPrimitive.Title>
  );
}

function AlertDialogDescription({
  className,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Description>, 'asChild'>) {
  return (
    <AlertDialogPrimitive.Description asChild>
      <Text className={cn('text-sm text-muted-foreground', className)} {...props} />
    </AlertDialogPrimitive.Description>
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
