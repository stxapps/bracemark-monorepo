# The soft keyboard (bracemark-expo)

On web the keyboard is a viewport concern: `visualViewport` shrinks under it and
the layout follows. That half lives in [safe-area.md](./safe-area.md) and is not
repeated here.

On native it is a different problem in both directions. The keyboard **overlays**
the window on both platforms — with edge-to-edge (enforced on Android 15+)
`adjustResize` no longer resizes, so Android behaves like iOS — which means
content must move itself to stay visible (**avoidance**), and the user must be
given a way to put the keyboard away again (**dismissal**) — with a third
question ahead of both, whether the keyboard should be up at all when a screen
arrives (**arrival**). They are separate mechanisms with separate defaults, they
are decided by different things, and almost every rule below is one whose
violation is silent.

Read the avoidance half before adding a surface that takes text; read the
dismissal half before adding a text field to one; read the arrival half before
writing `autoFocus`. Neighbours:
[safe-area.md](./safe-area.md) (insets, the web viewport, popup positioning),
[accessibility.md](./accessibility.md) (an error that mounts must announce),
[share-sheet.md](./share-sheet.md) (the iOS extension process),
[e2e.md](./e2e.md) (what the flows do and do not cover).

## avoidance — which container lifts

Two mechanisms exist, and **the presentation container decides which, not the
feature**:

| surface                                                       | mechanism                                                                      | examples                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| regular expo-router screen                                    | keyboard-controller `KeyboardAwareScrollView` in the screen wrapper            | `auth-screen.tsx`, `settings/[section].tsx` |
| portaled overlay content (`Dialog`)                           | keyboard-controller `KeyboardAvoidingView` in the CONTAINER                    | `ui/dialog.tsx`'s `DialogOverlay`           |
| RN `Modal`                                                    | keyboard-controller `KeyboardAvoidingView` — the lib handles the window        | AdvancedSearch (`links/search-bar.tsx`)     |
| share sheet (iOS extension process / Android `ShareActivity`) | plain `KeyboardAvoidingView` — keyboard-controller cannot work here            | `share/share-screen.tsx` `Sheet`            |
| an in-tree overlay panel                                      | keyboard-controller `KeyboardAvoidingView` in the PANEL, which owns the window | the add panel (`links/link-add-panel.tsx`)  |

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
  simulator and an emulator against a deliberately oversized body. A third,
  cosmetic, half: the avoider pads only its OVERLAP with the keyboard, and the
  keyboard's frame already covers the overlay's `insets.bottom + 8` gutter, so a
  capped dialog sat flush on the keys while its other three edges kept 8.
  `keyboardVerticalOffset={8}` on the avoider puts the gutter back (padding
  becomes `keyboardHeight − insets.bottom`); the lift is scaled by the keyboard's
  progress, so it is inert with the keyboard down. The add panel is flush on
  purpose — an edge-attached panel, not a floating card. Related: this finding put the two plain-KAV
  surfaces in question on Android. AdvancedSearch has since been driven on both
  platforms and swapped to keyboard-controller (bullet above) — RN's KAV turned
  out to work there, so the swap is for consistency, not repair. The share sheet
  still has no swap available (next bullet); its iOS half no longer uses a KAV
  at all, for a reason that turned out to be more fundamental than the lift
  arithmetic (bullet after next).
- **Why the share sheet can't use it at all** (the stronger constraint):
  keyboard-controller's iOS layer is built on `UIApplication.shared`, which
  doesn't exist in an app-extension process — expo-share-extension's
  `APPLICATION_EXTENSION_API_ONLY=No` only makes such pods compile, not work.
  Even nesting a fresh `KeyboardProvider` wouldn't help. Android's
  `ShareActivity` runs in the app's own process and could technically differ,
  but it keeps the plain KAV so the two hosts render one tree
  (docs/share-sheet.md).
