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

import type { ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
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
import { closeShareSheet } from './share-host';
import { useShareKeyboard } from './share-keyboard';

// The panel's own padding, in points, because the bottom edge is no longer a
// class: it is `SHEET_PAD` plus whatever of the bottom inset the keyboard is
// not already covering, in a style prop (below).
const SHEET_PAD = 16;

// The strip of backdrop kept above the panel, BEYOND the top inset — see the
// panel's `marginTop`. A floor on what stays visible of the host app, not a
// cushion: it is what makes the surface read as a sheet over something rather
// than as a screen.
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
//   - iOS — expo-share-extension hands us a FULL-SCREEN root view with square
//     corners and, since `backgroundColor` alpha 0 (app.config.ts), no fill of
//     its own. It is a layout container, not a sheet: the panel below is ours —
//     rounded top, its own background, bottom-aligned so Save stays under the
//     thumb — and what shows above it is the host app under the system's own
//     dimming, which is what every other iOS sheet does. It used to be a fixed
//     520pt BAND pinned to the screen bottom, and that number is what made a
//     keyboard unsurvivable rather than merely awkward: a picker is ~520 of
//     chrome and list, the keyboard takes ~340 of the screen, and no amount of
//     correct lifting fits the first into what is left of the second.
//     app.config.ts's `height` note is the other half of this.
//   - Android — the activity is translucent and full-screen, so the panel was
//     already ours: same rounded top and background, plus its own scrim.
//
// Neither host bounds the panel from the top, so the panel does it itself and
// identically on both (its `marginTop`, below) — which leaves ONE panel
// differing in a single prop, the scrim's tint, rather than in two return
// statements.
//
// KEYBOARD AVOIDANCE IS THE ONE THING THE HOSTS CANNOT SHARE, and the reason is
// not layout: inside the iOS extension process RN reports EVERY keyboard frame
// as zero, because it converts them through `RCTKeyWindow()`, which is nil
// there (share-keyboard.ts carries the full derivation, and it is the same
// family of bug as the font-scale one in lib/font-scale.ts). So the two hosts
// reach the same padding by different routes:
//
//   - Android's share activity rides the app's OWN process, where RN's numbers
//     are real, and a plain KeyboardAvoidingView does the work. Plain, not
//     react-native-keyboard-controller like the app tree: this file also renders
//     inside the extension, and that library's iOS layer is built on
//     `UIApplication.shared.windows`, which an extension does not have
//     (docs/soft-keyboard.md, _avoidance_).
//   - iOS pads the frame by `useShareKeyboard().lift` — the same quantity KAV's
//     `behavior="padding"` would have applied, computed from our own native
//     module's reading of the keyboard's top edge.
//
// Both end in bottom padding on a `justify-end` column, so everything below —
// the panel, the tap layer, the pickers' scrollers — squeezes identically on
// the two hosts. That squeeze chain is `min-h-0 shrink` at each link, and it is
// load-bearing: a panel that cannot shrink does not clip, it OVERFLOWS, and
// what you get is a sheet whose header floats above its own background.
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
// from is behind it. The pickers' scrollers pair this with
// `keyboardDismissMode="on-drag"`, so scrolling the results dismisses too.
export function ShareSheet({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
      <ShareSheetFrame>{children}</ShareSheetFrame>
    </SafeAreaProvider>
  );
}

const isAndroid = Platform.OS === 'android';

function ShareSheetFrame({ children }: { children: ReactNode }) {
  // iOS: how much of the sheet the keyboard covers, from our own native module
  // (share-keyboard.ts). Zero on Android, where the KeyboardAvoidingView at the
  // bottom of this function is the mechanism instead. `cover` is that same
  // measurement on BOTH hosts and is NOT a lift — its only job is the inset
  // subtraction below.
  const { lift, cover } = useShareKeyboard();
  // Read in JS and applied as padding rather than handed to a `<SafeAreaView>`:
  // see INITIAL_METRICS above for why that view is gone. `pb` is the panel's own
  // padding PLUS the inset — the `additive` mode it replaces — so the Save
  // button clears the home indicator instead of sitting inside its swipe region,
  // MINUS however much of that inset the keyboard already covers, which while it
  // is up is all of it (see the header).
  //
  // `Math.max` rather than a `cover > 0 ? 0 : insets.bottom` ternary, so a
  // keyboard covering LESS than the inset keeps the difference instead of losing
  // the whole thing — no host or keyboard mode has to be enumerated for that to
  // stay right.
  const insets = useSafeAreaInsets();
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
        marginTop: insets.top + SHEET_GAP,
        paddingBottom: SHEET_PAD + Math.max(insets.bottom - cover, 0),
      }}
      // `min-h-0 shrink`: the first link of the squeeze chain (see the header).
      // Without it the panel keeps its content height when the keyboard takes
      // the room out from under it and overflows the frame instead of passing
      // the squeeze down to the pickers' scrollers — which does not clip, it
      // paints outside the box.
      className="min-h-0 shrink rounded-t-2xl bg-background px-4 pt-4"
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
      {panel}
    </>
  );

  // The two routes to the same bottom padding (see the header). Android's
  // KeyboardAvoidingView is doing what `lift` does on iOS, in a process where
  // RN's keyboard frames are real; iOS applies ours directly, because there the
  // same component would lift by the panel's whole height.
  return isAndroid ? (
    <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
      {sheet}
    </KeyboardAvoidingView>
  ) : (
    <View style={{ paddingBottom: lift }} className="flex-1 justify-end">
      {sheet}
    </View>
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
