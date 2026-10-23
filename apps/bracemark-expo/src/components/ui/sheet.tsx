// The IN-APP SHEET: a bottom sheet on a narrow window and a centred card on a
// wide one (lib/window-class.ts, the rail's 768), drawn in the app's own
// window. The add panel, the link editor and Advanced Search are all bodies in
// it (features/links/link-add-panel.tsx, link-edit-panel.tsx, search-bar.tsx),
// and the shape is web's own split — quick-add is a bottom sheet below `md` and
// a popover above it.
//
// "Sheet" means four things in this repo, and this is only one of them:
//
//   - NOT a native sheet PRESENTATION — iOS's `pageSheet`/`formSheet`, or
//     react-native-screens' — which are what this replaced (below). Where the
//     docs say "form sheet" they mean that.
//   - NOT web-ui's `Sheet` (packages/web-ui), which is edge-anchored at every
//     width; web's quick-add swaps it for a Popover at `md`, so this is that
//     whole SURFACE (`LinkAddSurface`), not its narrow half.
//   - NOT the share sheet (features/share/share-kit.tsx's `ShareSheet`). Same
//     two shapes — a bottom sheet on a phone, a centred card on an iPad — but
//     another process, where none of this file's machinery works (no
//     keyboard-controller there): docs/share-sheet.md.
//
// WHY ONE SHELL, AND WHY THIS ONE. The three used to be three presentations —
// an in-tree panel, an expo-router modal route and an RN `Modal` — and the two
// presented ones each needed a SECOND shell from 768: on an iPad a page or form
// sheet floats above the screen's bottom edge, UIKit moves it for the keyboard
// itself, and nothing in JS can learn where it went, so their keyboard lift
// overshot (docs/soft-keyboard.md, _the in-app sheet_). In the app's own window
// every number is the window's — the avoider's keyboard height, the safe-area
// insets, the window width — on iOS and Android alike, so one tree serves a
// phone, a tablet, a foldable and a Split View drag across 768 without losing
// the draft, the focus or the scroll. The presentations it replaces also each
// cost something Android-specific: a `Modal` is its own native window, which a
// relock cannot hide and the root PortalHost draws BEHIND (the paywall), and a
// transparent modal route drops the whole accessibility tree on its second open
// (docs/soft-keyboard.md, _the add panel_).
//
// DRAWN IN THE TREE, NOT PORTALED — inside `SheetHost`, which
// `(app)/links/_layout.tsx` wraps around the links Drawer. Each opener's host
// (link-add-host.tsx, link-edit-host.tsx, search-bar.tsx's AdvancedSearchHost)
// sits between SheetHost and the Drawer, renders the Drawer wrapped in
// `SheetCovered`, and its sheet as a SIBLING after it. Three things follow from
// where that is:
//
//   - REACH. The sheet is `absolute inset-0` against SheetHost's box, which is
//     the whole links section — the docked rail as well as the screen. Drawn
//     inside the links screen it stopped at the rail's edge: the dim left the
//     rail live beside an open form and the card centred over the list rather
//     than the window (measured on the iPad (A16) simulator).
//   - CONTEXT. A body sees the links layout's providers — the signed-in ones
//     (`useLinkMutations` reads `useSync()`) and LinksPageProvider.
//   - THE LOCK. It is inside AppLockGate's hidden wrapper, so a relock hides an
//     open sheet with the rest of the app and gives it back, draft intact, on
//     unlock — where the root PortalHost's overlays have to unmount
//     (useAppCovered) and a `Modal` had to gate its own `visible`.
//
// ⚠ NOT PORTALED, and it was, briefly, which is how this was learnt.
// @rn-primitives/portal hands its children to the host through a store set
// from an EFFECT, so the host renders them a commit after the caller did. A
// controlled TextInput in there can therefore re-render with a value one
// keystroke OLD after the native field has moved on, and React Native writes that
// stale value back: on the Pixel 8 AVD a Maestro `inputText` of `https://…` came
// out `htps://…`, again and again — the second `t` typed onto a field just reset
// to `ht`. Nothing reports it; the app simply eats a character now and then. A
// body whose state lives OUTSIDE the portal (all three do: the draft is the
// opener's) must render in the tree its state lives in.
//
// Pickers opened from a sheet are the kit's Dialogs, which portal to the ROOT
// host — above the links section on both platforms (on iOS inside a
// FullWindowOverlay) — so they stack over the sheet as a child over its parent,
// and so does the paywall. (Their own inputs keep their state inside the
// portaled content, which is what makes the store hop harmless there.)
//
// THE CALLER OWNS EVERYTHING ABOUT CLOSING. `onClose` is the deliberate door
// (the ✕; a body's Cancel calls the same thing), `onDismiss` the ACCIDENTAL
// vectors — a backdrop tap and Android's back — which an editor holding work
// swallows by not closing (docs/editors.md, invariant 3). Mount the sheet only
// while it is open: a fresh mount is a fresh draft, and there is no "closed"
// state to animate back to.

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BackHandler, Keyboard, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { useIsFocused } from '@react-navigation/native';
import { X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { useAppCovered } from '../../contexts/app-cover';
import type { FocusedFieldReveal } from '../../lib/use-focused-field-reveal';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';
import { Button } from './button';
import { Icon } from './icon';
import { NativeOnlyAnimatedView, POPUP_FADE_MS } from './native-only-animated-view';
import { Text } from './text';

// Composite components need the wrapper to accept `className` (the note in
// components/landing.tsx).
const StyledKeyboardAvoidingView = withUniwind(KeyboardAvoidingView);
const StyledAnimatedView = withUniwind(NativeOnlyAnimatedView);
const StyledAnimatedScrollView = withUniwind(Animated.ScrollView);

// The arrival, per shape. The SHEET slides from the edge it is anchored to;
// `translateY` as a percentage moves it by its OWN height whatever the form's,
// a transform costs no layout pass, and the curve is iOS's own sheet bezier. The
// dim fades on its own (a dim that slides with the panel reads as a moving
// wall — ui/dialog.tsx pairs them the same way). The CARD is anchored to no
// edge, so it fades in with its dim on the dialog kit's POPUP_FADE_MS.
//
// SHARED VALUES, NOT `entering`/`exiting`, and the reason is measured: with
// `SlideInDown`/`FadeIn` on these views the FOURTH open on the Pixel 8 AVD
// mounted the panel OFF SCREEN — the backdrop painted, the accessibility tree
// held every field, nothing was visible, and the back key was the only way out.
// It went away only when the entering descriptors went too. Layout animations on
// a conditionally-mounted subtree inside a live screen are what this app cannot
// rely on; a shared value is fully controlled and cannot strand the view.
const SHEET_CURVE = Easing.bezier(0.32, 0.72, 0, 1);
const SHEET_MS = 300;
const DIM_MS = 200;

// How far, or how fast, a downward drag on the sheet's header has to go to
// count as a dismissal — past it the sheet asks `onDismiss`, short of it (or
// when the caller swallows the dismissal) it springs home.
const DRAG_DISMISS_PT = 96;
const DRAG_DISMISS_VELOCITY = 900;

type SheetHostValue = { register: () => () => void; covered: boolean };
const SheetHostContext = createContext<SheetHostValue | null>(null);

/**
 * The box sheets cover, and the count of open ones. Its children are the
 * openers' hosts, ending in the `SheetCovered` content; each sheet is drawn as a
 * sibling AFTER that content, `absolute inset-0` against this box (the header).
 */
export function SheetHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(0);
  const [register] = useState(() => () => {
    setOpen((n) => n + 1);
    return () => setOpen((n) => n - 1);
  });
  const value = useMemo(() => ({ register, covered: open > 0 }), [register, open]);

  return (
    <SheetHostContext.Provider value={value}>
      <View className="flex-1">{children}</View>
    </SheetHostContext.Provider>
  );
}

