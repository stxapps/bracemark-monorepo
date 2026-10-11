import * as React from 'react';
import {
  type GestureResponderEvent,
  Keyboard,
  Platform,
  Text as RNText,
  View,
  type ViewProps,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';
import * as DialogPrimitive from '@rn-primitives/dialog';
import { X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { useAppCovered } from '../../contexts/app-cover';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Icon } from './icon';
import { NativeOnlyAnimatedView, POPUP_FADE_MS } from './native-only-animated-view';
import { Text } from './text';

// react-native-reusables `dialog` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative, the KeyboardAvoidingView in DialogOverlay below, the
// keyboard dismissal on DialogContent (on open, and on a chrome tap), the close
// button rebuilt on the kit's Button (DialogCloseButton carries why), and
// `leading-none` dropped from DialogTitle — a leading tighter than Inter's
// natural 1.21 ratio is uncentrable on iOS, so the title sat 1.55pt high inside
// its own box with nothing above it able to help (docs/theme.md, _extending_).
// alert-dialog.tsx's title never carried one, so the two now agree. The
// content's radius is web-ui's `rounded-4xl`, not the registry's `rounded-lg`
// (docs/theme.md, _the radius scale_).
// Three more values came over with it (docs/theme.md, _the two kits_): the
// overlay is `bg-black/80` rather than `/50`, the surface is `bg-popover`
// rather than `bg-background`, and DialogTitle is `text-base font-medium`
// rather than `text-lg font-semibold`. DialogHeader also drops the registry's
// `text-center sm:text-left`, which web-ui does not have. And the fades are
// web-ui's 100ms, in and out, on the overlay and the content alike — the
// registry had 200 in / 150 out on the overlay, and on the content an undated
// FadeIn (Reanimated's 300) behind a 50ms delay; POPUP_FADE_MS in
// native-only-animated-view.tsx. Content renders through @rn-primitives/portal
// — the root `_layout.tsx` mounts the default `<PortalHost />` it lands in. It renders
// nothing while a relock covers the app (contexts/app-cover.tsx).

// Composite components need the wrapper to accept `className` (the note in
// components/landing.tsx) — same as the screens' KeyboardAwareScrollView.
const StyledKeyboardAvoidingView = withUniwind(KeyboardAvoidingView);

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

const FADE_IN = FadeIn.duration(POPUP_FADE_MS).reduceMotion(ReduceMotion.System);
const FADE_OUT = FadeOut.duration(POPUP_FADE_MS).reduceMotion(ReduceMotion.System);

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
          'absolute top-0 right-0 bottom-0 left-0 z-50 flex items-center justify-center bg-black/80',
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
        <NativeOnlyAnimatedView entering={FADE_IN} exiting={FADE_OUT} as="Pressable">
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
              already over.

              `keyboardVerticalOffset` restores the BOTTOM gutter the keyboard
              eats. The avoider pads only its overlap with the keyboard, and the
              keyboard's frame already covers the overlay's `insets.bottom + 8`
              (the home indicator is inside it), so at offset 0 a capped dialog
              sat flush on the keys while the other three edges kept their 8 —
              rounded corners pressed into the keyboard. 8 is that gutter: the
              padding becomes `keyboardHeight − insets.bottom`, leaving exactly 8
              above the keys. The library scales the whole lift by the
              keyboard's progress, so with the keyboard down the offset does
              nothing. The add panel stays flush on purpose — it is an
              edge-attached panel, this is a floating card (docs/soft-keyboard.md). */}
          <StyledKeyboardAvoidingView
            behavior="padding"
            keyboardVerticalOffset={8}
            enabled={Platform.OS !== 'web'}
            className="w-full flex-1 justify-center"
          >
            <NativeOnlyAnimatedView entering={FADE_IN} exiting={FADE_OUT}>
              {children}
            </NativeOnlyAnimatedView>
          </StyledKeyboardAvoidingView>
        </NativeOnlyAnimatedView>
      </DialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}

