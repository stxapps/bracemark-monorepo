// The share sheet's chrome — the frame, the header, the disclosure row, the
// terminal notice. Split out of share-screen.tsx for the reason
// features/settings/settings-kit.tsx exists one level up: the sheet is now four
// screens (compose, saved, choose-list, add-tags) sharing one frame, and a
// frame typed into four places drifts into four sheets.
//
// EVERY IMPORT HERE IS ON THE iOS EXTENSION'S CRITICAL PATH. share-root.tsx's
// header is the fence; two consequences show up in this file:
//
//   - NO BARREL IS EVER IMPORTED HERE — not lucide's, not a workspace
//     package's. LUCIDE IS DEEP-IMPORTED (`lucide-react-native/icons/x`), the
//     only corner of the app that does. The barrel is ~1700 icon modules and
//     Metro does not tree-shake, so `import { X } from 'lucide-react-native'`
//     executes all of them on every cold share. On Android that costs nothing —
//     the share activity rides the main bundle, where the barrel is already
//     resident — but iOS pays it per share, and docs/share-sheet.md asks for
//     exactly this graph to be policed. The subpath is a declared package export
//     with types (`./icons/*`), resolved by Metro and jest alike under the
//     `react-native` condition, not a reach into dist/. `@stxapps/expo-react`
//     and `@stxapps/expo-crypto` are deep-imported for the same reason and by
//     the same mechanism (share-screen.tsx); a lint rule enforces both
//     (share-root.tsx's header).
//   - NO PORTALS, NO REANIMATED. Nothing here is a Dialog or a DropdownMenu;
//     the pickers are screens within the sheet rather than overlays over it.

import { type ReactNode, useCallback, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import X from 'lucide-react-native/icons/x';
import { withUniwind } from 'uniwind';

import { BrandLockup } from '../../components/brand-lockup';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { closeShareSheet } from './share-host';

// A composite, not a core host, so Uniwind's HOC is what lets it take
// `className` (the note in components/landing.tsx).
const StyledSafeAreaView = withUniwind(SafeAreaView);

// Only the bottom edge, and `additive` so the inset stacks on the panel's own
// padding rather than replacing it. This is the one tree in the app outside any
// SafeAreaProvider (docs/safe-area.md) — which is fine, and worth knowing:
// `SafeAreaView` is a NATIVE view that measures its own insets and reads no
// context, unlike `useSafeAreaInsets`. The other three edges are `off`: the iOS
// host view is bottom-pinned and 520pt tall, so it never reaches the notch, and
// Android's panel is bottom-anchored under a full-bleed backdrop.
//
// It was previously omitted entirely, and the omission was visible: the Save
// button's bottom edge sat 16px off the screen bottom on iOS, i.e. underneath
// the home indicator's own swipe region.
const BOTTOM_EDGE = { bottom: 'additive' } as const;

// The iOS half of the sheet's keyboard avoidance, and the reason is the same
// host that forced a plain KeyboardAvoidingView on this surface at all.
// expo-share-extension does not hand the extension a full-screen RN surface: its
// ShareExtensionViewController places our root view at
// `y = UIScreen.main.bounds.height - ShareExtensionHeight` — a 520pt band pinned
// to the bottom of the screen (the height is set in app.config.ts and written
// into the extension's Info.plist from there).
//
// KeyboardAvoidingView lifts by `frame.y + frame.height - keyboardFrame.screenY`,
// and inside that band the two terms are in DIFFERENT coordinate spaces:
// `frame` comes from its own onLayout, so it reads y=0, height=520, while
// `screenY` is the keyboard's origin ON THE SCREEN (~516 on an 852pt phone).
// The subtraction yields a few points instead of the keyboard's height — which
// is why the panel sat UNDER the keyboard, and why it appeared to creep up
// later: it was tracking changes to the keyboard's own frame (the accessory bar
// arriving, a picker swapping fields) rather than ever avoiding it.
// `keyboardVerticalOffset` is exactly this knob — RN documents it as "distance
// between the top of the user screen and the React Native view" — so the value
// is the band's screen origin. Android's activity IS full-screen, so 0 is
// correct there and this stays wired to the iOS branch only.
const useShareKeyboardOffset = () => {
  const [offset, setOffset] = useState(0);

  // Measured, not the literal 520: that number is app.config.ts's to own, and a
  // copy here would be a second opinion with nothing to catch it drifting. The
  // band's origin is `screen height − the height this view measures`, and this
  // view measures the band exactly — it is the extension surface's only child,
  // `flex-1` inside a root whose frame is fixed. That also means the layout does
  // not re-fire under the lift (`behavior="padding"` moves padding, not this
  // box's height), so it runs once on mount, long before any keyboard.
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setOffset(Math.max(Dimensions.get('screen').height - event.nativeEvent.layout.height, 0));
  }, []);

  return { offset, onLayout };
};

