# The soft keyboard (bracemark-expo)

On web the keyboard is a viewport concern: `visualViewport` shrinks under it and
the layout follows. That half lives in [safe-area.md](./safe-area.md) and is not
repeated here.

On native it is a different problem in both directions. The keyboard **overlays**
the window on both platforms — with edge-to-edge (enforced on Android 15+)
`adjustResize` no longer resizes, so Android behaves like iOS — which means
content must move itself to stay visible (**avoidance**), and the user must be
given a way to put the keyboard away again (**dismissal**). They are separate
mechanisms with separate defaults, they are decided by different things, and
almost every rule below is one whose violation is silent.

Read the avoidance half before adding a surface that takes text; read the
dismissal half before adding a text field to one. Neighbours:
[safe-area.md](./safe-area.md) (insets, the web viewport, popup positioning),
[accessibility.md](./accessibility.md) (an error that mounts must announce),
[share-sheet.md](./share-sheet.md) (the iOS extension process),
[e2e.md](./e2e.md) (what the flows do and do not cover).

## avoidance — which container lifts

Two mechanisms exist, and **the presentation container decides which, not the
feature**:

| surface                                                       | mechanism                                                               | examples                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| regular expo-router screen                                    | keyboard-controller `KeyboardAwareScrollView` in the screen wrapper     | `auth-screen.tsx`, `settings/[section].tsx` |
| portaled overlay content (`Dialog`)                           | keyboard-controller `KeyboardAvoidingView` in the CONTAINER             | `ui/dialog.tsx`'s `DialogOverlay`           |
| RN `Modal`                                                    | keyboard-controller `KeyboardAvoidingView` — the lib handles the window | AdvancedSearch (`links/search-bar.tsx`)     |
| share sheet (iOS extension process / Android `ShareActivity`) | plain `KeyboardAvoidingView` — keyboard-controller cannot work here     | `share/share-screen.tsx` `Sheet`            |

- **The default is react-native-keyboard-controller.** Its `KeyboardProvider`
  mounts once at the root (`src/app/_layout.tsx`) and feeds
  WindowInsetsAnimation-synced keyboard values; screens consume them via
  `KeyboardAwareScrollView` (wrapped with `withUniwind` for `className`).
- **The unit of handling is the screen/scroll container, not the leaf.**
  Components rendered inside an already-keyboard-aware screen — the settings
  sections (`lists-section.tsx`, `tags-section.tsx`), future
  `ListSelect`/`TagsField` cousins — declare nothing themselves. Don't nest a
  second avoider; two stacked avoiders double the offset.
- **Why RN `Modal` does NOT opt out — it used to, and that reasoning is dead.**
  The old rule here was that a `Modal` is its own native window, so the
  provider's `KeyboardControllerView` can't drive content inside it. That is no
  longer true of the pinned version. On **Android** the lib handles the modal's
  window explicitly: `ModalAttachedWatcher` listens for the Modal's `topShow`
  event, resolves the `ReactModalHostView`, attaches a
  `WindowInsetsAnimationCallback` to the dialog's own `decorView`, puts that
  window in `SOFT_INPUT_ADJUST_NOTHING` ("imitating edge-to-edge mode
  behavior"), and propagates the values back through the root provider — wired
  up whenever the provider is active. On **iOS** nothing special is needed:
  keyboard notifications are app-wide, and the lib's `KeyboardAvoidingView` is
  Reanimated over context values, owning no native view that would have to wrap
  the window (the same property that lets it work through the dialog's portal).
  Driven on both: inside the sheet the lib reports the keyboard's height (335 on
  an iPhone 17 Pro) and the `ScrollView` shrinks by the lift.
  **This was not a bug fix.** Unlike the portal case below, RN's own
  `KeyboardAvoidingView` avoids correctly in this Modal on _both_ platforms —
  a modal window carries its own `softInputMode`, so the resize RN's metrics
  want still happens. What the swap buys is one keyboard library across the app
  tree and a lift synced to the keyboard's own animation. **Pin the version when
  you re-check this**: the Android half is a library behaviour, not a platform
  one, so a downgrade silently takes it away.
- **The pageSheet under-lift, and the `keyboardVerticalOffset` that pays for
  it.** With `presentationStyle="pageSheet"` on iOS, a `KeyboardAvoidingView`'s
  `onLayout` frame is measured relative to the SHEET while the `screenHeight` it
  subtracts from is the whole screen — `max(frame.y + frame.height -
(screenHeight - keyboardHeight - keyboardVerticalOffset), 0)`, which is the
  formula RN's KAV and keyboard-controller's share, verbatim. So with the offset
  at its default 0 the lift falls short by the sheet's top offset (~60pt on an
  iPhone 17 Pro) and AdvancedSearch's Clear/Search row stays behind the keyboard
  once its body is tall enough to scroll. Measured, not inferred: the
  `ScrollView` goes 722 → 483 against a 335pt keyboard. Android's modal is
  full-screen, offset 0, and clears the row unaided.
  AdvancedSearch now passes `keyboardVerticalOffset = screenHeight −
sheetHeight`, the one place the formula lets us re-register the two rulers:
  an `onLayout` on the Modal's `SafeAreaView` root supplies `sheetHeight`, and
  `screenHeight` must come from **keyboard-controller's own**
  `useWindowDimensions` (`UIScreen.main.bounds`, re-emitted on rotation), not
  react-native's same-named window hook — the terms only cancel if both are read
  off the same ruler. Two guards: the offset is 0 until the first layout, so the
  failure mode is the old under-lift for one frame and never an over-lift; and
  it is applied on iOS only, since Android's screen height counts system bars
  whose relation to the modal decorView is an edge-to-edge detail not worth
  betting a working surface on. A `Modal` that is NOT a page sheet (Android's,
  or an iOS `fullScreen`) needs none of this.