- **…and on iOS no KAV can work there, because RN reports every keyboard frame
  as ZERO.** This bullet used to prescribe a `keyboardVerticalOffset` for a
  coordinate-space mismatch. That diagnosis was wrong, and the offset it
  prescribed made things worse. `RCTKeyboardObserver.mm` converts the
  notification's frame through `RCTKeyWindow()`, which returns nil in an app
  extension by contract, so every payload JS sees is `screenY: 0, height: 0`.
  KAV's lift is `frame.y + frame.height - (screenY - keyboardVerticalOffset)`;
  against `screenY: 0` that is the panel's whole height plus the offset, i.e.
  padding larger than the surface it pads — the content box collapses and
  `justify-end` parks the shrunken panel above the sheet. The repair is a native
  module of ours, `BracemarkShareKeyboard`
  (`modules/bracemark-share/ios/`), which reads
  `UIKeyboardFrameEndUserInfoKey` straight off the notification — UIKit posts it
  in screen coordinates, so no window is needed — and emits the keyboard's top
  edge plus the system's animation duration. `features/share/share-keyboard.ts`
  turns that into `useShareKeyboard().lift` and `share-kit.tsx` applies it as
  bottom padding on the iOS branch, leaving Android's KAV alone. (The hook's
  second number, `cover`, is read on **both** hosts and never padded by: it
  cancels the bottom safe-area inset while the keyboard is up, since a
  keyboard's frame already contains the home indicator —
  [safe-area.md](./safe-area.md).) The other half
  of the fix is not JS at all: the extension's `height` is now omitted from
  `app.config.ts` so the host view is full-screen, because a ~520pt container
  cannot hold a ~520pt picker above a ~340pt keyboard however correctly it
  lifts. Nothing catches any of this: the tree, the types and the Maestro flows
  are identical either way, and over the iOS extension the panel leaves the
  accessibility tree the moment the keyboard is up (bullet below), so the flows
  cannot even see the panel to measure it. Full derivation in
  [share-sheet.md](./share-sheet.md), _what an app-extension process breaks in
  React Native itself_.
- **For a new surface, decide the presentation first; the keyboard answer
  follows.** A router screen inherits the keyboard-controller path for free; a
  page-sheet `Modal` (like AdvancedSearch) carries its own keyboard-controller
  `KeyboardAvoidingView` — and must copy the `keyboardVerticalOffset`
  measurement above with it, or inherit the under-lift (invisible until its body
  is tall enough to scroll); a **form sheet sized to its contents** answers the
  keyboard by itself and forbids the scroller the first answer is built on, the
  next section.

### the add panel — and why it is not a sheet presentation

The add surface is a bottom panel the LINKS SCREEN draws over itself
(`links/link-add-panel.tsx`, rendered by `(app)/links/index.tsx` while its
`adding` state is true). It is not a route, and getting there cost three
measured findings — all in react-native-screens 4.16, all silent, and all worth
keeping because the presentation they rule out is the one the platform appears
to offer (the expo-animation skill's tool table still names `formSheet`, and for
a surface with no keyboard it would be right).

- **`sheetAllowedDetents: 'fitToContents'` has no Android half.** The sheet
  DISAPPEARS there the moment the keyboard is up — the dimmed list, the
  keyboard, and nothing between them — on both entry paths (the URL field's
  `autoFocus`, and a later tap into it). It is RNS's own code:
  `SheetDelegate.kt`'s `KeyboardVisible` branch never sizes a ONE-detent sheet,
  and its `KeyboardDidHide` branch re-derives the height as
  `detents.first() * containerHeight`, where `fitToContents` puts a sentinel
  rather than a fraction in `first()`. Both live in the count-of-1 path, so a
  two-detent sheet is the only shape with a keyboard story there.
- **A fitted sheet may hold no scroller.** RNS hunts for a descendant scroll
  view in a form sheet and forces its frame to the sheet's own (`RNSScreen.mm`
  — `correctScrollViewFrame:`, `coerceChildScrollViewComponentSizeToSize:`,
  which also warns that the content wrapper may hold at most a header and that
  scroller). Against a sheet sized FROM its content that is circular, and it was
  driven twice: the form painted CLIPPED at a stale frame — the accessibility
  tree had every field at its right bounds while the screen showed white below
  the third one, so the a11y tree is no help here — and the sheet INFLATED past
  its content whatever height the scroller was given, a hard `height: 300`
  included. No scroller means no `keyboardShouldPersistTaps` and no
  `keyboardDismissMode`: two of the three dismissal paths, gone.