// The corner X, and `onClose` the guarded-editor escape hatch — web-ui's
// DialogCloseButton and its rationale, ported. An editor that swallows a close
// while dirty (docs/editors.md, invariant 3) does it in `onOpenChange`, which is
// where a `DialogPrimitive.Close` lands too, so the guard cannot tell this aimed
// press on a control named Close from a stray tap on the overlay, and the X goes
// visibly dead at the moment it is most wanted. Given `onClose` the button calls
// that directly, the way its Cancel does — a deliberate door, not an accidental
// vector. bracemark-expo's link-edit-screen already draws the same division by
// hand, with its own header X against `usePreventRemove`.
//
// IT IS THE KIT'S BUTTON, and that is the second half of the port. This was a
// bare `Pressable` wearing `rounded opacity-70 active:opacity-100` — the
// hand-rolled control chrome docs/theme.md's ⚠ rules out — and it had drifted
// exactly the way that rule predicts nobody would notice: a 4px radius that
// belongs to no role in the scale, sitting beside pills; press feedback that was
// an opacity blip on a 16pt glyph rather than the ghost fill every other icon
// button in the app gives; and a box that WAS the glyph, 16pt, which
// `hitSlop={12}` lifted only to 40 — under iOS's 44 and Material's 48
// (docs/accessibility.md). `variant="ghost" size="icon-sm"` is web-ui's
// DialogCloseButton one touch step taller (36 against its 32, the rule the whole
// size scale runs on), the glyph stays web's `size-4`, the colour comes down
// through TextClassContext as web's inherits, and `hitSlop={6}` reaches 48.
//
// `asChild` on the default branch is web's spelling verbatim, and it is safe
// HERE for a reason worth stating: @rn-primitives/dialog's NATIVE Close does
// destructure it (`const Component = asChild ? Slot : Pressable`) where the same
// build's Title does not — see DialogTitle below, which is why that one needed a
// different fix. Do not carry the spelling to a third primitive without reading
// its native build. The `onClose` branch takes no Slot at all: it is the branch
// meant to bypass the primitive, so its press path must not run through one.
function DialogCloseButton({ onClose }: { onClose?: () => void }) {
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      onPress={onClose}
      hitSlop={6}
      className="absolute top-4 right-4"
    >
      <Icon as={X} className="size-4 shrink-0 web:pointer-events-none" />
      {/* The one deliberate bare RN Text in this file — `sr-only`
          text paints nothing, so it needs neither Inter nor the font-
          scale cap. Everything else here goes through ui/text's Text;
          see DialogTitle. */}
      <RNText className="sr-only">Close</RNText>
    </Button>
  );
  return onClose ? button : <DialogPrimitive.Close asChild>{button}</DialogPrimitive.Close>;
}

function DialogContent({
  className,
  portalHost,
  children,
  showCloseButton = true,
  onClose,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  portalHost?: string;
  showCloseButton?: boolean;
  onClose?: () => void;
}) {
  // Drop the keyboard on the way in. Whatever field was focused before the
  // press that opened this — the add panel's autofocused URL, the links search
  // box — survives it (every such scroller persists taps, `"handled"`), stays
  // focused BEHIND the dialog, and takes the next keystroke unseen. Once here,
  // for every host, rather than in each trigger: ListSelect and TagsField did
  // it themselves and the other hosts (Move to, bulk tags, …) simply didn't.
  //
  // A LAYOUT effect, and that is what makes it safe for a dialog that
  // autofocuses its own field (lock-password-dialog.tsx). The content isn't in
  // this commit at all — @rn-primitives/portal registers it from a passive
  // effect and the PortalHost renders it in a later one — so this runs while
  // the only focused input is the one behind, and can never blur the new one.
  // Keyed on `open` because hosts like ListSelect keep this mounted while closed.
  const { open } = DialogPrimitive.useRootContext();
  React.useLayoutEffect(() => {
    if (open && Platform.OS !== 'web') Keyboard.dismiss();
  }, [open]);
  const covered = useAppCovered();

  // Unmounted while a relock covers the app
  // (contexts/app-cover.tsx): this subtree portals OUT of
  // AppLockGate's hidden wrapper — to the root PortalHost, and on iOS into a
  // FullWindowOverlay — so it would otherwise stay painted, and tappable, above
  // the lock pane. The caller owns the open state,
  // so the overlay comes back on unlock.
  if (covered) return null;

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
            // `max-w-md` is web-ui's 28rem, and it is UNPREFIXED — unlike
            // react-native-reusables' stock `sm:max-w-lg`, whose 32 sat here
            // until this pass. Only the NUMBER ports out of web's
            // `max-w-[min(var(--dialog-max-w,28rem),calc(100%-2rem))]`; the
            // other two thirds of that expression answer problems this side
            // does not have, which is why the caps were allowed to drift apart
            // in the first place. The `calc(100%-2rem)` is a GUTTER, and web
            // needs it spelled into the cap because Radix centres by transform
            // and has no padded parent to inherit one from (docs/safe-area.md),
            // whereas the gutter here is structural — the overlay pads by
            // `inset + 8` on every edge. That is also why the cap has no gutter
            // rule to trade against, so gating it on a breakpoint only made the
            // width non-monotonic: a 600dp tablet (the common 7" portrait) sat
            // below `sm` and got the full 584, while a 640dp one got 512. And
            // `--dialog-max-w` is a tailwind-merge workaround for web's
            // breakpoints, by its own note there; a caller on this side narrows
            // with a plain `max-w-sm`, which merges against this one cleanly —
            // paywall-provider.tsx and lock-password-dialog.tsx do exactly
            // that, landing on the same 24rem their web twins set through the
            // token.
            // The cap binds on nothing shipped: `app.config.ts` is
            // portrait-only with `supportsTablet: false`, so the widest box is
            // a ~440dp phone minus the gutter, and only an unfolded foldable or
            // a freeform window reaches 448. It is stated anyway so the two
            // kits cannot disagree where it does show. Note `rem` is baked at
            // BUILD time to value * 16 (docs/theme.md, _extending_), so this is
            // a hard 448 that does NOT grow with the OS font scale, while the
            // text inside it does up to the app-wide 1.3 cap.
            'z-50 mx-auto flex max-h-full w-full max-w-md flex-col gap-6 rounded-4xl border border-border bg-popover p-6 shadow-lg shadow-black/5',
            Platform.select({
              web: 'animate-in fade-in-0 zoom-in-95 duration-200 web:max-w-[calc(100%-2rem)]',
            }),
            className,
          )}
          // A tap on the dialog's own chrome — the header, the `p-6` padding, a
          // `gap-6` seam — drops the keyboard (docs/soft-keyboard.md, _dismissal_).
          // The native primitive's Content already claims every touch its
          // children don't (`onStartShouldSetResponder` → true in
          // @rn-primitives/dialog), which is why such a tap neither reached the
          // overlay nor did anything at all; this gives the claimed tap the job
          // the add panel's pressable chrome has. Children keep their own taps
          // (child-first negotiation), so a row, an input or the X is unaffected.
          // Before `{...props}` so a caller can still override it.
          onResponderRelease={Platform.OS === 'web' ? undefined : () => Keyboard.dismiss()}
          {...props}
        >
          {children}
          {showCloseButton && <DialogCloseButton onClose={onClose} />}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ViewProps) {
  return <View className={cn('flex flex-col gap-2', className)} {...props} />;
}

function DialogFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

// ui/text's Text instead of the registry copy's bare `DialogPrimitive.Title` /
// `.Description`: those render **react-native's own Text**, a bare one, one
// delegation away — no `font-sans` (Inter degrades to the system face), no
// `maxFontSizeMultiplier` (these strings scale past the app-wide 1.3 cap while
// their chrome does not), no TextClassContext, no heading role the ui/text map
// can see. alert-dialog.tsx's AlertDialogTitle carries the full note, including
// why nothing catches it.
//
// The FIX differs from its two siblings, and that is the part worth writing
// down. alert-dialog and dropdown-menu pass `asChild` and let the primitive slot
// our Text in — their native builds spell `Component = asChild ? Slot : Text`.
// @rn-primitives/dialog's native build does NOT: `dist/dialog.mjs`'s Title is
// `({ ref, ...props }) => <Text ref={ref} role='heading' {...props} />`, which
// never destructures `asChild` (only its `.web` build does). So the same
// `asChild` spelling slots nothing here — it renders a bare RN Text *around*
// ours and forwards `asChild={true}` to the native view. Nothing says so: the
// types name `asChild` for both builds (`TitleProps = SlottableTextProps`), and
// the glyphs still come out right because RN merges a child fragment's text
// attributes over its parent's, so Inter and the cap survive the nesting. The
// bare Text this file exists to avoid was in every native dialog title and
// description while the file documented the opposite.
//
// Hence: native renders our Text directly, carrying the `role='heading'` the
// primitive would have applied — the native Title adds nothing else (no context,
// no id registration; there is nothing on this side to label). Web keeps the
// primitive, where the Slot does work and Radix needs the element to wire
// `aria-labelledby` / `aria-describedby` to it.
function DialogTitle({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Title>, 'asChild'>) {
  const title = (
    <Text
      className={cn('text-base font-medium text-foreground', className)}
      role="heading"
      {...props}
    />
  );
  return Platform.OS === 'web' ? (
    <DialogPrimitive.Title asChild>{title}</DialogPrimitive.Title>
  ) : (
    title
  );
}

function DialogDescription({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Description>, 'asChild'>) {
  const description = (
    <Text className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
  return Platform.OS === 'web' ? (
    <DialogPrimitive.Description asChild>{description}</DialogPrimitive.Description>
  ) : (
    description
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
