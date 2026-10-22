// Quick-add for links — the expo port of bracemark-web's LinkAddSurface
// (`(app)/links/_components/link-add-surface.tsx`, the canonical doc for the
// behavior: the two-tier validation — a HARD empty-URL error vs the SOFT
// malformed/duplicate/trashed warnings that relabel Save → Confirm; why the
// trashed ground alone offers Restore; why the quota banner REPLACES the form;
// the optionalDirty close guard). Web anchors that form to a popover only at
// `md` and up, and fills a bottom sheet below it. This file draws the same
// split on the same width (lib/window-class.ts): the bottom sheet on a narrow
// window, and on a wide one a CENTRED CARD rather than an anchored popover —
// the summoning control is a FAB, which is no anchor, and a surface with the
// keyboard up has no room to hang a form off a corner. Why the wide window
// needs a different shape at all is in the panel's JSX, below.
//
// IT IS NOT A ROUTE, and that is the load-bearing decision here. LinkAddHost
// renders it (link-add-host.tsx, which `(app)/links/_layout.tsx` wraps around
// the links Drawer) while its `adding` state is true; the FAB flips that state. Three measured
// facts pushed it out of expo-router, all of them in react-native-screens 4.16
// and all of them silent — the derivations live in docs/soft-keyboard.md,
// _the add panel_:
//
//  - **A `formSheet` sized to its contents has no Android half.** With
//    `sheetAllowedDetents: 'fitToContents'` the sheet DISAPPEARS there the
//    moment the keyboard is up (`SheetDelegate.kt` never sizes a one-detent
//    sheet while the IME is visible). A quick-add whose URL field autofocuses
//    is exactly that case.
//  - **A fitted sheet may hold no scroller.** RNS seizes the first descendant
//    ScrollView in a form sheet and forces its frame to the sheet's, which
//    against a sheet sized FROM its content is circular: measured, the form
//    painted clipped at a stale frame and the sheet inflated to its maximum
//    detent whatever height the scroller was given. No scroller means no
//    `keyboardShouldPersistTaps` and no `keyboardDismissMode` — two of the
//    three dismissal paths — and a form that outgrows the sheet clips rather
//    than scrolls.
//  - **A transparent modal ROUTE drops the accessibility tree.** Present one a
//    second time and the whole app's a11y tree comes back empty — not just this
//    surface's, the links screen's too — so VoiceOver finds nothing and every
//    Maestro flow that opens it twice fails against a screen that is plainly on
//    display. Reproduced with `transparentModal`, `containedTransparentModal`
//    and `containedModal` + a transparent `contentStyle`, with animations off;
//    NOT reproduced with an opaque `modal` or with the form sheet. The line it
//    falls on is the presentations that keep the screen below attached — which
//    is the property that lets a dim show the live list.
//
// In the screen's own tree none of that applies: there is no presentation, so
// there is nothing to measure the height, nothing to seize the scroller and no
// modal container to lose. What the route WAS providing has to be provided
// here, and each piece is one line:
//   • a fresh draft per open — the host mounts this only while `adding`,
//     so closing unmounts it (the ephemeral-action rule from web's header: the
//     draft is component state, never the URL);
//   • Android's hardware back — a BackHandler that swallows the press while the
//     optional section holds work and closes otherwise, which is exactly what
//     `usePreventRemove` was doing;
//   • modality for a screen reader — `accessibilityViewIsModal` on iOS, and the
//     host hides the subtree behind us on Android
//     (`importantForAccessibility`), which a presented route got for free.
// The pre-selected list is no longer a route param either: this sits INSIDE
// LinksPageProvider now, so it reads the viewing list itself (web's
// useDefaultListId).
//
// The three keyboard mechanisms are the ordinary ones, and they are the same
// three `ui/dialog.tsx` uses — that file's comments are the canonical
// derivation:
//   avoidance — keyboard-controller's `KeyboardAvoidingView` owns the full
//     height and parks the sheet on the keyboard's top edge (`justify-end`),
//     or centres the card in what the keyboard leaves (`justify-center`).
//     `behavior="padding"`, so `max-h-full` on the panel resolves against "the
//     window minus the keyboard" without measuring anything.
//   the squeeze — `max-h-full` needs `shrink` on the one scroller the body
//     owns, because RN children do not shrink by default; without it the cap
//     pushes the header off the top instead.
//   dismissal — the scroller's `keyboardShouldPersistTaps="handled"` (a tap on
//     a control still reaches it; a tap on padding drops the keyboard) and
//     `keyboardDismissMode="interactive"` (an upward drag keeps the keyboard
//     while scrolling the expanded form; a downward drag can dismiss on iOS,
//     and Android maps it to `none`).
// The backdrop is the fourth: it is web's outside-click, and it is guarded the
// same way — swallowed while the optional section holds work.
//
import { type ComponentRef, useEffect, useState } from 'react';
import { BackHandler, Keyboard, View } from 'react-native';
import {
  KeyboardAvoidingView,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  Easing,
  measure,
  ReduceMotion,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  type LinkItem,
  readLinkByUrlKey,
  useExtraction,
  useLinkMutations,
  useLinkQuota,
} from '@stxapps/expo-react';
import {
  DEFAULT_LIST_ID,
  LINK_NOTE_MAX,
  normalizeUrl,
  PLAN_LABELS,
  TRASH_ID,
} from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { LabeledField } from '../../components/links/labeled-field';
import { LinkQuotaBanner } from '../../components/links/link-quota-banner';
import { ListSelect } from '../../components/links/list-select';
import { TagsField } from '../../components/links/tags-field';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import {
  NativeOnlyAnimatedView,
  POPUP_FADE_MS,
} from '../../components/ui/native-only-animated-view';
import { Text } from '../../components/ui/text';
import { Textarea } from '../../components/ui/textarea';
import { noteReviewMoment } from '../../lib/review-prompt';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';
import { useLinksPage } from './page-provider';