- **A transparent modal ROUTE drops the accessibility tree on the second
  open.** This is the one that ended the route entirely. Present it, dismiss it,
  present it again, and `maestro hierarchy` returns the app root and the status
  bar — nothing else, not the panel and not the links screen behind it — and it
  stays that way. VoiceOver finds nothing; every flow that opens the surface
  twice fails against a screen that is plainly on display. Reproduced with
  `transparentModal`, `containedTransparentModal`, and `containedModal` +
  a transparent `contentStyle`, with `animation: 'none'` and with the entering
  animation removed; NOT reproduced with an opaque `modal` (including with a
  transparent `contentStyle`) or with the form sheet, three cycles each. The
  line the failures fall on is the presentations that keep the screen below
  ATTACHED — which is exactly the property that lets a dim show the live list.

So the panel lives in the screen's own tree, where there is no presentation to
measure the height, no sheet to seize the scroller, and no modal container to
lose. Its mechanisms are the ordinary ones, and they are `ui/dialog.tsx`'s three
(that file carries the canonical derivation):

- **Avoidance** — keyboard-controller's `KeyboardAvoidingView` spans the window
  and parks the panel on the keyboard's top edge (`justify-end`,
  `behavior="padding"`), so `max-h-full` on the panel resolves against "the
  window minus the keyboard" with nothing measured.
- **The squeeze** — that cap only reaches the body if the scroller carries
  `shrink`; RN children do not shrink by default, and without it the cap pushes
  the header off the top instead (`bulk-tags-dialog.tsx` says the same).
- **Dismissal** — the scroller's `keyboardShouldPersistTaps="handled"` and
  `keyboardDismissMode="interactive"`, both back now that a scroller is allowed.
  This panel is the exception to the app's usual `on-drag`: expanding the
  optional fields can put Note below the keyboard-sized fold, and `on-drag`
  dismisses the keyboard at the start of the upward scroll needed to reach it.
  Interactive mode lets that upward drag scroll while keeping the keyboard;
  Android maps it to `none`, which preserves the same essential ability there.
  Tapping panel chrome still dismisses on both platforms.
- **Focus visibility** — the plain scroller has no automatic focused-input
  tracking. If Note summons the keyboard from closed, the avoider shrinks the
  viewport but preserves the scroller's old offset, leaving Note below the new
  fold. The panel scrolls it back on keyboard-controller's `useKeyboardHandler`
  `onMove` — the per-frame event on both platforms — measuring the scroller's
  viewport height and scrolling, unanimated, to the absolute offset that puts
  Note's bottom (its content position, from the optional section's `onLayout`)
  16pt above the viewport's; `onEnd` re-checks one frame later, and a reaction
  covers what the keyboard never announces (focus under an already-open
  keyboard, the multiline field growing). Three traps sit under that, and all
  fail silently — no error, just motion that is wrong:
  - **`useReanimatedKeyboardAnimation().height` is not per-frame on iOS.** The
    provider writes it once, in `onKeyboardMoveStart`, already holding the
    final height (`animated.tsx`), so a reaction on it runs a single time,
    before the avoider has moved, finds no overlap, and never runs again. The
    first rewrite off `keyboardDidShow` did exactly that.
  - **A measured `pageY` inside a scroller lags a `scrollTo`.** `measure`
    reads the shadow tree, whose copy of the content offset native updates
    asynchronously (`_updateStateWithContentOffset`), so a per-frame "scroll
    by the overlap" re-adds an overlap it has already scrolled away. Scroll to
    an absolute target computed from offset-independent numbers instead.
  - **Gate the keyboard events on their `target`, not on a JS focus flag.**
    Moving focus from Note to URL resizes the keyboard (Note shows the
    suggestion bar, URL does not), so the move fires `onMove` frames — and
    `onBlur` reaches the UI thread several frames after them. Gated on a flag
    set from `onBlur`, those frames still saw Note focused and yanked the form
    back down to it, away from the field just tapped. The event's `target` is
    the input focused at that moment; Note's tag comes from its `onFocus`
    event (`nativeEvent.target`, the same tag).

  `measure` sees the layout committed last frame, so the scroll trails the
  avoider by one frame; the 16pt gap absorbs it. This is deliberately not a JS
  `keyboardDidShow` listener (it lands after the keyboard, then animates a
  second time — the visible lag this replaced), RN ScrollView's
  `automaticallyAdjustKeyboardInsets` (iOS only), or a nested
  `KeyboardAwareScrollView`: in the pinned version the latter adds a full
  keyboard-height spacer while the outer avoider has already removed that
  height, double-compensating this panel.

