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

import { type ReactNode, useEffect } from 'react';
import { Keyboard, Platform, Pressable, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import X from 'lucide-react-native/icons/x';

import { BrandLockup } from '../../components/brand-lockup';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';
import { closeShareSheet } from './share-host';
import { ShareKeyboardFrame, useShareKeyboard } from './share-keyboard';
import { markShareMemory } from './share-memory';
import { ShareSwipeGuard } from './share-swipe-guard';

// The panel's own padding, in points, because the bottom edge is no longer a
// class: it is `SHEET_PAD` plus whatever of the bottom inset the keyboard is
// not already covering, in a style prop (below).
const SHEET_PAD = 16;

// The strip of backdrop kept above the panel, BEYOND the top inset — see the
// panel's `marginTop` — and, when the host floats the sheet as a card, below it
// as well. A floor on what stays visible of the host app, not a cushion: it is
// what makes the surface read as a sheet over something rather than as a
// screen.
const SHEET_GAP = 24;

// THE SHEET NEEDS A PROVIDER, and the version this was first written against is
// why it didn't have one. react-native-safe-area-context's `<SafeAreaView>` was
// a self-measuring native view once; since v5 it is not. `RNCSafeAreaView`
// walks `reactSuperview` for an `RNCSafeAreaProvider` (`findNearestProvider`)
// and, finding none, returns from `invalidateSafeAreaInsets` before it ever
// calls `updateLocalData` — so the view lays out with ZERO insets and reports
// no error. That is exactly what shipped here: `edges={{ bottom: 'additive' }}`
// on a provider-less tree, and the Save button back under the home indicator's
// swipe region, which is the bug the edge was added to fix in the first place.
// So the sheet now carries its own provider and reads the inset in JS.
//
// `initialMetrics` is what makes that safe rather than a new failure mode:
// `SafeAreaProvider` renders NOTHING until its first `onInsetsChange`, and in
// this process there is no fallback for it to fall back to — the module's
// `initialWindowMetrics` constant comes from `RCTKeyWindow()`, i.e.
// `UIApplication.shared`, which an app-extension process does not have
// (docs/share-sheet.md). Seeding zero insets means the sheet paints on the
// first frame exactly as it does today and only ever moves DOWN-safe when the
// real measurement lands a frame later. Android's activity is full-screen and
// measures the same way, so one provider covers both hosts.
const INITIAL_METRICS = {
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  frame: { x: 0, y: 0, width: 0, height: 0 },
};

// The sheet's frame. Two very different native hosts, one tree below this
// point (docs/share-sheet.md):
//
//   - iOS — expo-share-extension hands us a root view that fills the host's
//     presentation, with square corners and, since `backgroundColor` alpha 0
//     (app.config.ts), no fill of its own. It is a layout container, not a
//     sheet: the panel below is ours — rounded, its own background — and what
//     shows around it is the host app under the system's own dimming, which is
//     what every other iOS sheet does. It used to be a fixed 520pt BAND pinned
//     to the screen bottom, and that number is what made a keyboard
//     unsurvivable rather than merely awkward: a picker is ~520 of chrome and
//     list, the keyboard takes ~340 of the screen, and no amount of correct
//     lifting fits the first into what is left of the second. app.config.ts's
//     `height` note is the other half of this.
//
//     THAT PRESENTATION HAS TWO SHAPES, and the frame only learns which from
//     the native module that measures it (share-keyboard.ts). On an iPhone it is
//     full-width and flush with the screen's bottom edge, and the panel is a
//     bottom sheet: bottom-aligned so Save stays under the thumb. On an iPad
//     the host makes it a FORM SHEET — a 580x640 card floating mid-screen, its
//     bottom edge 90pt above the screen's in landscape — and a bottom sheet in
//     there is a card glued to the floor of an invisible box. So when the
//     frame is `detached` the panel centres and rounds all four corners: the
//     iPadOS idiom for a form sheet, and what the app's own add panel does from
//     768 (docs/soft-keyboard.md, _the add panel's two shapes_).
//   - Android — the activity is translucent and full-screen, so the panel was
//     already ours: same rounded top and background, plus its own scrim. And
//     so is its shape, which no host picks here: from 768 (lib/window-class.ts)
//     the panel takes the iPad's — a centred `max-w-lg` card, the app's own
//     add panel at that width (components/ui/sheet.tsx) — where a bottom sheet
//     ran the full 1280dp of a tablet on its side. Reactive, so a split screen
//     or a fold that crosses 768 changes the shape under an open sheet.
//
// Neither host bounds the panel from the top, so the panel does it itself and
// identically on both (its `marginTop`, below) — which leaves ONE panel
// differing in a single prop, the scrim's tint, rather than in two return
// statements.
//
// KEYBOARD AVOIDANCE IS OURS ON BOTH HOSTS, because RN's own answer is wrong on
// each of them, in a different way (share-keyboard.ts carries both
// derivations):
//
//   - inside the iOS extension process RN reports EVERY keyboard frame as zero,
//     because it converts them through `RCTKeyWindow()`, which is nil there —
//     the same family of bug as the font-scale one in lib/font-scale.ts. A
//     KeyboardAvoidingView there lifts by the panel's whole height.
//   - in Android's share activity the frames are real, and a plain
//     KeyboardAvoidingView was this file's Android branch for exactly that
//     reason. It lifted correctly and then did not come back down: RN's
//     `keyboardDidHide` carries a `screenY` that leaves out the status and
//     navigation bars, KAV reads that as a keyboard still overlapping the
//     edge-to-edge frame by both of them, and the panel stayed ~74dp above the
//     bottom of the screen once the keyboard had gone.
//
// react-native-keyboard-controller, which the app tree uses, is not available
// to either: this file also renders inside the extension, and that library's
// iOS layer is built on `UIApplication.shared.windows`, which an extension does
// not have (docs/soft-keyboard.md, _avoidance_).
//
// So the frame pads its own bottom by `useShareKeyboard()` — how much of it the
// keyboard covers, from our native module on iOS and from the trustworthy half
// of RN's events on Android. On iOS it is the FRAME'S OWN overlap, measured
// natively against the frame's UIView, because on an iPad the host also moves
// the sheet for the keyboard and only a view inside the sheet can see where it
// went (share-keyboard.ts).
// Bottom padding on a `justify-end` (or, detached, `justify-center`) column, so
// everything below — the panel, the tap layer, the pickers' scrollers —
// squeezes identically on the two hosts. That squeeze chain is `min-h-0 shrink`
// at each link, and it is load-bearing: a panel that cannot shrink does not
// clip, it OVERFLOWS, and what you get is a sheet whose header floats above its
// own background.
//
// THE BOTTOM SAFE-AREA INSET IS THE KEYBOARD'S TOO while it is up, on both
// hosts, and that is why the panel's `paddingBottom` subtracts. A keyboard's
// frame runs to the BOTTOM of the screen — it CONTAINS the home indicator /
// gesture bar rather than stopping above it — so once the panel is parked on
// that frame's top edge, `insets.bottom` on top of the lift is not clearance:
// it is ~34pt (iOS) or ~24-48pt (Android) of empty background between the Save
// button and the keyboard, spent at the one moment the sheet has the least
// height to spend. And it is spent out of the pickers specifically — everything
// above their scroller is fixed (the header, the input, the row group, the
// button, the `gap-4` seams), so the squeeze chain can only take it from the
// scroller's own rows, and past that scroller's floor the panel stops shrinking
// and overflows as above. Nothing catches this: it is dead space, not a broken
// layout, right up until the screen is small enough that it is both.
//
// DISMISSING that keyboard is this frame's job too, and it has to be, because
// the pickers below cannot do it themselves: their inputs are
// `submitBehavior="submit"` on purpose (return ADDS a tag/list and keeps the
// keyboard for the next one — share-tags-picker.tsx), so return never blurs.
// Without the layer below, the iOS sheet had NO gesture that closed the
// keyboard at all: the panel is a plain box, the host owns the space around it,
// and either host's backdrop closes the whole sheet rather than the keyboard.
// The keyboard then eats ~340pt of the screen and the tag list you are picking
// from is behind it. The pickers' scrollers lean on it: they are
// `keyboardDismissMode="interactive"`, so a scroll KEEPS the keyboard rather
// than dropping the panel out from under the finger, and this layer is the
// exit (share-list-picker.tsx).
//
// `holdSwipe` IS FOR THE PICKERS, and only them. On iOS the host presents the
// share extension in a sheet of its own, and a downward drag on it belongs to
// that sheet — a long one dismisses the whole thing, unsaved share included,
// from a screen where "down" means "scroll the list". The prop mounts the guard
// that asks native to hold that swipe off while the screen is up
// (share-swipe-guard.tsx); the compose screen leaves it unset and keeps the
// platform's gesture. A no-op on Android, which has no such gesture.
//
// `screen` names the screen for the share extension's memory log: each one
// marks the process's footprint and headroom as it mounts (share-memory.ts).
// Required, so a new screen cannot join the sheet without showing up there.
export function ShareSheet({
  children,
  screen,
  holdSwipe = false,
}: {
  children: ReactNode;
  screen: string;
  holdSwipe?: boolean;
}) {
  useEffect(() => markShareMemory(screen), [screen]);

  return (
    <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
      <ShareSheetFrame holdSwipe={holdSwipe}>{children}</ShareSheetFrame>
    </SafeAreaProvider>
  );
}

const isAndroid = Platform.OS === 'android';

function ShareSheetFrame({ children, holdSwipe }: { children: ReactNode; holdSwipe: boolean }) {
  // Read in JS and applied as padding rather than handed to a `<SafeAreaView>`:
  // see INITIAL_METRICS above for why that view is gone. `pb` is the panel's own
  // padding PLUS the inset — the `additive` mode it replaces — so the Save
  // button clears the home indicator instead of sitting inside its swipe region,
  // MINUS however much of that inset the keyboard already covers, which while it
  // is up is all of it (see the header).
  //
  // `Math.max` rather than a `lift > 0 ? 0 : insets.bottom` ternary, so a
  // keyboard covering LESS than the inset keeps the difference instead of losing
  // the whole thing — no host or keyboard mode has to be enumerated for that to
  // stay right.
  const insets = useSafeAreaInsets();
  // How much of the frame the keyboard covers, on both hosts (share-keyboard.ts)
  // — the frame's bottom padding at the foot of this function, and the inset
  // subtraction just below — and whether the host floats the sheet as a card,
  // which picks the panel's shape (the header).
  const { lift, detached: hostDetached } = useShareKeyboard(insets.bottom);
  // Android's own card on a wide window (the header). Only Android: the iPad's
  // card is the host's, already 580 wide, and the extension's window size is
  // not to be trusted (docs/share-sheet.md, _On an iPad the sheet floats_).
  const wide = useWideWindow();
  const card = isAndroid && wide;
  const detached = hostDetached || card;
  // The bottom inset belongs OUTSIDE a card Android centres, under the gap: it is
  // the navigation bar's, and inside the card it would only pad Save off the
  // card's own bottom edge. A sheet keeps it inside, flush with the screen.
  const insetBelow = Math.max(insets.bottom - lift, 0);
  const panel = (
    <View
      style={{
        // THE TOP GAP, and it is a floor on the BACKDROP rather than a cap on
        // the panel. Android used to spell it `max-h-[85%]`, which was the
        // wrong shape twice over: a percentage of a box the keyboard has
        // already shrunk goes on taking its 15% out of the pickers' scroller at
        // the moment there is least of it (~50dp on a short phone — three rows
        // down to two), and being Android-only it left iOS unbounded. That is
        // not theoretical on either host, because the panel is `shrink` inside a
        // `flex-1 justify-end` frame, which makes the frame a CEILING and not a
        // gap: once content exceeds it the panel simply fills it, rounded top at
        // y=0. A picker runs to ~484pt of content against ~407 of frame on a
        // short phone with the keyboard up, and that is a header sitting under
        // the status bar.
        //
        // A margin bounds the panel by SUBTRACTION, so both hosts keep the same
        // strip and neither can reach the hardware. `insets.top` and not a bare
        // number, because none of that strip reads as backdrop until it has
        // cleared a notch or a status bar.
        //
        // A MARGIN and not padding on the frame: the backdrop `Pressable` below
        // is absolute against the frame's PADDING box (its own note), so frame
        // padding would pull the dismiss target out from under exactly the gap
        // this creates — the one part of the sheet that most invites a tap.
        //
        // A detached panel is centred, so it keeps the same strip below it too —
        // between it and the keyboard while that is up, as the app's own wide
        // add-panel card does.
        marginTop: insets.top + SHEET_GAP,
        marginBottom: card ? SHEET_GAP + insetBelow : detached ? SHEET_GAP : 0,
        paddingBottom: SHEET_PAD + (card ? 0 : insetBelow),
      }}
      // `min-h-0 shrink`: the first link of the squeeze chain (see the header).
      // Without it the panel keeps its content height when the keyboard takes
      // the room out from under it and overflows the frame instead of passing
      // the squeeze down to the pickers' scrollers — which does not clip, it
      // paints outside the box.
      //
      // `border-t` + `bg-popover` — the add panel's pair
      // (features/links/link-add-panel.tsx, docs/theme.md _elevation_), and the
      // case for it is stronger here: this panel wore the page's
      // `bg-background` with NO edge, over a backdrop that is not ours. In dark
      // that backdrop is usually dark too — the host app, under the system's
      // dimming or the Android scrim below — and a 0.145 panel on a dimmed dark
      // app has nothing to separate it but its own content. Light is untouched
      // by the fill (the two tokens are the same white). The saved specimen's
      // corner cut is painted in this fill and has to move with it
      // (share-specimen.tsx, OVERLAY).
      className={cn(
        'min-h-0 shrink border-border bg-popover px-4 pt-4',
        detached ? 'rounded-2xl border' : 'rounded-t-2xl border-t',
        card && 'w-full max-w-lg self-center',
      )}
    >
      {/* Tap-anywhere-dead to drop the keyboard, and it WRAPS the children
          rather than sitting behind them as an absolute layer. The absolute
          version was tried first and is wrong: driven on the simulator with a
          debug tint, `absolute inset-0` laid out as a thin full-width band
          ABOVE the panel instead of covering it — the panel was a native
          `<SafeAreaView>` then, which applies its insets outside Yoga, so an
          absolutely-positioned child did not resolve against the box you see.
          The panel is a plain `View` now (INITIAL_METRICS above), so that
          particular trap is gone; the wrapper stays because it is also the
          simpler shape.

          As a wrapper it is an ordinary flex column, so it covers exactly the
          panel and nothing else. It carries the `gap-4` the panel used to,
          because it is now the parent the seams belong to; `shrink min-h-0`
          keeps the squeeze chain intact so the pickers' `max-h-72` scroller is
          still what absorbs the keyboard.

          Child-first responder negotiation is what keeps this from eating taps:
          a press on a button or a picker row is claimed by that child, and this
          only fires on what reaches the panel's own padding and seams.

          VERIFIED BY HAND ON AN iPHONE, and only by hand: a tap on the panel's
          empty space drops the keyboard there. No flow can re-check it — once
          the keyboard is presented over the iOS extension, the whole panel
          drops out of the accessibility tree, so Maestro can neither see nor
          address it (`share-back` goes not-found mid-flow) and a coordinate tap
          has nothing to confirm against. So re-drive it by hand after touching
          this wrapper: the pickers' `interactive` scrollers have no other tap
          exit. Android's half rides the main bundle and has no such problem.

          `accessible={false}` for the reason the Android backdrop below carries
          verbatim: as a focus stop this would announce as one enormous
          unlabelled control over the whole sheet. */}
      <Pressable accessible={false} onPress={Keyboard.dismiss} className="min-h-0 shrink gap-4">
        {children}
      </Pressable>
    </View>
  );

  const sheet = (
    <>
      {/* `accessible={false}`, NOT `role="button"`: this is a full-bleed dismiss
          target behind the sheet, and as a focus stop it would announce as one
          enormous unlabelled control sitting over everything. The sheet's own
          close control (share-close, below) is the announced way out.

          Untinted on iOS, `bg-black/40` on Android: the iOS host dims the app
          behind the extension itself, so a second scrim would double it, while
          Android's activity is merely translucent and this IS its scrim. It has
          to exist on iOS all the same, because the extension's root view is
          transparent and STILL TAKES TOUCHES — an area that looks like Safari
          and swallows taps reads as broken.

          Absolute, so it fills the frame's padding box: while the keyboard is
          up that stops at the keyboard's top edge, which is exactly right —
          there is nothing to dismiss underneath it. */}
      <Pressable
        accessible={false}
        testID="share-backdrop"
        onPress={closeShareSheet}
        className={cn('absolute top-0 right-0 bottom-0 left-0', isAndroid && 'bg-black/40')}
      />
      {holdSwipe && <ShareSwipeGuard />}
      {panel}
    </>
  );

  // The measured box wraps the padded one rather than being it: the native module
  // reports how much of the FRAME the keyboard covers, which is a question about
  // the whole frame, and the padding inside is the answer.
  return (
    <ShareKeyboardFrame style={{ flex: 1 }}>
      <View
        style={{ paddingBottom: lift }}
        className={cn('flex-1', detached ? 'justify-center' : 'justify-end')}
      >
        {sheet}
      </View>
    </ShareKeyboardFrame>
  );
}

// The header row, and it is the same height in all four screens so the specimen
// beneath it never moves. Two shapes:
//
//   - the SHEET'S OWN header — the brand lockup, plus a close control. The
//     lockup is here for the reason components/brand-lockup.tsx exists at all:
//     this is a surface with no other brand carrier, floating over somebody
//     else's app, and until now it never said whose sheet it was. The close
//     control is not decoration either — on iOS the backdrop and the system's
//     swipe-down are both invisible, so before this the compose screen showed
//     no way out except saving.
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
        <Button
          testID="share-back"
          variant="ghost"
          size="sm"
          onPress={back.onPress}
          className="-ml-2 gap-1 pr-3 pl-1"
        >
          <Icon as={ChevronLeft} className="size-5 text-muted-foreground" />
          {/* `text-base` restated: the kit's button label is `text-sm`, and this
              one is a header title, not a control label. */}
          <Text className="text-base font-medium">{back.title}</Text>
        </Button>
      </View>
    );
  }

  // A COLUMN, not a row — the two rails that render the same lockup with a
  // trailing control put it in one too (features/{links,settings}/sidebar.tsx,
  // `h-14 justify-center`), and this is why: `BrandLockup` pushes its `action`
  // over with `ml-auto`, which needs the lockup's own row to be as wide as the
  // header. As a child of a `flex-row` it was sized to its content instead, so
  // the close control sat tight against the wordmark in the middle of the sheet
  // rather than at the right edge. `justify-center` keeps the vertical centring
  // the row gave it.
  return (
    <View className="h-9 justify-center">
      <BrandLockup
        action={
          dismissible ? (
            <Button
              testID="share-close"
              variant="ghost"
              size="icon-sm"
              onPress={closeShareSheet}
              aria-label="Close"
              // 48x48 effective, the topbars' value for the topbars' reason: the
              // box is 36, under both platform floors, and `hitSlop` is the
              // lever rather than a bigger box (docs/accessibility.md, _a 36dp
              // box is not a 44pt target_). The full 6 on every side because
              // nothing pressable is beside it — the lockup it trails is an icon
              // and a Text, and `ml-auto` leaves the whole middle of the header
              // empty. Slop reaching past the header's bounds is fine: the
              // tap-to-dismiss Pressable above is this button's PARENT, so
              // child-first negotiation gives the slop the press, and the next
              // sibling down the panel is a `gap-4` away.
              //
              // It matters more here than anywhere else in the app. On iOS this
              // is the only VISIBLE way out of the compose screen — the swipe
              // and the backdrop announce nothing (docs/share-sheet.md) — so a
              // near-miss on it is a user stuck in somebody else's app.
              hitSlop={6}
              className="-mr-2"
            >
              <Icon as={X} className="size-5 text-muted-foreground" />
            </Button>
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
    <ShareSheet screen={testID}>
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