// Composite components need the wrapper to accept `className` (the note in
// components/landing.tsx).
const StyledKeyboardAvoidingView = withUniwind(KeyboardAvoidingView);
const StyledAnimatedView = withUniwind(NativeOnlyAnimatedView);
const StyledAnimatedScrollView = withUniwind(Animated.ScrollView);

// The panel's arrival, per shape (the two shapes: the panel's JSX below). The
// SHEET slides from the edge it is anchored to, which is also the edge the FAB
// that summoned it sits on — spatial consistency, the one purpose that earns
// motion on a surface opened a few times a day. `translateY` as a percentage
// moves the panel by its OWN height whatever the form's, and a transform costs
// no layout pass; the curve is iOS's own sheet bezier rather than an
// approximation, and the dim fades on its own (a dim that slides with the panel
// reads as a moving wall — `ui/dialog.tsx` pairs them the same way). The CARD is
// anchored to no edge, so it has no direction to arrive from: it fades in with
// its dim on the dialog kit's POPUP_FADE_MS, which is what every other centred
// surface on this side does, the pickers it opens included.
//
// SHARED VALUES, NOT `entering`/`exiting`. This is the one place in the app that
// does not use the layout-animation descriptors, and the reason is measured: with
// `SlideInDown`/`FadeIn` on these two views, the FOURTH open on the Pixel 8 AVD
// mounted the panel OFF SCREEN — the backdrop painted, the accessibility tree
// held every field, and nothing was visible, leaving a dimmed screen with no way
// out but the back key. It survived dropping the exiting descriptors and went
// away only when the entering ones went too (open/close cycled a dozen times
// after, clean). Layout animations on a conditionally-mounted subtree inside a
// live screen are what this app cannot rely on; a shared value driven from an
// effect is fully controlled and cannot strand the view. `ReduceMotion.System`
// is still the house spelling, and `withTiming` takes it in its config.
const SHEET_CURVE = Easing.bezier(0.32, 0.72, 0, 1);
const SHEET_MS = 300;
const DIM_MS = 200;