Three details are load-bearing and none of them is visible from the code:

- **The backdrop must be a sibling of the avoider, not a child.** `absolute
inset-0` resolves against the parent's PADDING box (_the traps_ below), and
  the avoider is padded by `insets.top + 8` to keep a maxed-out panel out of the
  notch — so inside it the backdrop stops below that strip, and a tap up there
  falls through to the links screen instead of closing. Driven on the emulator:
  the tap did nothing at all, which is indistinguishable from a swallowed one.
- **The avoider needs `pointerEvents="box-none"`**, or it is the touch target
  for the empty space above the panel and the backdrop never sees those taps.
- **The panel itself is a `Pressable`.** A plain View is not a touch target, so
  a tap on the panel's own chrome — the header's empty middle, a `gap-4` seam —
  would fall through to the backdrop behind it and discard the draft. Claiming
  those taps is the job; `Keyboard.dismiss` is what to do with them.
- **The header title owns the row's remaining width.** Left intrinsically sized,
  Android/Fabric retains a stale paint clip when the keyboard avoider's padding
  relays out the transformed panel: the first keyboard-up frame paints "Add a
  link", dismissing the keyboard cuts it to "Add a", and the clipped paint
  survives the panel's next mount. `uiautomator` still reports the full string
  and its full 210px text bounds, so neither the string nor the Yoga width is
  truncated — only the paint is. `flex: 1` makes the title's allocation definite
  across the relayout and prevents the stale clip.

The bottom padding is the share sheet's formula (`share-kit.tsx`,
[share-sheet.md](./share-sheet.md)): the safe-area inset while the keyboard is
down, and NOTHING while it is up. A keyboard's frame contains the home indicator
and the avoider has already padded by its full height, so adding the inset on
top of that is ~34pt of empty background between Save and the keys — it reads as
a gap, not as a bug. The cancellation reads
`useReanimatedKeyboardAnimation().height` in the panel's animated style, on the
same UI-runtime clock as the avoider. `useKeyboardState` is not equivalent here:
it updates React state on `keyboardDidShow`/`keyboardDidHide`, leaving the inset
in place until the keyboard has finished moving and then visibly contracting the
panel.

**The editor stayed a route**, and should. `/edit-link` is a full-height form
(title, list, tags, note, image) with no dead space to reclaim, it is opaque so
none of the three findings above touch it, and a presented route is what gives
it swipe-down, the back gesture and `usePreventRemove` for free. Driven on the
emulator with the keyboard up: the ordinary screen answer
(`KeyboardAwareScrollView`) is doing its job there.

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
in `link-add-panel.tsx` / `link-edit-screen.tsx` depend entirely on 2 and 3.
So does any field that sets **`submitBehavior="submit"`** on purpose to keep the
keyboard for the next entry: `components/links/tags-command.tsx`,
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
The share sheet is the case that proves it: its panel is a plain `View`, its
inputs are `submitBehavior="submit"`, and on iOS the host owns the space around
it, so before `ShareSheet`'s dismiss layer (`share/share-kit.tsx`) there was
**no gesture in the process that closed the keyboard**. Note Android's
`share-backdrop` is not that gesture — it closes the whole sheet.

**A `Dialog`'s chrome is that tap target, once, in the container.** The native
`@rn-primitives/dialog` Content claims every touch its children don't
(`onStartShouldSetResponder` → `true`) and does nothing with it, so a tap on a
dialog's header or padding neither closed it nor dropped the keyboard — dead
space right above the input. `ui/dialog.tsx`'s `DialogContent` hangs
`Keyboard.dismiss` on that claimed touch (`onResponderRelease`); children keep
their own taps.