- **Why a portaled dialog is NOT the `Modal` case, and still needs its own
  avoider.** `Dialog` content portals to the root `PortalHost`, which is mounted
  _inside_ `KeyboardProvider` (`src/app/_layout.tsx`), so keyboard-controller's
  values do reach it — on Android the same window, on iOS a `FullWindowOverlay`
  that still observes the app's keyboard. What it inherits nothing from is the
  screen's `KeyboardAwareScrollView`: without an avoider the dialog stays centred
  in the WHOLE window while the keyboard covers its lower third — for the lock
  dialogs, the Cancel/submit row. Hence one `KeyboardAvoidingView
behavior="padding"` around the centring box in `DialogOverlay` — the container,
  never a caller — and it must be **react-native-keyboard-controller's, not
  react-native's**. Both were driven on the emulator against a deliberately tall
  dialog: RN's does not move the subtree at all under Android's edge-to-edge (its
  metrics come from a window resize that no longer happens) and leaves a phantom
  inset once the keyboard closes; keyboard-controller's is Reanimated over the
  provider's context values — no native view of its own that would have to wrap
  the portal — and lands the dialog centred in the space above the keyboard. Not
  solved by the lift alone: a dialog taller than that space would overflow off
  the TOP and lose its title. The second half is `max-h-full` on
  `DialogContent` — the percentage resolves against the avoider, whose height is
  definite, so it reads "the window, minus the keyboard, minus the gutter"
  without measuring anything — plus `shrink` on the one scroller each growable
  body owns (`list-command.tsx`, `bulk-tags-dialog.tsx`, and now
  `link-destroy-confirm.tsx` under the alert dialog's copy of the cap), since RN
  children do not shrink by default and the cap alone would keep pushing the
  title off. The
  margin was thinner than it looked: an iPhone 17 Pro leaves ~566pt above the
  keyboard and bulk "Edit tags" wants ~520. Both halves were driven on a
  simulator and an emulator against a deliberately oversized body. Related: this finding put the two plain-KAV
  surfaces in question on Android. AdvancedSearch has since been driven on both
  platforms and swapped to keyboard-controller (bullet above) — RN's KAV turned
  out to work there, so the swap is for consistency, not repair. The share sheet
  still has no swap available (next bullet) and has not been re-driven.
- **Why the share sheet can't use it at all** (the stronger constraint):
  keyboard-controller's iOS layer is built on `UIApplication.shared`, which
  doesn't exist in an app-extension process — expo-share-extension's
  `APPLICATION_EXTENSION_API_ONLY=No` only makes such pods compile, not work.
  Even nesting a fresh `KeyboardProvider` wouldn't help. Android's
  `ShareActivity` could technically differ, but one plain KAV keeps the two
  hosts rendering the same tree (docs/share-sheet.md).
- **…and the plain KAV needs a `keyboardVerticalOffset` on iOS, for a reason
  that is invisible in the tree.** The extension's RN surface is not the window:
  `ShareExtensionViewController` pins the root view at
  `y = UIScreen.main.bounds.height - ShareExtensionHeight`, a 520pt band at the
  bottom of the screen. RN's KAV lifts by
  `frame.y + frame.height - keyboardFrame.screenY`, and inside that band the two
  terms are in different coordinate spaces — `frame` is the view's own
  `onLayout` (y = 0, height = 520), `screenY` is the keyboard's origin on the
  SCREEN (~516 on an 852pt phone). It therefore lifted ~4pt: the panel sat
  _under_ the keyboard and appeared to rise later only because it was tracking
  changes to the keyboard's own frame (the accessory bar arriving, a picker
  swapping fields), never actually avoiding it. `keyboardVerticalOffset` is the
  documented knob — "distance between the top of the user screen and the React
  Native view" — so the value is the band's screen origin, measured in
  `share-kit.tsx`'s `useShareKeyboardOffset` as
  `Dimensions.get('screen').height` minus the height the view reports (measured,
  not typed as 520, because that number is `app.config.ts`'s). Android's
  activity is genuinely full-screen, so 0 is right there and the offset is wired
  to the iOS branch only. Nothing catches this: the tree, the types and the
  Maestro flows are identical either way, and over the iOS extension the panel
  leaves the accessibility tree the moment the keyboard is up (bullet below), so
  the flows cannot even see the panel to measure it.
- **For a new surface, decide the presentation first; the keyboard answer
  follows.** A future link-add/link-edit built as a router screen inherits the
  keyboard-controller path for free; built as a page-sheet `Modal` (like
  AdvancedSearch), it carries its own keyboard-controller `KeyboardAvoidingView`
  — and must copy the `keyboardVerticalOffset` measurement above with it, or
  inherit the under-lift (invisible until its body is tall enough to scroll).

## dismissal — how the user gets it back off

Avoidance above is only half the contract. Getting the keyboard **out of the
way** is a separate mechanism with separate defaults, and RN's defaults are
wrong for us in both directions — one leaves a field with no exit, the other
silently eats taps. **Every text field must have at least one dismissal path
that does not also submit or navigate**, and the three below are what provide
it. Nothing lints this; the symptom is only visible with a keyboard actually up.

**1. Return/Done — free, but not universal.** RN resolves `submitBehavior` per
field (`TextInput.js`): a single-line input defaults to `'blurAndSubmit'`, so
return dismisses whether or not `onSubmitEditing` is set. A **`multiline`** one
defaults to `'newline'` and never blurs — correct, but it means the note fields
in `link-add-screen.tsx` / `link-edit-screen.tsx` depend entirely on 2 and 3.
So does any field that sets **`submitBehavior="submit"`** on purpose to keep the
keyboard for the next entry: `components/links/tags-field.tsx`,
`share/share-list-picker.tsx`, `share/share-tags-picker.tsx`. Those three are
the ones to check first when this regresses.

**2. Tap outside — `keyboardShouldPersistTaps="handled"`, and it is not
optional.** Put it on **every** scroller that can be on screen under a
keyboard, including ones whose input sits outside them. The default is
`'never'`, which does dismiss the keyboard but **withholds the tap from the
child** — so "filter the tree, tap the row you filtered for" does nothing on
the first press and works on the second. That is the primary flow of the links
drawer (`links/sidebar.tsx`), AdvancedSearch's tri-state checklists
(`links/search-bar.tsx`), and the links `FlashList` (`links/main.tsx`, whose
search box is `autoFocus`); all three shipped with the default and all three
had the double-tap. `'handled'` fixes both halves at once: a tap on a control
reaches it, a tap on padding or a `gap-*` seam still drops the keyboard.

A surface with **no scroller** has no tap target at all — it needs one added.
The share sheet is the case that proves it: its panel is a plain `SafeAreaView`,
its inputs are `submitBehavior="submit"`, and on iOS the host owns the space
around it, so before `ShareSheet`'s dismiss layer (`share/share-kit.tsx`) there
was **no gesture in the process that closed the keyboard**. Note Android's
`share-backdrop` is not that gesture — it closes the whole sheet. Spell the
layer as an absolute `Pressable` **behind** the panel's children rather than a
wrapper around them: a wrapper becomes a new parent for the `max-h-[85%]`
percentage (the `ui/dialog.tsx` trap) and an ancestor of the picker's scroller.

**3. Scroll — `keyboardDismissMode="on-drag"`.** Carry it alongside
`keyboardShouldPersistTaps` on the same scrollers. `'on-drag'` rather than
iOS's nicer `'interactive'`, because RN maps `'interactive'` to `'none'` on
Android and the two hosts should render one tree. Programmatic scrolls don't
trigger it, so it does not fight `KeyboardAwareScrollView`'s own scroll-to-focus
or the settings drag-sort (which additionally calls `Keyboard.dismiss()` on
drag start — `settings/drag-sort.tsx`).

## the traps

Each of these cost a real debugging session. None of them has a lint rule, a
type error or a failing test.

- **An `absolute` layer inside a `SafeAreaView` does not cover the box you see.**
  The first attempt at the share sheet's tap-to-dismiss target was a
  `Pressable` with `absolute top-0 right-0 bottom-0 left-0`, as a sibling behind
  the panel's children — the reasoning being that RN hit-tests topmost-first, so
  children keep their own taps and only the padding and `gap-*` seams reach the
  layer. The reasoning is fine; the premise is not. `SafeAreaView` (from
  react-native-safe-area-context) is a **native** view that applies its insets
  outside Yoga, so the absolutely-positioned child resolves against a different
  box: driven on the simulator with a debug tint it rendered as a thin
  full-width band **above** the panel, touching none of it. Nothing about that
  is visible from the code, from a type, or from a test — only from tinting it
  and looking. Spell such a layer as a **wrapper** around the children (an
  ordinary flex column, carrying whatever `gap-*` the parent used to own) and
  the problem disappears. Note the wrapper then owns the gaps, and needs
  `shrink min-h-0` so any `max-h-*` below it still absorbs the squeeze.
- **A debug tint via `style` may not paint at all.** When checking the above,
  `style={{ backgroundColor: ... }}` alongside a Uniwind `className` painted
  nothing on the wrapper version — className and `style` do not merge the way
  you would assume on every component. If a tint doesn't show, that is not
  evidence the element is missing; put the colour in the `className` instead
  before drawing any conclusion.
- **`keyboardShouldPersistTaps` is the tap-eating default, not just a dismissal
  knob.** Covered above, repeated here because it is the one that ships: the
  default `'never'` withholds the tap from the child. The bug reads as "the
  first press does nothing", which looks like a hit-target or a state problem
  and is neither.

## verifying any of this

**The tests do not cover it.** The Maestro flows use `hideKeyboard`
(`e2e/mobile/flows/add-link.yaml`), a native command that bypasses the app's own
affordances entirely — so a surface can lose all three mechanisms with every e2e
run still green. Same for jest: none of this renders. A device or simulator is
the only instrument.

**And the instrument has holes.** Driving the keyboard with Maestro on iOS ran
into four separate blind spots, each of which reads exactly like a failing fix:

- **Over the iOS share extension, the panel leaves the accessibility tree the
  moment the keyboard is presented.** `maestro hierarchy` returns only the
  keyboard's own keys and the status bar; a `testID` that resolved a step
  earlier (`share-back`) goes not-found. Coordinate taps have nothing to confirm
  against, so a tap that does nothing and a tap that was never delivered are
  indistinguishable. **The share sheet's dismissal path is therefore unverified**
  — the code is right on reasoning and says so in its own comment. If you are
  ever in that sheet by hand, try it and record the answer here.
- **Portaled content is not in the tree either** — the links topbar's dropdown
  (`more-options-menu.tsx`) never appears, so "open the menu, tap Settings"
  cannot be driven that way. Reach settings through the drawer instead.
- **The keyboard's autocorrect bubble intercepts taps and matches text.** A
  `tapOn: "Longreads"` resolved to the suggestion strip floating over the row.
  Prefer a filter term the keyboard won't offer a correction for, or tap the row
  by coordinate below the bubble.
- **`appId` decides what Maestro can see.** Driving the share extension works
  under the **host's** id (`com.apple.mobilesafari`); switching to
  `com.bracemark.app.ShareExtension` mid-flow loses the panel entirely.

**What a green run does prove.** The tap-swallowing half is cheap and reliable to
check on the main app: filter or search so the keyboard is up, tap a result
**once**, and assert the thing it should have opened. That is how the
`FlashList` and drawer fixes were confirmed — one tap on a search result opened
its URL, which the pre-fix default would have eaten.