export function LinkAddPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const scrollRef = useAnimatedRef<ComponentRef<typeof Animated.ScrollView>>();
  const scrollOffset = useScrollOffset(scrollRef);
  const noteFocused = useSharedValue(false);
  // Note's native tag, from its first focus — what keyboard events carry as
  // `target` (see the keyboard handler below for why it, not `noteFocused`).
  const noteTag = useSharedValue(-1);
  // Note's bottom edge in the scroller's CONTENT coordinates. Note is the last
  // child of the optional section, so it is that section's bottom (its
  // onLayout, below) — and it re-fires as the multiline Textarea grows.
  const noteBottom = useSharedValue(0);
  const { selection } = useLinksPage();
  // The shape: a bottom sheet below the docking width, a centred card at and
  // above it (the panel's JSX carries why). Live, so a rotation or a Split View
  // drag across 768 re-shapes an open panel; the tree is the same in both, so
  // the draft, the focus and the scroll survive the switch.
  const wide = useWideWindow();
  // 1 = home; 0 = parked below the bottom edge (sheet) or transparent (card).
  // Driven once on mount; the panel is only mounted while it is open
  // (link-add-host.tsx), so there is no "closed" state to animate back to. The
  // timing is read at mount — a re-run on a later `wide` flip finds the value
  // already at 1 and moves nothing.
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
  }, [enter, wide]);
  // `height` is 0 → negative keyboard height. Keeping this arithmetic on the UI
  // runtime makes the inset disappear with the avoider's lift instead of one
  // React render after `keyboardDidShow`. The SAME number serves both shapes:
  // it is "the bottom inset while the keyboard is down, nothing while it is up"
  // (the panel's bottom padding note, below), which the sheet pays inside its
  // own fill and the card pays as the gutter beneath it.
  const panelStyle = useAnimatedStyle(() =>
    wide
      ? { opacity: enter.get() }
      : {
          paddingBottom: Math.max(insets.bottom + keyboardHeight.get(), 0),
          transform: [{ translateY: `${(1 - enter.get()) * 100}%` }],
        },
  );
  const gutterStyle = useAnimatedStyle(() => ({
    paddingBottom: wide ? Math.max(insets.bottom + keyboardHeight.get(), 0) + 8 : 0,
  }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: withTiming(enter.get() > 0 ? 1 : 0, {
      duration: wide ? POPUP_FADE_MS : DIM_MS,
      reduceMotion: ReduceMotion.System,
    }),
  }));
  const { create, update } = useLinkMutations();
  const { extractNow } = useExtraction();
  const { count, max, atLimit } = useLinkQuota();

  // Web's useDefaultListId, computed here rather than by the FAB now that this
  // sits inside LinksPageProvider: the list the user is viewing, so "add" lands
  // where they are looking — falling back to My List, the inbox, for the All
  // view or a tag view (neither names a single destination list) and for Trash,
  // which is the deletion staging area and never a place to add.
  const defaultListId =
    selection.kind === 'list' && selection.id !== TRASH_ID ? selection.id : DEFAULT_LIST_ID;

  const [openOptional, setOpenOptional] = useState(false);
  const [url, setUrl] = useState('');
  const [listId, setListId] = useState(defaultListId);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // urlError is a HARD, blocking error (empty URL); urlWarning is the SOFT
  // state that relabels Save → Confirm and lets the next submit through. Three
  // grounds, checked in order on submit — 'malformed' (can't normalize), then
  // the already-saved pair 'trashed' / 'duplicate' — so a URL that's both warns
  // on each ground in turn. Editing the field disarms whichever is showing.
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlWarning, setUrlWarning] = useState<'malformed' | 'duplicate' | 'trashed' | null>(null);
  // The trashed link behind a 'trashed' warning — what Restore acts on. Held
  // from the submit that found it, so Restore doesn't re-query.
  const [trashedMatch, setTrashedMatch] = useState<LinkItem | null>(null);

  // Which of the three OPTIONAL fields hold something — URL is the required one
  // (web's optionalSet, verbatim — its
  // comment is canonical: COLLAPSING THE SECTION DOES NOT DISCARD THEM, Save uses
  // these values either way, and the dot on the trigger is what keeps the hidden
  // state visible).
  const optionalSet = [
    listId !== defaultListId ? 'list' : null,
    tagIds.length > 0 ? 'tags' : null,
    note.trim() !== '' ? 'note' : null,
  ].filter((field) => field !== null);

  // Does closing now lose real work? A bare typed URL doesn't count — it's
  // cheap to retype, and the swipe-down-to-dismiss idiom is worth more than
  // guarding it. Only the optional fields represent effort worth protecting
  // (web's optionalDirty, verbatim).
  const optionalDirty = optionalSet.length > 0;

  // The close guard, which used to be `usePreventRemove` on the route: while the
  // optional section holds work, the ACCIDENTAL vectors are swallowed silently
  // — web's onOpenChange guard eats its outside-click the same way, and ✕ /
  // Cancel stay the deliberate discard doors. On a route that meant the swipe
  // and the back gesture; in the tree it means the backdrop (below) and this:
  //
  // Android's hardware back, which nothing else claims now. Returning true
  // consumes the press either way — swallowed while dirty, a close otherwise —
  // so it can never fall through to the navigator and pop the links screen out
  // from under the panel. The subscription hangs off `optionalDirty` so the
  // handler always closes over the current answer, and it is iOS-safe by
  // construction: BackHandler has no events there.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!optionalDirty) onClose();
      return true;
    });
    return () => sub.remove();
  }, [optionalDirty, onClose]);

  // Keep a focused Note above the fold. The outer avoider is the ONE keyboard
  // owner: it shrinks this scroller's viewport frame by frame but keeps its
  // offset, so a Note near the form's end sinks behind the keyboard. Each call
  // scrolls to the ABSOLUTE offset that puts Note's bottom on the viewport's, and
  // only ever downward. ON it, not above it: Note is the content's last child and
  // the scroller has no end padding (the 16 above Save is the footer's `pt-4`,
  // below), so this is the furthest the content can scroll — a target past it
  // would ask the scroller to overshoot its own end. Absolute, not "offset + overlap":
  // Note's measured pageY inside a scroller comes from the shadow tree's copy of
  // the content offset, which native updates asynchronously, so an overlap
  // measured right after a scrollTo is stale and would be added twice. The
  // viewport's own height and Note's content position do not depend on it.
  const revealNote = (animated: boolean) => {
    'worklet';
    const viewport = measure(scrollRef);
    if (viewport === null) return;
    const target = noteBottom.get() - viewport.height;
    if (target > scrollOffset.get()) scrollTo(scrollRef, 0, target, animated);
  };
  // The keyboard's own per-frame events, so the scroll moves WITH the keyboard.
  // Not `useReanimatedKeyboardAnimation().height`: on iOS the provider writes it
  // once, at the start, already holding the final height — a reaction on it runs
  // a single time, before the avoider has moved, and never again. `measure` sees
  // the layout committed last frame, so the scroll trails the avoider by one
  // frame — Note's bottom edge can dip under the clip for that frame, into the
  // footer's blank `pt-4` band rather than behind Save — and `onEnd` re-checks
  // after the last commit.
  //
  // Gated on the event's `target` — the input focused at that moment, read on
  // the UI thread — and not on `noteFocused`, which JS clears in `onBlur`
  // several frames late. Moving focus from Note to URL resizes the keyboard
  // (Note has a suggestion bar, URL doesn't), and in those frames the flag
  // still said Note: the reveal yanked the form back down to Note, away from
  // the field just tapped.
  useKeyboardHandler(
    {
      onMove: (e) => {
        'worklet';
        if (e.target === noteTag.get()) revealNote(false);
      },
      onEnd: (e) => {
        'worklet';
        if (e.target !== noteTag.get()) return;
        requestAnimationFrame(() => {
          'worklet';
          revealNote(false);
        });
      },
    },
    [],
  );
  // What the keyboard does not announce: focus moving to Note under an
  // already-open keyboard (animated — nothing else is moving), and Note growing
  // a line as it is typed into (instant, as a native text view follows its
  // caret).
  useAnimatedReaction(
    () => ({ focused: noteFocused.get(), bottom: noteBottom.get() }),
    (now, prev) => {
      if (now.focused) revealNote(prev !== null && !prev.focused);
    },
  );

  const close = onClose;

  const onSubmit = async () => {
    if (saving) return;

    const trimmed = url.trim();
    // Required: an empty URL is a hard error and blocks the save.
    if (trimmed === '') {
      setUrlError('Please enter a URL.');
      setUrlWarning(null);
      return;
    }
    setUrlError(null);

    // Soft: a URL we can't normalize only warns. The first submit arms the
    // warning and relabels Save → Confirm; submitting again (Confirm) saves the
    // raw text as typed. A normalizable value (incl. a bare domain) saves the
    // normalized https:// form.
    const normalized = normalizeUrl(trimmed);
    if (normalized === null && urlWarning === null) {
      setUrlWarning('malformed');
      return;
    }

    setSaving(true);
    try {
      // Soft, second ground: the URL is already saved. Matched by canonical
      // dedup identity (readLinkByUrlKey — folds scheme/www/trailing slash/query
      // order), so trivial variants of a saved link warn too. A match in Trash
      // warns as 'trashed' instead, which adds Restore to the footer. Only checked
      // while neither is armed — an armed warning means the user has seen it, so
      // Confirm saves the duplicate deliberately.
      if (urlWarning !== 'duplicate' && urlWarning !== 'trashed') {
        const existing = await readLinkByUrlKey(normalized ?? trimmed);
        if (existing) {
          const inTrash = existing.listId === TRASH_ID;
          setUrlWarning(inTrash ? 'trashed' : 'duplicate');
          setTrashedMatch(inTrash ? existing : null);
          return;
        }
      }

      const created = await create({
        url: normalized ?? trimmed,
        listId,
        tagIds,
        note: note.trim() || undefined,
      });
      // The GESTURED extraction (docs/link-extraction.md — _the stance_): fetch
      // the page the user just handed us, right now, without waiting for the
      // drain and without needing the extraction mode to reach `all` — the save
      // IS the consent, exactly as the browser extension's active-tab capture
      // is. Mode `off` still stops it (extractNow checks); that position exists
      // precisely to decline this.
      // Fire-and-forget: the title/image land in `extractions/` and the row
      // repaints itself, so nothing here waits on the network.
      if (created) extractNow([created.path]);
      close();
      // A save that landed is the moment the app-store review prompt uses; it
      // decides for itself whether this one asks (lib/review-prompt.ts).
      if (created) noteReviewMoment();
    } finally {
      setSaving(false);
    }
  };

  // Restore the trashed match instead of minting a second copy — web's
  // onRestore, verbatim (that comment is canonical: the draft is the request
  // the user just made, so it wins over the old record's fields; tags UNION).
  const onRestore = async () => {
    if (!trashedMatch || saving) return;
    setSaving(true);
    try {
      const trimmedNote = note.trim();
      await update(trashedMatch, {
        listId,
        ...(tagIds.length > 0 ? { tagIds: [...new Set([...trashedMatch.tagIds, ...tagIds])] } : {}),
        ...(trimmedNote ? { note: trimmedNote } : {}),
      });
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    // The panel COVERS the links section rather than replacing it: an absolute
    // layer over LinkAddHost's box, which wraps the whole links Drawer
    // (link-add-host.tsx) — the docked rail on a wide window as well as the
    // screen — so `inset-0` reaches under the status bar and across the rail.
    // Drawn inside the screen it stopped at the rail's edge.
    //
    // `accessibilityViewIsModal` is what a presented route used to give for
    // free: VoiceOver ignores the sibling subtrees while this is up, so a swipe
    // can't walk out of the form into the list behind it. iOS reads this prop;
    // Android has no equivalent, so the host hides the subtree it covers with
    // `importantForAccessibility` while `adding` is true (docs/accessibility.md).
    <View accessibilityViewIsModal className="absolute inset-0">
      {/* The backdrop, which is web's outside-click and is guarded like it: a
          tap closes, unless the optional section holds work, in which case it is
          SWALLOWED — the same rule the back handler above applies, and the same
          one web's onOpenChange applies. ✕ and Cancel stay the deliberate doors.
          `bg-black/50` is web's SheetOverlay, not the dialogs' `/80`
          (docs/theme.md, _the two kits_): the twin of this surface is
          `SheetContent side="bottom"`, not DialogContent — and the card keeps
          the sheet's scrim, so a rotation across 768 changes the surface and not
          the room behind it. `accessible={false}` for share-kit.tsx's reason —
          as a focus stop it would announce as one enormous unlabelled control
          over the whole screen.

          It is a SIBLING of the avoider, not a child, and that is the whole
          reason it is spelled `absolute` here rather than wrapping: `absolute
          inset-0` resolves against the parent's PADDING box
          (docs/soft-keyboard.md, _the traps_), so inside the avoider it would
          stop below the top gutter — and a tap in that strip would fall through
          to the links screen instead of closing. Driven on the emulator before
          this moved out: the tap did nothing at all, which is indistinguishable
          from a swallowed one. */}
      <StyledAnimatedView
        as="Pressable"
        accessible={false}
        onPress={() => {
          if (!optionalDirty) close();
        }}
        style={dimStyle}
        className="absolute inset-0 bg-black/50"
      />
      {/* `pointerEvents="box-none"` is what makes the two work together: the
          avoider spans the window so the panel can be parked on the keyboard,
          but it must not be the touch target for the empty space above the
          panel — box-none lets those taps reach the backdrop while its children
          keep their own. The gutter box inside it says the same, for the same
          reason. */}
      <StyledKeyboardAvoidingView
        pointerEvents="box-none"
        behavior="padding"
        className="flex-1"
        // The gutter above a maxed-out panel, DialogOverlay's `inset + 8`
        // verbatim: `max-h-full` resolves against THIS box, so padding the top
        // is what stops a tall form from running under the notch — measured, an
        // expanded form with the keyboard up reaches the status bar without it.
        // Padding rather than a margin on the panel so the cap sees it.
        //
        // The sheet's SIDES take the bare insets, no gutter: it is
        // edge-attached, so where a side inset is 0 it should still meet the
        // screen's edge. They used to be absent, which held only while every
        // side inset was a landscape notch the width cap happened to clear. It
        // isn't: the iPhone Duo's outer display reserves a strip down its
        // trailing edge for the status bar and camera, at phone width, where the
        // panel spans the window and its ✕ (`right-3`) would sit inside that
        // strip (docs/expo-build.md, _devices_). Same per-edge rule as
        // DialogOverlay: each side its own inset, never one mirrored onto the
        // other. The card is detached on every side, so it takes DialogOverlay's
        // whole rule, inset + 8.
        style={{
          paddingTop: insets.top + 8,
          paddingLeft: insets.left + (wide ? 8 : 0),
          paddingRight: insets.right + (wide ? 8 : 0),
        }}
      >
        {/* The BOTTOM gutter, and the one box the two shapes disagree on. The
            avoider cannot carry it: under `behavior="padding"` it writes its own
            `paddingBottom` (the keyboard's overlap, 0 while closed) over any the
            style sets. The sheet needs none — it meets the bottom edge and pays
            the home indicator inside its own fill. The card floats, so the
            space under it is `inset + 8` with the keyboard down and 8 with it up
            (the keyboard's frame already holds the indicator — the panel's
            bottom-padding note, below), on the UI runtime with the avoider's
            lift (`gutterStyle`). Here rather than as the card's margin because
            `max-h-full` resolves against this box's padded height: a margin
            would let a maxed-out card overflow it by the margin, and centring
            would push half of that past the top gutter. */}
        <StyledAnimatedView
          pointerEvents="box-none"
          className={cn('flex-1', wide ? 'justify-center' : 'justify-end')}
          style={gutterStyle}
        >
          {/* The panel, in one of TWO SHAPES on the docking width
              (lib/window-class.ts, the rail's 768): a BOTTOM SHEET on a narrow
              window, a centred CARD on a wide one — web's own split, which turns
              quick-add from a bottom sheet into a popover at `md`.

              It used to be a bottom sheet at every width, capped at `max-w-xl`
              on the reasoning that every number here is about the bottom edge
              and none of it cares how wide the panel is. The iPad (A16)
              simulator disproved the first half. An edge-attached sheet is only
              right while the avoider's idea of the keyboard's top edge is the
              keyboard's real one, and on an iPad it often is not: the iPad's
              keyboard can float, undock or split, and a hardware keyboard
              replaces it with the shortcuts bar. keyboard-controller lifts by
              the keyboard frame's HEIGHT whatever that frame's origin (its
              `KeyboardMovementObserver`), and follows only the show and hide
              notifications, so a keyboard that is not docked at the bottom
              still lifts the sheet by its full height. The sheet then hangs
              that far off the bottom edge with nothing under it, or its footer
              stops short of the keys, and either reads as broken because the
              whole promise of the shape is contact with that edge. A card
              promises no contact. The same error moves its centre by half the
              error and leaves it whole, inside "the window minus the keyboard"
              as before. It is also the iPadOS idiom (a form sheet is a centred
              card) and what this app's dialogs already are.

              What the two share is everything that is not the frame: the
              avoider, the cap, the shrinking scroller, the pinned footer and
              every dismissal path. So the card's footer is still pinned below
              the scroller, because Save must stay in view while the fields
              scroll. It is just not ON the keyboard, since nothing here is.

              `max-h-full` resolves against the gutter box — "the window minus
              the keyboard, minus the gutters" — and the radius is the
              floating-surface `2xl` both ways (docs/theme.md, _the radius
              scale_): `rounded-t-2xl` on the sheet, whose bottom corners belong
              to the screen, all four on the card, matching web quick-add's
              popover and sheet and the native share sheet. `rounded-4xl` belongs
              to detached dialog surfaces; on the sheet it read like a clipped
              dialog, and on the card it would make this the twin of the pickers
              it opens.

              Widths: the sheet caps at `max-w-xl` and centres, which binds only
              between `sm` and the docking width (an iPad in Slide Over or a
              narrow Split View, a phone on its side); `sm:border-x` gives its
              detached sides the edge the top already has, and so does any side
              inset. The card is `max-w-lg`, one step past the dialog kit's
              `max-w-md`, so a picker opened from it reads as a child over its
              parent rather than as a replacement for it. It gets
              DialogContent's border and shadow.

              `bg-popover`, not the page's `bg-background` it used to wear, and in
              dark that is the whole of what separates this panel from the screen it
              covers (docs/theme.md, _elevation_). The scrim cannot: `bg-black/50`
              takes a white page to mid-grey, but has nothing to subtract from a
              0.145 one — measured on the Pixel 8 AVD, the panel was grey 10 over a
              page at grey 5, APCA Lc 0.7 against light's 75. Nor can the `border-t`
              alone: it is `border-border`, the token the link rows behind are
              divided with, so over a list the panel's one edge read as one more row
              divider. The lifted fill makes it a region rather than a line — the
              corners show — and it is the fill every other floating surface here
              already has (ui/dialog.tsx, ui/dropdown-menu.tsx) and the one web
              quick-add wears in both its containers. Light is untouched: the two
              tokens are the same white there.

              The sheet's bottom padding is the share sheet's formula
              (share-kit.tsx, docs/share-sheet.md): the inset while the keyboard
              is down, and NOTHING while it is up. A keyboard's frame runs to the
              bottom of the screen — it contains the home indicator — and the
              avoider has already padded by its full height, so adding the inset
              on top of that is not clearance but ~34pt of empty background
              between Save and the keys, at the moment the panel has the least
              room to spend. Nothing catches it; it reads as a gap, not as a bug.
              The card pays the same number outside itself (the gutter box).

              It is a PRESSABLE, and not for the press: a plain View is not a touch
              target, so a tap on the panel's own chrome — the header's empty middle,
              a `gap-4` seam — would fall through to the backdrop behind it and
              discard the draft. Claiming those taps is the job; `Keyboard.dismiss`
              is what to do with them, and it is share-kit.tsx's layer arriving by a
              different route (the scroller already covers the body, so this only
              ever sees the chrome). */}
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
            {/* A sheet header rather than an app bar: the top padding aligns the
              title with the 36pt close control (`top-3.5` puts both centres at
              32pt), and `pb-6` is the complete title-to-form gap. The scroller
              therefore has no top padding. The divider went with the app-bar
              geometry; this compact task is one continuous surface — the same
              answer ui/dialog.tsx and the share sheet give, against the bordered
              bars the two system-modal editors wear (link-edit-screen.tsx,
              search-bar.tsx). If a scrolled form ever needs its clip edge
              marked, the line to add is one that appears on `scrollOffset > 0`,
              not a static one: a static divider would pull this panel into the
              app-bar tier it deliberately left. */}
            <View className="relative shrink-0 pt-5 pr-14 pb-6 pl-4">
              {/* The title's width must be DEFINITE. Sized to its own content,
                Android/Fabric can retain a stale paint clip when the avoider's
                keyboard padding relays out this transformed panel: the
                native/a11y bounds stay correct, but the paint came up short
                after the keyboard closed and on the next mount. A column child
                is stretched to the header's width (the close button is
                absolute, so there is no row to share), which is what makes it
                definite here — NOT `flex-1`, which in a column acts on height.
                Put the title back in a row and it needs `flex-1` again. */}
              <Text className="text-base font-medium">Add link</Text>
              {/* The floating-surface close, spelled like ui/dialog.tsx's and like
                the web twin this panel ports — web-ui `sheet.tsx`'s
                SheetCloseButton is `variant="ghost" size="icon-sm"` with a
                `size-4` glyph, pinned to the surface's own top-right corner. The
                box is the kit's 36 against web's 32, which is the one touch step
                the whole size scale runs on (docs/theme.md, _the two kits_), and
                that 2pt is the entire reason this says `top-3.5` where web says
                `top-3`: 14 + 18 puts the ✕'s centre on the title's, at 32.

                No colour class on the glyph — TextClassContext hands down the
                ghost variant's `text-foreground`, which is what web's inherits
                too. The `size-5` it used to wear is the BAR tier's glyph rung
                (features/links/topbar.tsx: 20 for nav chrome, 16 everywhere
                else) and did not belong on a sheet header whose title is
                `text-base`.

                52x52 effective. Nothing pressable is near it — the title is a
                Text and the header reserves `pr-14` — and 8 of slop still lands
                inside the header's own box. */}
              <Button
                variant="ghost"
                size="icon-sm"
                onPress={close}
                aria-label="Close add link"
                hitSlop={8}
                className="absolute top-3.5 right-3"
              >
                <Icon as={X} className="size-4" />
              </Button>
            </View>
            {/* `shrink` is what lets the cap above reach this scroller instead of
            pushing the header off the top (bulk-tags-dialog.tsx says the same).
            `handled` preserves taps on controls while panel chrome still drops
            the keyboard. This scroller deliberately uses `interactive`, not the
            app's usual `on-drag`: the expanded form can put Note below the fold,
            so an upward drag must scroll it clear without dismissing the keyboard
            and expanding the panel again (docs/soft-keyboard.md). */}
            <StyledAnimatedScrollView
              ref={scrollRef}
              className="shrink"
              // No end padding while the form shows: the space above Save is the
              // footer's `pt-4`, which has to stay visible when the fields are
              // clipped. The quota banner has no footer, so it keeps its own.
              contentContainerClassName={cn('gap-4 px-4', atLimit && max !== null && 'pb-4')}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
              {atLimit && max !== null ? (
                <LinkQuotaBanner
                  count={count}
                  max={max}
                  action={
                    <Button
                      size="sm"
                      className="self-end"
                      onPress={() => {
                        // Close BEFORE routing — the Subscription screen must not be
                        // pushed under an open panel (the LockedBanner precedent; as a
                        // route this said `router.back()`, and it means the same thing
                        // now that closing is a state flip rather than a pop).
                        close();
                        router.push('/settings/subscription');
                      }}
                    >
                      <Text>Upgrade to {PLAN_LABELS.plus}</Text>
                    </Button>
                  }
                />
              ) : (
                <>
                  <LabeledField label="URL">
                    <Input
                      testID="add-link-url"
                      value={url}
                      onChangeText={(v) => {
                        setUrl(v);
                        // Editing re-opens the question: clear the error and disarm the
                        // warning so the button reverts to Save and re-validates.
                        setUrlError(null);
                        setUrlWarning(null);
                        setTrashedMatch(null);
                      }}
                      onSubmitEditing={() => void onSubmit()}
                      placeholder="https://example.com"
                      aria-label="URL"
                      aria-invalid={urlError !== null}
                      autoFocus
                      inputMode="url"
                    />
                    {urlError !== null ? (
                      <ErrorText className="text-xs">{urlError}</ErrorText>
                    ) : urlWarning !== null ? (
                      <ErrorText tone="warning" className="text-xs">
                        {urlWarning === 'malformed'
                          ? 'This doesn’t look like a valid URL. Tap Confirm to save it anyway.'
                          : urlWarning === 'trashed'
                            ? 'This link is in your Trash. Restore it, or tap Confirm to save a new copy.'
                            : 'You’ve already saved this link. Tap Confirm to save it again.'}
                      </ErrorText>
                    ) : null}
                  </LabeledField>

                  {/* Web's disclosure, ported (link-add-surface.tsx carries the full
                reasoning): quiet by WEIGHT rather than size or colour, so the
                label drops to normal weight at full contrast; the chevron sits
                WITH the label rather than pinned to the far edge of a mostly empty
                row; and `self-start` keeps the pressed background on the control
                instead of painting a bar the width of the form.

                A `Button variant="ghost" size="sm"` rather than the hand-rolled
                Pressable this used to be, so the numbers come from the same RULE
                as web's rather than being matched by hand: `px-3` (hence the same
                `-ml-3` to put the label on the LabeledField labels' text edge),
                the trailing-icon padding trim derived from the children, and the
                icon colour inherited through TextClassContext the way web's
                inherits from the button. `h-9` — the size variant is already the
                touch step above web's `h-8`, which is exactly the h-9-vs-web's-h-8
                this hand-rolled one was reproducing. The
                press background is unchanged: ghost uses `accent`, and this theme
                defines `--color-accent` and `--color-muted` to the same value.

                `font-normal` on the label because buttonTextVariants' base is
                `text-sm font-medium` — the native analogue of overriding the web
                Button's own `font-medium`. `text-foreground/80` is web's colour
                step (its comment carries the reasoning: between the Input's
                foreground and the LabeledField labels' `text-muted-foreground`,
                which the control must not wear). It is spelled TWICE, on the Text
                and on the Icon, because there is no currentColor here: the chevron
                takes its colour from TextClassContext, which the Button fixes at
                `text-foreground`, and a class on the Pressable cannot cascade into
                either child. Web sets it once on the button and both follow. Web additionally cancels both halves
                of its ghost variant's `aria-expanded:` lift (the fill AND the text
                jumping to full contrast); nothing to do here, since `active:` is
                press-only and RN has no attribute-driven styling, so the reduced
                colour above is simply what this button wears open or shut. The
                `aria-expanded` prop stays either way — it announces the state.

                The DOT is web's too, same `size-1.5 bg-foreground/70`, same place
                (after the chevron) and same job: a collapsed section that holds
                something still gets saved, so something on screen has to say so.
                `bg-foreground/70` rather than the advanced-search trigger's
                `bg-primary` because this one sits beside a label — web's comment
                carries that reasoning, and the token is what lets the two clients
                spell the dot identically. `aria-label` is how it reaches a screen
                reader — a NAME carrying the visible text first, never a live
                region, since it re-words as the note is typed
                (docs/accessibility.md).

                The label is web's too, and is NAMED FOR ITS CONTENTS rather than
                "Advanced": nothing behind it is advanced, and "More options" is
                already the links screen's overflow button. Web's header carries
                that reasoning; docs/brand-assets.md is the record for user-facing
                wording. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    testID="add-link-optional"
                    onPress={() => setOpenOptional((v) => !v)}
                    aria-expanded={openOptional}
                    aria-label={
                      !openOptional && optionalDirty
                        ? `List, tags & note, ${optionalSet.join(', ')} set`
                        : 'List, tags & note'
                    }
                    className="-ml-3 self-start"
                  >
                    <Text className="font-normal text-foreground/80">List, tags & note</Text>
                    <Icon
                      as={openOptional ? ChevronUp : ChevronDown}
                      className="size-4 text-foreground/80"
                    />
                    {!openOptional && optionalDirty && (
                      <View aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
                    )}
                  </Button>

                  {openOptional && (
                    <View
                      className="gap-4"
                      // Note is the last child, so this bottom is Note's (revealNote).
                      onLayout={(e) => {
                        const { y, height } = e.nativeEvent.layout;
                        noteBottom.set(y + height);
                      }}
                    >
                      {/* No Trash target: it's the deletion staging area, never a place
                    to add new links (same rule as the default-list fallback).
                    Locked/hidden lists stay pickable — hiding only declutters the
                    drawer, it never blocks filing into a list you know exists. */}
                      {/* The three field ids exist because each control's
                        accessible name is also its LabeledField label's text
                        (docs/e2e.md, _the testID contract_). */}
                      <LabeledField label="List">
                        <ListSelect
                          testID="add-link-list"
                          value={listId}
                          onValueChange={setListId}
                          excludeIds={[TRASH_ID]}
                          allowCreate
                        />
                      </LabeledField>

                      <LabeledField label="Tags">
                        <TagsField testID="add-link-tags" value={tagIds} onChange={setTagIds} />
                      </LabeledField>

                      <LabeledField label="Note">
                        <Textarea
                          testID="add-link-note"
                          value={note}
                          onChangeText={setNote}
                          onFocus={(e) => {
                            noteTag.set(e.nativeEvent.target);
                            noteFocused.set(true);
                          }}
                          onBlur={() => {
                            noteFocused.set(false);
                          }}
                          maxLength={LINK_NOTE_MAX}
                          placeholder="Optional note"
                          aria-label="Note"
                        />
                      </LabeledField>
                    </View>
                  )}
                </>
              )}
            </StyledAnimatedScrollView>
            {/* The footer is PINNED below the scroller rather than being its last
              child — web quick-add's footer is the same. With the optional
              section open and the keyboard up the form outgrows the panel, and
              Note's reveal (above) scrolls Note into view, which put Save
              beneath the fold at the one moment the draft is complete. Out here
              `shrink` squeezes only the fields, so Save stays on the keyboard's
              edge whatever the form's height.

              `pt-4` is the gap above the buttons, and it lives HERE rather than
              as the scroller's `pb-4` (which is where it started) because end
              padding is the last thing in the scroll: while the fields overflow,
              it is scrolled out of view and the clipped fields run straight into
              the buttons. On the footer it shows at every scroll position — web
              quick-add gets the same from its form's `gap-4` outside the scroll
              box. When the form fits, it draws exactly as before. Not a
              KeyboardStickyView like the full-screen editors'
              (components/sticky-footer.tsx): the whole panel already rides the
              keyboard. Gone with the quota banner, which replaces the form. */}
            {!(atLimit && max !== null) && (
              <View className="flex-row justify-end gap-2 px-4 pt-4 pb-4">
                <Button variant="ghost" size="sm" testID="add-link-cancel" onPress={close}>
                  <Text>Cancel</Text>
                </Button>
                {/* Only on the trashed ground — the one already-saved case where the
                  match is unreachable, so a second door is worth the width. */}
                {urlWarning === 'trashed' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onPress={() => void onRestore()}
                  >
                    <Text>Restore</Text>
                  </Button>
                )}
                {/* `add-link-save` rides the button, not its label: the label flips
                  Save → Confirm on a warning, so it is the one control on this
                  screen a Maestro flow could not have bound to by text even if
                  the rule allowed it (docs/e2e.md, _the testID contract_). */}
                <Button
                  testID="add-link-save"
                  size="sm"
                  disabled={saving}
                  onPress={() => void onSubmit()}
                >
                  <Text>{urlWarning !== null ? 'Confirm' : 'Save'}</Text>
                </Button>
              </View>
            )}
          </StyledAnimatedView>
        </StyledAnimatedView>
      </StyledKeyboardAvoidingView>
    </View>
  );
}