**Both dialog kinds also drop the keyboard on OPEN, in the container.** The field
focused before the opening press survives it — every scroller here persists taps
(`"handled"`), and the links search box survives a row press — so it stays
focused BEHIND the dialog and takes the next keystroke unseen; under an
`AlertDialog`, which has no avoider, the keyboard also covers the footer. This
used to be per trigger (`ListSelect`/`TagsField`'s `openPicker`), which left
every other host without it. `DialogContent` does it in a **layout** effect on
`open`, and the choice of effect is load-bearing: `@rn-primitives/portal`
registers the content from a passive effect and the `PortalHost` renders it in a
later commit, so the dismiss runs before any field inside the dialog exists and
cannot blur one that autofocuses (`lock-password-dialog.tsx`). Moved into a
passive effect, or into the portaled content itself, that ordering is gone and
the password field's autofocus becomes a race — no error, just a dialog that
sometimes opens without its keyboard. `AlertDialogContent` has no field to race,
so a passive effect does there.

**The add panel adds a FOURTH vector, and it is the one that needs guarding.**
Its backdrop closes on a tap — web's outside-click, and swallowed by the same
rule while the optional section holds work (`link-add-panel.tsx`). Everything
that reaches the panel's own chrome instead is claimed by the panel and drops
the keyboard, so 2 and 3 keep working inside it. Note what this does to a
driver: Maestro's `hideKeyboard` puts the keyboard away on iOS by tapping a
blank area, and on this surface the blank area is that backdrop — the flows that
used it mid-form now close the panel instead, which is why `flows/add-link.yaml`
and `contract/add-link.yaml` no longer carry the step.

**3. Scroll — normally `keyboardDismissMode="on-drag"`.** Carry it alongside
`keyboardShouldPersistTaps` on scrollers where scrolling is itself a dismissal
gesture. Programmatic scrolls don't trigger it, so it does not fight
`KeyboardAwareScrollView`'s own scroll-to-focus or the settings drag-sort (which
additionally calls `Keyboard.dismiss()` on drag start —
`settings/drag-sort.tsx`).

The add panel is the deliberate exception. Its plain scroller does not
auto-scroll a focused input, and expanding its optional fields can put Note
below the keyboard-sized fold. With `on-drag`, the upward gesture needed to
bring Note into view dismisses the keyboard first, expands the panel again and
removes the stable viewport the user was trying to scroll within. It uses
`interactive`: upward drags cancel dismissal and scroll on iOS; Android maps the
value to `none`, so it also keeps the keyboard while scrolling. The two hosts
still share the important behavior, and both retain tap-to-dismiss through
`keyboardShouldPersistTaps="handled"` and the panel's pressable chrome.

**Choosing between the two: does the scroller move when the keyboard leaves?**
On a screen-shaped surface — top-anchored, the keyboard only covering its foot —
dropping the keyboard just lengthens the viewport, nothing moves under the
finger, and `on-drag` is the right exit. On a surface the avoider **lifts** — a
centred dialog, a bottom-parked panel — dropping it re-lays out the very scroller
being dragged: a dialog re-centres and its list regrows from squeezed to its cap,
so the rows jump under the finger. There, `interactive`, provided the surface
has a tap-to-dismiss (above) so `interactive` is not the only way out — on
Android it maps to `none`. The current map:

