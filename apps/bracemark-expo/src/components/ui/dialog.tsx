import * as React from 'react';
import { type GestureResponderEvent, Platform, Text, View, type ViewProps } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';
import * as DialogPrimitive from '@rn-primitives/dialog';
import { X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { cn } from '../../lib/utils';
import { Icon } from './icon';
import { NativeOnlyAnimatedView } from './native-only-animated-view';

// react-native-reusables `dialog` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative, and the KeyboardAvoidingView in DialogOverlay below.
// Content renders through @rn-primitives/portal — the root `_layout.tsx` mounts
// the default `<PortalHost />` it lands in.

// Composite components need the wrapper to accept `className` (the note in
// components/landing.tsx) — same as the screens' KeyboardAwareScrollView.
const StyledKeyboardAvoidingView = withUniwind(KeyboardAvoidingView);

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

function DialogOverlay({
  className,
  children,
  onPress,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Overlay>, 'asChild'> & {
  children?: React.ReactNode;
}) {
  const { onOpenChange } = DialogPrimitive.useRootContext();
  // Portaled content inherits no screen insets (docs/safe-area.md), and once
  // DialogContent may fill the height (`max-h-full`) "centred, so it never
  // reaches an unsafe edge" stops being true — a maxed-out dialog puts its
  // title under the dynamic island. So the gutter is the insets PLUS the 8 the
  // `p-2` used to be, applied here because the overlay is the box the dialog
  // centres in. Native only: on web the overlay is `position: fixed` inside a
  // document that already handles this.
  const insets = useSafeAreaInsets();

  function onOverlayPress(event: GestureResponderEvent) {
    onPress?.(event);
    if (event.target === event.currentTarget && !event.isDefaultPrevented()) {
      onOpenChange(false);
    }
  }

  return (
    <FullWindowOverlay>
      <DialogPrimitive.Overlay
        className={cn(
          'absolute top-0 right-0 bottom-0 left-0 z-50 flex items-center justify-center bg-black/50',
          Platform.select({
            web: 'animate-in fade-in-0 fixed cursor-default p-2 *:cursor-auto',
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
        onPress={Platform.select({ web: onOverlayPress, native: onPress })}
        asChild={Platform.OS !== 'web'}
      >
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          {/* THE DIALOG'S OWN KEYBOARD ANSWER, and it belongs here rather than
              in any caller. This subtree is PORTALED to the root PortalHost, so
              it sits outside every screen's KeyboardAwareScrollView and inherits
              nothing from it; without this, a dialog stays centred in the WHOLE
              window while the keyboard covers its bottom third — which for the
              lock dialogs is the Cancel/submit row (docs/safe-area.md,
              docs/soft-keyboard.md, _avoidance_).

              keyboard-controller's KeyboardAvoidingView, NOT react-native's.
              Both were driven on the emulator against a deliberately tall
              dialog: RN's does not move this subtree at all under Android's
              edge-to-edge (its keyboard metrics come from a window resize that
              no longer happens), and it applies a phantom inset once the
              keyboard closes. This one is Reanimated over the root
              KeyboardProvider's WindowInsetsAnimation values, taken from
              CONTEXT — it owns no native view that would have to wrap the
              portal — so the portal boundary doesn't matter and the lift is
              synced to the keyboard's own animation. This is not the case
              docs/safe-area.md rules out: an RN `Modal` is a native window the
              provider's KeyboardControllerView cannot observe, whereas a portal
              stays inside it (on Android literally, and on iOS the
              FullWindowOverlay still reads the app's keyboard).

              It wraps the CENTERING box, not the content: the Overlay is the
              only node here that owns the full height, so padding its bottom by
              the keyboard's height re-centres the dialog in what's left. A KAV
              inside the content-sized DialogContent would have nothing to pad.
              Kept INSIDE the overlay Pressable so the area beside the dialog
              still dismisses — a plain View never becomes the touch responder,
              so presses fall through to the parent.

              The height half of the same problem is answered by `max-h-full` on
              DialogContent below: the lift alone would still let a tall dialog
              overflow off the TOP. The margin is thinner than it looks — an
              iPhone 17 Pro leaves ~566pt above the keyboard, and bulk "Edit
              tags" measures ~520 of it, so a shorter phone or a larger font is
              already over. */}
          <StyledKeyboardAvoidingView
            behavior="padding"
            enabled={Platform.OS !== 'web'}
            className="w-full flex-1 justify-center"
          >
            <NativeOnlyAnimatedView
              entering={FadeIn.delay(50).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
            >
              {children}
            </NativeOnlyAnimatedView>
          </StyledKeyboardAvoidingView>
        </NativeOnlyAnimatedView>
      </DialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}
function DialogContent({
  className,
  portalHost,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  portalHost?: string;
}) {
  return (
    <DialogPortal hostName={portalHost}>
      <DialogOverlay>
        <DialogPrimitive.Content
          className={cn(
            // `gap-6`, matching web-ui's DialogContent. At `gap-4` the step BETWEEN
            // a dialog's blocks (header, body, footer) was the same 16 the blocks
            // use internally, so nothing read as grouped — and every caller that
            // wanted a tier inside its body had nowhere left to go. 24/16/8 is the
            // same scale the Field kit runs on web.
            // `max-h-full` is what keeps a dialog inside the room it actually
            // has. The percentage resolves against the KeyboardAvoidingView in
            // DialogOverlay, whose height IS definite (flex-1 of the overlay,
            // minus the keyboard) — so this one class means "the window, minus
            // the keyboard, minus the overlay's gutter" without measuring
            // anything. Without it the box is content-sized and centred, and a
            // body taller than that space overflows off the TOP, losing the
            // title. A caller whose body can grow pairs this with `shrink` on
            // its own scroller, which is what then absorbs the squeeze
            // (list-command.tsx, bulk-tags-dialog.tsx).
            'z-50 mx-auto flex max-h-full w-full flex-col gap-6 rounded-lg border border-border bg-background p-6 shadow-lg shadow-black/5 sm:max-w-lg',
            Platform.select({
              web: 'animate-in fade-in-0 zoom-in-95 duration-200 web:max-w-[calc(100%-2rem)]',
            }),
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            className={cn(
              'absolute top-4 right-4 rounded opacity-70 active:opacity-100',
              Platform.select({
                web: 'ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none data-[state=open]:bg-accent',
              }),
            )}
            hitSlop={12}
          >
            <Icon
              as={X}
              className={cn('size-4 shrink-0 text-accent-foreground web:pointer-events-none')}
            />
            <Text className="sr-only">Close</Text>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ViewProps) {
  return (
    <View className={cn('flex flex-col gap-2 text-center sm:text-left', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg leading-none font-semibold text-foreground', className)}
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
      className={cn('text-sm text-muted-foreground', className)}
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