/**
 * The content a sheet covers. While any sheet is open it leaves the
 * accessibility tree: iOS gets that twice over (this, and the sheet's own
 * `accessibilityViewIsModal`, which hides its SIBLINGS — and this wrapper is
 * one), Android only from this. Android ignores both props under RN 0.81/Fabric;
 * they stay because they are the correct spelling (docs/accessibility.md,
 * _modality_).
 */
export function SheetCovered({ children }: { children: ReactNode }) {
  const host = useContext(SheetHostContext);
  const covered = host?.covered ?? false;
  return (
    <View
      importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={covered}
      collapsable={false}
      className="flex-1"
    >
      {children}
    </View>
  );
}

/**
 * Whether a sheet is open over the links section — for the covered content's
 * own Android back handlers, which must stand down while one is (the Sheet's
 * back note: a handler that re-registers while a sheet is open jumps ahead of
 * the sheet's).
 */
export function useSheetOpen(): boolean {
  return useContext(SheetHostContext)?.covered ?? false;
}

export function Sheet({
  title,
  description,
  closeLabel,
  closeTestID,
  onClose,
  onDismiss,
  reveal,
  footer,
  takesFocus = false,
  children,
}: {
  title: string;
  /** One muted line under the title — the link editor's URL. */
  description?: string;
  closeLabel: string;
  closeTestID?: string;
  /** The ✕ — a deliberate close, never guarded. */
  onClose: () => void;
  /** A backdrop tap or Android's back — swallow it to guard a draft. */
  onDismiss: () => void;
  /** The body scroller's focus tracking (lib/use-focused-field-reveal.ts). */
  reveal: FocusedFieldReveal;
  /** The action row, PINNED below the scroller. */
  footer?: ReactNode;
  /** The body autofocuses a field of its own (the add panel's URL). */
  takesFocus?: boolean;
  children: ReactNode;
}) {
  const host = useContext(SheetHostContext);
  if (!host) throw new Error('Sheet must be rendered inside a SheetHost');
  const { register } = host;
  useEffect(register, [register]);

  // Drop the keyboard on the way in — ui/dialog.tsx's reason: the field that
  // had focus before the press that opened this (the links search box, under
  // Advanced Search) survives the press, stays focused BEHIND the sheet and
  // takes the next keystroke unseen.
  //
  // NOT for a body that autofocuses a field (`takesFocus`): the body mounts in
  // this same commit and child layout effects run first, so a dismiss here
  // would blur the field the body has just focused. Its own focus moves off the
  // field behind anyway.
  useLayoutEffect(() => {
    if (!takesFocus) Keyboard.dismiss();
    // Once, at the arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android's hardware back, which nothing else claims while a sheet is up.
  // Returning true consumes the press either way — the caller closes or
  // swallows — so it can never fall through to the navigator and pop the links
  // screen out from under the sheet. iOS-safe by construction: BackHandler has
  // no events there.
  //
  // ⚠ REGISTERED ONCE, at mount, reading the rest through a ref. BackHandler
  // runs listeners newest-first, and a picker opened from the body (ListSelect,
  // TagsField — kit Dialogs) registers its own after this one, so it answers
  // back first and closes itself. Re-registering on a dep would undo that: the
  // callers' `onDismiss` is a fresh closure every render, so toggling a tag in
  // the open Tags picker moved this handler back on top, and the next back press
  // went to the sheet instead — swallowed as dead with a dirty draft, or closing
  // the form under the picker with a clean one.
  //
  // And the gates are checked in the handler, not by registering and
  // unregistering — for the same ordering reason. The sheet stays mounted while
  // another route covers the links section (the paywall's Upgrade pushes
  // Subscription over an open Advanced Search) and while a relock hides it
  // (AppLockGate); BackHandler is app-global, so an ungated handler took the back
  // press meant for that screen — topbar.tsx's SEARCH-002 trap. Off-duty it
  // returns false, so the press falls through to whoever owns it.
  //
  // Registering once only holds the order if nothing BELOW re-registers while
  // the sheet is up, and topbar.tsx's search handler does, on regaining focus:
  // back from Subscription with Advanced Search still open, it landed on top
  // and the first back press closed the search row under the sheet. So the
  // covered content's handlers stand down while a sheet is open
  // (`useSheetOpen`) rather than racing it.
  const focused = useIsFocused();
  const covered = useAppCovered();
  const backRef = useRef({ onDismiss, live: focused && !covered });
  useLayoutEffect(() => {
    backRef.current = { onDismiss, live: focused && !covered };
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!backRef.current.live) return false;
      backRef.current.onDismiss();
      return true;
    });
    return () => sub.remove();
  }, []);

  const insets = useSafeAreaInsets();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  // Live, so a rotation or a Split View drag across 768 re-shapes an open sheet
  // — the tree is the same in both, so nothing in it is lost.
  const wide = useWideWindow();

  // 1 = home; 0 = parked below the bottom edge (sheet) or transparent (card).
  // Driven once, on mount — the sheet is only mounted while open — with the
  // shape's timing read then: a later `wide` flip finds the value already at 1
  // and moves nothing.
  const enter = useSharedValue(0);
  useEffect(() => {
    enter.set(
      withTiming(
        1,
        wide
          ? { duration: POPUP_FADE_MS, reduceMotion: ReduceMotion.System }
          : { duration: SHEET_MS, easing: SHEET_CURVE, reduceMotion: ReduceMotion.System },
      ),
    );
    // `wide` is read once, at the arrival — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enter]);

  // `height` is 0 → negative keyboard height, on the UI runtime so the inset
  // disappears WITH the avoider's lift instead of one React render after
  // `keyboardDidShow` (`useKeyboardState` is not equivalent: it settles after
  // the keyboard has finished moving, and the panel visibly contracts). The
  // SAME number serves both shapes: "the bottom inset while the keyboard is
  // down, nothing while it is up" — a keyboard's frame runs to the bottom of the
  // screen and contains the home indicator, so the inset on top of the
  // avoider's full lift is ~34pt of empty background between the footer and the
  // keys (the share sheet's formula, docs/share-sheet.md). The sheet pays it
  // inside its own fill, the card as the gutter beneath it.
  // A downward drag on the header, the narrow shape's swipe-to-dismiss (the
  // header's gesture, below). Added to the arrival's translate in POINTS — the
  // arrival is a percentage of the panel's own height, the drag follows the
  // finger — so the two compose as a transform list.
  const drag = useSharedValue(0);
  const panelStyle = useAnimatedStyle(() =>
    wide
      ? { opacity: enter.get() }
      : {
          paddingBottom: Math.max(insets.bottom + keyboardHeight.get(), 0),
          transform: [{ translateY: `${(1 - enter.get()) * 100}%` }, { translateY: drag.get() }],
        },
  );

  // SWIPE-DOWN, on the narrow shape only, because it is the gesture an iOS
  // sheet teaches — and the one the presented route this replaced had for free.
  // It matters more than it looks: on a phone a tall form (the link editor,
  // Advanced Search) fills the window to its top gutter, and the strip left
  // above it is the status bar, whose touches iOS keeps — measured, a tap there
  // never reached the backdrop. So without this the only ways out were the ✕
  // and Cancel. It is an ACCIDENTAL vector like the backdrop, so it asks
  // `onDismiss`, and a guarded draft springs back home rather than closing.
  //
  // On the HEADER, not the panel: the body is a scroller whose own downward
  // drag must scroll it (and, `interactive`, walk the keyboard down). The card
  // has none — it is anchored to no edge, so there is nowhere for "down" to
  // take it. Vertical only, and only once it is clearly vertical
  // (`activeOffsetY`), so a tap on the ✕ is still a tap.
  const swipe = Gesture.Pan()
    .enabled(!wide)
    .activeOffsetY(8)
    .failOffsetX([-16, 16])
    .onUpdate((e) => {
      drag.set(Math.max(e.translationY, 0));
    })
    .onEnd((e) => {
      if (e.translationY > DRAG_DISMISS_PT || e.velocityY > DRAG_DISMISS_VELOCITY) {
        scheduleOnRN(onDismiss);
      }
      drag.set(withSpring(0, { duration: SHEET_MS, dampingRatio: 1 }));
    });
  const gutterStyle = useAnimatedStyle(() => ({
    paddingBottom: wide ? Math.max(insets.bottom + keyboardHeight.get(), 0) + 8 : 0,
  }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: withTiming(enter.get() > 0 ? 1 : 0, {
      duration: wide ? POPUP_FADE_MS : DIM_MS,
      reduceMotion: ReduceMotion.System,
    }),
  }));

  return (
    <>
      {/* `accessibilityViewIsModal`: VoiceOver ignores the sibling subtrees
          while this is up, so a swipe can't walk out of the form into the list
          behind it. SheetHost hides the covered subtree for Android. */}
      <View accessibilityViewIsModal className="absolute inset-0">
        {/* The backdrop — web's outside-click, and guarded like it: the caller's
            `onDismiss` decides. `bg-black/50` is web's SheetOverlay, not the
            dialogs' `/80` (docs/theme.md, _the two kits_), and the card keeps
            the sheet's scrim, so a rotation across 768 changes the surface and
            not the room behind it. `accessible={false}` for share-kit.tsx's
            reason — as a focus stop it would announce as one enormous
            unlabelled control over the whole screen.

            A SIBLING of the avoider, not a child: `absolute inset-0` resolves
            against the parent's PADDING box (docs/soft-keyboard.md, _the
            traps_), so inside the avoider it would stop below the top gutter,
            and a tap in that strip would fall through to the screen instead of
            closing. Driven on the emulator: the tap did nothing at all, which is
            indistinguishable from a swallowed one. */}
        <StyledAnimatedView
          as="Pressable"
          accessible={false}
          onPress={onDismiss}
          style={dimStyle}
          className="absolute inset-0 bg-black/50"
        />
        {/* The avoider spans the window so the panel can be parked on the
            keyboard (sheet) or centred in what it leaves (card), and
            `max-h-full` below resolves against "the window minus the keyboard"
            with nothing measured — keyboard-controller's, for ui/dialog.tsx's
            reasons. `box-none` (here and on the gutter box) so the empty space
            around the panel is the backdrop's to tap.

            The top gutter is DialogOverlay's `inset + 8`: padding, so the cap
            sees it and a maxed-out form stops short of the notch. The sheet's
            SIDES take the bare insets — it is edge-attached, so where a side
            inset is 0 it still meets the screen's edge, and where it is not (a
            landscape notch, the iPhone Duo's outer display, which reserves a
            strip down its trailing edge at phone width) the ✕ stays out of it.
            The card is detached on every side and takes DialogOverlay's whole
            rule. */}
        <StyledKeyboardAvoidingView
          pointerEvents="box-none"
          behavior="padding"
          className="flex-1"
          style={{
            paddingTop: insets.top + 8,
            paddingLeft: insets.left + (wide ? 8 : 0),
            paddingRight: insets.right + (wide ? 8 : 0),
          }}
        >
          {/* The BOTTOM gutter, the one box the shapes disagree on. The avoider
              cannot carry it: under `behavior="padding"` it writes its own
              `paddingBottom` over any the style sets. The sheet needs none; the
              card's is `inset + 8` with the keyboard down and 8 with it up
              (`gutterStyle`). Padding here rather than the card's margin
              because `max-h-full` resolves against this box's padded height: a
              margin would let a maxed-out card overflow by the margin, and
              centring would push half of that past the top gutter. */}
          <StyledAnimatedView
            pointerEvents="box-none"
            className={cn('flex-1', wide ? 'justify-center' : 'justify-end')}
            style={gutterStyle}
          >
            {/* The panel, in one of TWO SHAPES. A bottom sheet promises contact
                with the keyboard's top edge, and on an iPad that edge often is
                not where keyboard-controller says: the keyboard can float,
                undock or split, a hardware keyboard swaps it for the shortcuts
                bar, and the library lifts by the keyboard frame's HEIGHT
                whatever its origin. A sheet then hangs off the bottom edge or
                stops short of the keys, and reads as broken. A card promises no
                contact — the same error moves its centre by half and leaves it
                whole — and it is the iPadOS idiom for a native form sheet
                (docs/soft-keyboard.md, _the in-app sheet_).

                Radius: the floating-surface `2xl` both ways — `rounded-t-2xl`
                on the sheet, whose bottom corners belong to the screen, all four
                on the card (docs/theme.md, _the radius scale_). Widths: the
                sheet caps at `max-w-xl` and centres, which binds only between
                `sm` and 768 (a phone on its side, an iPad in Slide Over), and
                `sm:border-x` gives its detached sides the top's edge; the card
                is `max-w-lg`, one step past the dialog kit's `max-w-md`, so a
                picker opened from it reads as a child over it. `bg-popover`, the
                fill of every floating surface (docs/theme.md, _elevation_): in
                dark it is the whole of what separates the panel from the
                scrimmed screen behind.

                A PRESSABLE, and not for the press: a plain View is not a touch
                target, so a tap on the panel's own chrome — the header's empty
                middle, a seam — would fall through to the backdrop and discard
                the draft. Claiming those taps is the job; dropping the keyboard
                is what to do with them (the scroller covers the body). */}
            <StyledAnimatedView
              as="Pressable"
              accessible={false}
              onPress={Keyboard.dismiss}
              className={cn(
                'max-h-full w-full self-center border-border bg-popover',
                wide
                  ? 'max-w-lg rounded-2xl border shadow-lg shadow-black/5'
                  : cn(
                      'max-w-xl rounded-t-2xl border-t sm:border-x',
                      (insets.left > 0 || insets.right > 0) && 'border-x',
                    ),
              )}
              style={panelStyle}
            >
              {/* A sheet header, not an app bar: `top-3.5` puts the ✕'s centre
                  on the title's (32pt), `pb-6` is the whole title-to-form gap,
                  and there is no divider — one continuous surface, as
                  ui/dialog.tsx draws it.

                  The title column's width must be DEFINITE. Sized to its own
                  content, Android/Fabric kept a stale paint clip when the
                  avoider's padding relaid out this transformed panel: the a11y
                  bounds stayed right while the paint came up short after the
                  keyboard closed. A column child is stretched to the header's
                  width (the ✕ is absolute, so no row shares it) — NOT `flex-1`,
                  which in a column acts on height. */}
              <GestureDetector gesture={swipe}>
                <View className="relative shrink-0 gap-0.5 pt-5 pr-14 pb-6 pl-4">
                  <Text role="heading" className="text-base font-medium">
                    {title}
                  </Text>
                  {description !== undefined && (
                    <Text numberOfLines={1} className="text-xs text-muted-foreground">
                      {description}
                    </Text>
                  )}
                  {/* web-ui `sheet.tsx`'s SheetCloseButton, one touch step taller
                    (36 against 32 — docs/theme.md, _the two kits_), which is why
                    `top-3.5` where web says `top-3`. 52x52 effective: the title
                    is a Text and the header reserves `pr-14`, so 8 of slop
                    lands inside the header's own box. */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    testID={closeTestID}
                    onPress={onClose}
                    aria-label={closeLabel}
                    hitSlop={8}
                    className="absolute top-3.5 right-3"
                  >
                    <Icon as={X} className="size-4" />
                  </Button>
                </View>
              </GestureDetector>
              {/* The body's ONE scroller. `shrink` is what lets the cap reach it
                  instead of pushing the header off the top. `handled` keeps a
                  tap on a control while chrome drops the keyboard. `interactive`
                  rather than the app's usual `on-drag`, so an upward drag can
                  scroll a lower field clear without dropping the keyboard and
                  re-growing the panel (Android maps it to `none`).

                  No aware scroller — it cannot nest inside the avoider (it pads
                  its own content by the keyboard a second time) — so the
                  focused field is kept above the fold by `reveal`, which scrolls
                  it to the viewport's bottom edge; the 16 between it and the
                  buttons is the footer's `pt-4`. No end padding while a footer
                  shows, for that reason: end padding is the last thing in the
                  scroll and would be scrolled away exactly when the fields
                  overflow. */}
              <StyledAnimatedScrollView
                ref={reveal.scrollRef}
                onScroll={reveal.onScroll}
                scrollEventThrottle={16}
                className="shrink grow-0"
                contentContainerClassName={cn('px-4', footer === undefined && 'pb-4')}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                <View ref={reveal.content} onLayout={reveal.onContentLayout} className="gap-4">
                  {children}
                </View>
              </StyledAnimatedScrollView>
              {/* PINNED below the scroller rather than its last child, so the
                  commit button stays in view while the fields scroll — and,
                  since the whole panel rides the keyboard, on the keys while
                  something is typed. `shrink` squeezes only the fields. */}
              {footer !== undefined && (
                <View className="shrink-0 flex-row justify-end gap-2 px-4 pt-4 pb-4">{footer}</View>
              )}
            </StyledAnimatedView>
          </StyledAnimatedView>
        </StyledKeyboardAvoidingView>
      </View>
    </>
  );
}