| scroller                                                               | mode          | why                                                                                                                      |
| ---------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| links `FlashList` (`main.tsx`), links drawer (`sidebar.tsx`)           | `on-drag`     | full-height, top-anchored; scrolling results is the dismissal already in hand                                            |
| `auth-screen`, `lock-pane`, `link-edit-screen`, settings `scroll-host` | `on-drag`     | `KeyboardAwareScrollView` screens — it tracks the focused field, so no field is out of reach                             |
| AdvancedSearch body + its checklists (`search-bar.tsx`)                | `on-drag`     | page sheet, top-anchored; the lift only pads its foot                                                                    |
| `ListCommand`, `TagsCommand` (every host a `Dialog`)                   | `interactive` | the dialog re-centres; filtering is type-scan-type; chrome tap + `"handled"` are the tap exits                           |
| add panel (`link-add-panel.tsx`)                                       | `interactive` | above                                                                                                                    |
| share pickers (`share-list-picker.tsx`, `share-tags-picker.tsx`)       | `on-drag`     | lifted, so the jump applies — but the iOS tap layer is unverified (_verifying_), and `on-drag` is its only verified exit |
| `link-destroy-confirm`, settings drawer, `contract-vectors`            | none          | no keyboard can be up: an alert drops it on open, the other two hold no field                                            |

`"handled"` sits on every row above that carries a mode — the rule in 2 has no
exception.

## arrival — what may take focus on mount

`autoFocus` on native is not web's `autoFocus`. Focusing a `TextInput` **summons
the keyboard**, so on a pushed screen it runs the keyboard's slide-up against the
navigator's slide-in, and then has the screen's `KeyboardAwareScrollView` scroll
the field clear — all before the screen has finished arriving. This is the same
divergence [editors.md](./editors.md) records for `/edit-link`'s `focus` param,
where native scrolls the field into view instead of focusing it.

The rule is **not** "never on a pushed screen". It is what sits above the field,
and whether the user arrived already committed to typing:

- **Focus on mount** when the screen exists to receive the typing and carries
  nothing to read first: the add panel's URL field (`links/link-add-panel.tsx`),
  the links search box (`links/search-bar.tsx`), `lock-pane.tsx`'s password when
  there is no biometric to offer instead.
- **Don't** when the screen opens with something the user has to read. `/sign-in`
  and `/create-account` are pushed from the landing CTAs (`components/landing.tsx`)
  and open with the lockup, the heading, and — on create-account — the step
  description that says there is no email address and no password reset. That
  sentence is the screen's disclosure ([account.md](./account.md)), and a keyboard
  on mount scrolls it away at the moment it is meant to land. The cost of dropping
  it is one tap on a field the user was going to type into anyway.
- A field that swaps in **within** an already-visible screen keeps its focus: the
  create-account confirm step, the sign-in recovery-code toggle. No transition to
  fight, and the press that got there was the intent to type.
- The **web twins keep their `autoFocus`** (`packages/web-ui/src/components/auth/`)
  and should. A focus in a browser tab summons no keyboard on a desktop, and there
  is no push animation for it to collide with.

Deferring the focus instead (`InteractionManager` / a `transitionEnd` listener)
fixes only the collision, not the reason: the keyboard still lands over copy the
screen was pushed to show.

Nothing lints any of this, and the Maestro flows cannot see it either way — every
auth flow taps the field by `testID` before typing
(`e2e/mobile/flows/subflows/sign-in.yaml`, `flows/recovery-sign-in.yaml`), so they
pass with or without the focus.

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
- **`hideKeyboard` is a TAP on iOS.** It puts the keyboard away by pressing a
  blank area, so on any surface with a tap-to-close backdrop it closes the
  surface — the add flows lost their Save button to it mid-run, reported as a
  missing element rather than as a dismissal.
- **A stale accessibility tree survives a Fast Refresh.** Editing a file while a
  modal or an overlay panel is on screen can leave `maestro hierarchy` returning
  the app root and nothing else, on a screen that renders fine. Relaunch the app
  before reading anything into an empty tree — and note this is also what a real
  bug looks like (_the add panel_ above), so tell them apart by relaunching
  first.
- **`appId` decides what Maestro can see.** Driving the share extension works
  under the **host's** id (`com.apple.mobilesafari`); switching to
  `com.bracemark.app.ShareExtension` mid-flow loses the panel entirely.

**What a green run does prove.** The tap-swallowing half is cheap and reliable to
check on the main app: filter or search so the keyboard is up, tap a result
**once**, and assert the thing it should have opened. That is how the
`FlashList` and drawer fixes were confirmed — one tap on a search result opened
its URL, which the pre-fix default would have eaten.