// The sheet's frame. Two very different native hosts, one tree below this
// point (docs/share-sheet.md):
//
//   - iOS — expo-share-extension provides the floating panel itself: a
//     bottom-pinned, 520pt-tall root view whose background is `.systemBackground`
//     and whose corners are SQUARE (its ShareExtensionViewController sets no
//     corner radius). So this fills it rather than drawing a panel inside it —
//     rounding our own content would leave the host's square corners painted
//     behind it. Content is bottom-aligned within the fixed height, which is
//     what keeps Save under the thumb on a screen that is 520pt tall no matter
//     how short the screen above it is.
//   - Android — the activity is translucent and full-screen, so the panel IS
//     ours: rounded top, tap-to-dismiss backdrop, capped at 85% so a long list
//     can never swallow the whole window.
//
// Keyboard: both hosts overlay it, so the sheet moves itself. Deliberately a
// plain KeyboardAvoidingView, NOT react-native-keyboard-controller like the app
// tree — its iOS native layer is built on `UIApplication.shared`, which does not
// exist in an extension process (docs/soft-keyboard.md, _avoidance_).
// `behavior="padding"` on both so the two hosts render the same tree. iOS also
// needs a `keyboardVerticalOffset`, which is `useShareKeyboardOffset` above.
//
// DISMISSING that keyboard is this frame's job too, and it has to be, because
// the pickers below cannot do it themselves: their inputs are
// `submitBehavior="submit"` on purpose (return ADDS a tag/list and keeps the
// keyboard for the next one — share-tags-picker.tsx), so return never blurs.
// Without the layer below, the iOS sheet had NO gesture that closed the
// keyboard at all: the panel is a plain SafeAreaView, the host owns the space
// around it, and Android's backdrop closes the whole sheet rather than the
// keyboard. The keyboard then eats ~335 of a fixed 520pt host and the tag list
// you are picking from is behind it. The pickers' scrollers pair this with
// `keyboardDismissMode="on-drag"`, so scrolling the results dismisses too.
export function ShareSheet({ children }: { children: ReactNode }) {
  const keyboard = useShareKeyboardOffset();
  const panel = (
    <StyledSafeAreaView
      edges={BOTTOM_EDGE}
      className={cn(
        'px-4 pt-4 pb-4',
        Platform.OS === 'android' && 'max-h-[85%] rounded-t-2xl bg-background',
      )}
    >
      {/* Tap-anywhere-dead to drop the keyboard, and it WRAPS the children
          rather than sitting behind them as an absolute layer. The absolute
          version was tried first and is wrong: driven on the simulator with a
          debug tint, `absolute inset-0` inside this SafeAreaView laid out as a
          thin full-width band ABOVE the panel instead of covering it —
          safe-area-context's SafeAreaView is a NATIVE view that applies its
          insets outside Yoga, so an absolutely-positioned child does not
          resolve against the box you see. Nothing about that is visible without
          rendering it.

          As a wrapper it is an ordinary flex column, so it covers exactly the
          panel and nothing else. It carries the `gap-4` the SafeAreaView used
          to, because it is now the parent the seams belong to; `shrink min-h-0`
          keeps the squeeze chain intact so the pickers' `max-h-72` scroller and
          Android's `max-h-[85%]` cap still absorb the keyboard.

          Child-first responder negotiation is what keeps this from eating taps:
          a press on a button or a picker row is claimed by that child, and this
          only fires on what reaches the panel's own padding and seams.

          UNVERIFIED ON DEVICE, and it cannot be with the tools here: once the
          keyboard is presented over the iOS extension, the whole panel drops
          out of the accessibility tree, so Maestro can neither see nor address
          it (`share-back` goes not-found mid-flow) and a coordinate tap has
          nothing to confirm against. The structure above is the standard RN
          pattern and is right on reasoning; the ABSENCE of a check is the risk.
          If this surface is ever driven by hand, this tap is the thing to try
          first. Android's half rides the main bundle and has no such problem.

          `accessible={false}` for the reason the Android backdrop below carries
          verbatim: as a focus stop this would announce as one enormous
          unlabelled control over the whole sheet. */}
      <Pressable accessible={false} onPress={Keyboard.dismiss} className="min-h-0 shrink gap-4">
        {children}
      </Pressable>
    </StyledSafeAreaView>
  );

  if (Platform.OS === 'ios') {
    return (
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={keyboard.offset}
        onLayout={keyboard.onLayout}
        className="flex-1 justify-end bg-background"
      >
        {panel}
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
      {/* `accessible={false}`, NOT `role="button"`: this is a full-bleed dismiss
          target behind the sheet, and as a focus stop it would announce as one
          enormous unlabelled control sitting over everything. The sheet's own
          close control (share-close, below) is the announced way out. */}
      <Pressable
        accessible={false}
        testID="share-backdrop"
        onPress={closeShareSheet}
        className="absolute top-0 right-0 bottom-0 left-0 bg-black/40"
      />
      {panel}
    </KeyboardAvoidingView>
  );
}

// The header row, and it is the same height in all four screens so the specimen
// beneath it never moves. Two shapes:
//
//   - the SHEET'S OWN header — the brand lockup, plus a close control. The
//     lockup is here for the reason components/brand-lockup.tsx exists at all:
//     this is a surface with no other brand carrier, floating over somebody
//     else's app, and until now it never said whose sheet it was. The close
//     control is not decoration either — on iOS there is no backdrop to tap and
//     no swipe to dismiss, so before this the compose screen had no way out
//     except saving.
//   - a SUB-SCREEN'S header — a back control labelled with the screen you are
//     on, since there is exactly one place back goes.
//
// `dismissible` drops the close control for the screens that already end in a
// Close button (ShareNotice, the quota banner) — the X and that button say the
// same word, and the reason the X exists at all is that the compose screen has
// no other way out. The lockup stays on every one of them: a sheet telling you
// to go and sign in is precisely a sheet that has to say whose it is.
export function ShareHeader({
  back,
  dismissible = true,
}: {
  back?: { title: string; onPress: () => void };
  dismissible?: boolean;
}) {
  if (back) {
    return (
      <View className="h-9 flex-row items-center">
        <Pressable
          testID="share-back"
          onPress={back.onPress}
          accessibilityRole="button"
          className="-ml-2 h-9 flex-row items-center gap-1 rounded-md pr-3 pl-1 active:bg-muted"
        >
          <Icon as={ChevronLeft} className="size-5 text-muted-foreground" />
          <Text className="font-medium">{back.title}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="h-9 flex-row items-center">
      <BrandLockup
        action={
          dismissible ? (
            <Pressable
              testID="share-close"
              onPress={closeShareSheet}
              aria-label="Close"
              accessibilityRole="button"
              className="-mr-2 size-9 items-center justify-center rounded-md active:bg-muted"
            >
              <Icon as={X} className="size-5 text-muted-foreground" />
            </Pressable>
          ) : undefined
        }
      />
    </View>
  );
}

// The group the two disclosure rows sit in — one bordered box, hairline between,
// the same treatment the settings tables use (features/settings/rows.tsx).
export function ShareRowGroup({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-lg border border-border">{children}</View>;
}

// One disclosure row: an icon that names the KIND of choice, the current value,
// and a chevron. It carries no VISIBLE label ("List", "Tags") on purpose — the
// icon plus a folder's name is not ambiguous, the sub-screen it opens is titled,
// and a 520pt sheet has better uses for two lines of type. The uppercase
// eyebrows that used to sit above the pickers were the only ones in the app.
//
// It still carries the label to SCREEN READERS (`label`, required), because the
// icon that replaces it is decorative to them: without this the row announces
// "Reading, button" — the value with no hint of what it changes, on a surface
// with exactly two rows that both look like that. Dropping a word of type is a
// visual decision; dropping the semantics is not part of it.
export function ShareRow({
  icon,
  label,
  value,
  testID,
  onPress,
  bordered,
  children,
}: {
  icon: LucideIcon;
  // What the row's icon says visually — "List", "Tags". Announced with the
  // current value (the `value` below), never rendered.
  label: string;
  // The current answer, for the announcement only: the visible children are
  // styled nodes (chips, a truncated name) that a screen reader would read as a
  // heap of fragments.
  value: string;
  testID: string;
  onPress: () => void;
  // Second row and after — the hairline belongs to the row that follows one, so
  // the group never ends on a stray line.
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      aria-label={`${label}: ${value}`}
      accessibilityRole="button"
      className={cn(
        'min-h-12 flex-row items-center gap-3 px-3 py-2.5 active:bg-muted/50',
        bordered === true && 'border-t border-border',
      )}
    >
      <Icon as={icon} className="size-4 shrink-0 text-muted-foreground" />
      <View className="min-w-0 flex-1">{children}</View>
      <Icon as={ChevronRight} className="size-4 shrink-0 text-muted-foreground" />
    </Pressable>
  );
}

// A terminal screen: no session, nothing shareable, or the plan's link cap.
// Shaped like the links pane's EmptyState (features/links/shared.tsx) — a mark,
// a title, a sentence that says what to do next — because it is the same kind of
// moment, and because the bare centred sentence this replaces explained nothing
// and offered nothing.
export function ShareNotice({
  testID,
  icon,
  title,
  children,
}: {
  testID: string;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <ShareSheet>
      <ShareHeader dismissible={false} />
      <View testID={testID} className="items-center gap-3 py-6">
        <View className="size-11 items-center justify-center rounded-full bg-muted">
          <Icon as={icon} className="size-5 text-muted-foreground" />
        </View>
        <View className="gap-1">
          <Text className="text-center text-base font-medium">{title}</Text>
          {typeof children === 'string' ? (
            <Text className="max-w-sm text-center text-sm text-muted-foreground">{children}</Text>
          ) : (
            children
          )}
        </View>
      </View>
      <Button variant="outline" size="lg" onPress={closeShareSheet}>
        <Text>Close</Text>
      </Button>
    </ShareSheet>
  );
}
