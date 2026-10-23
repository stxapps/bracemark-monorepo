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

| surface                                                       | mechanism                                                                       | examples                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| regular expo-router screen                                    | keyboard-controller `KeyboardAwareScrollView` in the screen wrapper             | `auth-screen.tsx`, `settings/[section].tsx`           |
| portaled overlay content (`Dialog`)                           | keyboard-controller `KeyboardAvoidingView` in the CONTAINER                     | `ui/dialog.tsx`'s `DialogOverlay`                     |
| the in-app sheet (`Sheet`)                                    | keyboard-controller `KeyboardAvoidingView` in the SHEET, which owns the window  | add link, edit link, Advanced Search (`ui/sheet.tsx`) |
| share sheet (iOS extension process / Android `ShareActivity`) | its own bottom padding (`useShareKeyboard`) — neither library's avoider works   | `share/share-kit.tsx` `ShareSheet`                    |
| RN `Modal`                                                    | none in the app — lint fences it ([locks.md](./locks.md)); the history is below | —                                                     |

- **The default is react-native-keyboard-controller.** Its `KeyboardProvider`
  mounts once at the root (`src/app/_layout.tsx`) and feeds
  WindowInsetsAnimation-synced keyboard values; screens consume them via
  `KeyboardAwareScrollView` (wrapped with `withUniwind` for `className`).
- **The unit of handling is the screen/scroll container, not the leaf.**
  Components rendered inside an already-keyboard-aware screen — the settings
  sections (`lists-section.tsx`, `tags-section.tsx`), future
  `ListSelect`/`TagsField` cousins — declare nothing themselves. Don't nest a
  second avoider; two stacked avoiders double the offset.
- **Why RN `Modal` did NOT opt out — kept as history: the app no longer has
  one** (AdvancedSearch was the last, and is an in-app sheet now — _the in-app
  sheet_, below). The finding still holds for any `Modal` that comes back.
  The old rule here was that a `Modal` is its own native window, so the
  provider's `KeyboardControllerView` can't drive content inside it. That is no
  longer true of the pinned version. On **Android** the lib handles the modal's
  window explicitly: `ModalAttachedWatcher` listens for the Modal's `topShow`
  event, resolves the `ReactModalHostView`, attaches a
  `WindowInsetsAnimationCallback` to the dialog's own `decorView`, puts that
  window in `SOFT_INPUT_ADJUST_NOTHING` ("imitating edge-to-edge mode
  behavior"), and propagates the values back through the root provider — wired
  up whenever the provider is active. On **iOS** nothing special is needed:
  keyboard notifications are app-wide, and the lib's own components are
  Reanimated over context values, owning no native view that would have to wrap
  the window (the same property that lets them work through the dialog's
  portal). Driven on both: inside the sheet the lib reports the keyboard's
  height (335 on an iPhone 17 Pro) and moves the content by it.
  **This was not a bug fix.** Unlike the portal case below, RN's own
  `KeyboardAvoidingView` avoids correctly in this Modal on _both_ platforms —
  a modal window carries its own `softInputMode`, so the resize RN's metrics
  want still happens. What the swap buys is one keyboard library across the app
  tree, motion synced to the keyboard's own animation, and — once the surface
  became a `KeyboardAwareScrollView`, two bullets down — a focused-field gutter
  no avoider of either library can give it. **Pin the version when
  you re-check this**: the Android half is a library behaviour, not a platform
  one, so a downgrade silently takes it away.
- **The page sheet used to carry a `keyboardVerticalOffset` correction —
  history now, but the arithmetic behind it is still true of every avoider in
  the tree.** Both KAV implementations lift by `max(frame.y + frame.height −
(screenHeight − keyboardHeight − keyboardVerticalOffset), 0)`, verbatim, and
  under `presentationStyle="pageSheet"` on iOS the `onLayout` frame is measured
  relative to the SHEET while `screenHeight` spans the whole screen. So at the
  default offset the lift fell short by the sheet's top offset (~60pt on an
  iPhone 17 Pro) and AdvancedSearch's Clear/Search row stayed behind the keyboard
  once its body was tall enough to scroll. Measured, not inferred: the
  `ScrollView` went 722 → 483 against a 335pt keyboard. The repair was
  `keyboardVerticalOffset = screenHeight − sheetHeight`, an `onLayout` on the
  Modal's `SafeAreaView` root supplying `sheetHeight` and `screenHeight` coming
  from **keyboard-controller's own** `useWindowDimensions`
  (`UIScreen.main.bounds`, re-emitted on rotation) rather than react-native's
  same-named window hook — the terms only cancel if both are read off the same
  ruler. **Put an avoider in a page sheet and you owe it that measurement
  again** — and on an iPad you cannot pay it at all (_the in-app sheet_). A `Modal`
  that is NOT a page sheet (Android's, or an iOS `fullScreen`) never did.
- **⚠ An avoider cannot give a focused field AIR above the keyboard — only the
  thing that scrolls can.** This is what ended the avoider on AdvancedSearch, and
  it generalises: a KAV pads the container by its overlap with the keyboard and
  stops there. The scroll that brings a newly focused field into view is then the
  PLATFORM's, and on iOS that scroll is measured against the keyboard rather than
  against the container the KAV has just shrunk — so the field comes to rest
  flush on the keys. The specimen is AdvancedSearch's tri-state filter box
  (`TriCheckList` past `FILTER_THRESHOLD`, which the Tags tree is first to
  cross), whose bottom border sat on the keyboard. **Paying the avoider a 16pt
  `keyboardVerticalOffset` to buy that air does not work**, and the failure is
  recorded here because it reads like a near-miss rather than a wrong mechanism:
  on a real iPhone the field stayed exactly where it was on the keys while the
  container's bottom edge rose 16pt OVER its bottom border — the gap appeared,
  but it belonged to the keyboard and it ate the field's own edge. The number has
  to reach the code that computes the scroll: on a screen, keyboard-controller's
  `KeyboardAwareScrollView bottomOffset` ("the distance between the keyboard and
  the focused `TextInput`"); inside an avoider, which an aware scroller cannot
  nest in, `useFocusedFieldReveal` (_the in-app sheet_). **16 is this app's number
  for that gap** — every `KeyboardAwareScrollView` here passes it
  (`auth-screen.tsx`, `settings/scroll-host.tsx`, `lock-pane.tsx`), and a form
  sheet gets it from its footer's `pt-4`; `ui/dialog.tsx`'s 8 is a different
  measurement, a floating card's corner off the keys rather than a field. And
  **never nest an aware scroller inside an avoider**: it pads its own content
  by the keyboard's full height, which the avoider has already removed from the
  container.
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
  `link-destroy-confirm.tsx` and `table-kit.tsx` under the alert dialog's copy of
  the cap), since RN children do not shrink by default and the cap alone would
  keep pushing the title off. Where that scroller is a `ScrollView`, `shrink` is
  half the pair — see _the traps_ for the `grow-0` that goes with it. The
  margin was thinner than it looked: an iPhone 17 Pro leaves ~566pt above the
  keyboard and bulk "Edit tags" wants ~520. Both halves were driven on a
  simulator and an emulator against a deliberately oversized body. A third,
  cosmetic, half: the avoider pads only its OVERLAP with the keyboard, and the
  keyboard's frame already covers the overlay's `insets.bottom + 8` gutter, so a
  capped dialog sat flush on the keys while its other three edges kept 8.
  `keyboardVerticalOffset={8}` on the avoider puts the gutter back (padding
  becomes `keyboardHeight − insets.bottom`); the lift is scaled by the keyboard's
  progress, so it is inert with the keyboard down. The add panel is flush on
  purpose — an edge-attached panel, not a floating card. The share sheet has
  no keyboard-controller swap available (next bullet); its iOS half no longer
  uses a KAV at all, for a reason that turned out to be more fundamental than
  the lift arithmetic (bullet after next).
- **Why the share sheet can't use it at all** (the stronger constraint):
  keyboard-controller's iOS layer is built on `UIApplication.shared`, which
  doesn't exist in an app-extension process — expo-share-extension's
  `APPLICATION_EXTENSION_API_ONLY=No` only makes such pods compile, not work.
  Even nesting a fresh `KeyboardProvider` wouldn't help. Android's
  `ShareActivity` runs in the app's own process and could technically differ,
  but the two hosts render one tree (docs/share-sheet.md) — and RN's plain KAV,
  which that branch used to be, is the phantom-inset bug from the dialog bullet
  above: `keyboardDidHide`'s `screenY` leaves out the system bars, so the sheet
  stayed 74dp above the bottom of the screen after the keyboard closed. It pads
  itself from `useShareKeyboard()` now, as iOS does (next bullet).
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
  (`modules/bracemark-share/ios/`), a native VIEW that reads
  `UIKeyboardFrameEndUserInfoKey` straight off the notification — UIKit posts it
  in screen coordinates, so no key window is needed — and reports how much of
  ITSELF the keyboard covers, plus the system's animation duration. It is a view
  because on an iPad the sheet is a form sheet that the host moves for the
  keyboard itself, and only a view inside it sees where it went
  ([share-sheet.md](./share-sheet.md), _on an iPad the sheet floats_).
  `features/share/share-keyboard.ts` turns that into `useShareKeyboard()` and
  `share-kit.tsx` applies it as
  bottom padding on the frame — on both hosts, Android's number coming from
  RN's own `keyboardDidShow` height plus the bottom inset. (The same number
  also cancels the bottom safe-area inset while the keyboard is up, since a
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
  follows.** A router screen inherits the keyboard-controller path for free. A
  form over the screen is a `Sheet` (`ui/sheet.tsx`, _the in-app sheet_), which
  brings its own avoider, cap, squeeze and focused-field reveal. Not a page-sheet
  `Modal` or a modal route: both float on an iPad where nothing in JS can
  measure them. And not a react-native-screens **form sheet sized to its
  contents**, which answers the keyboard by itself and forbids the scroller every
  other answer is built on (_the add panel_, below).

### the in-app sheet

⚠ **Every form drawn over the links section is ONE component: `Sheet`
(`components/ui/sheet.tsx`) — a bottom sheet below the docking width (768,
`lib/window-class.ts`) and a centred card at and above it, in the app's own
window.** Add link (`links/link-add-panel.tsx`), edit link
(`links/link-edit-panel.tsx`) and Advanced Search (`links/search-bar.tsx`) are
bodies in it. Don't give a fourth form a presentation of its own; the history
below is why.

The name is overloaded, so: in these docs "form sheet" and "page sheet" mean the
NATIVE presentations (UIKit's, react-native-screens'), which this replaced;
web-ui's `Sheet` is edge-anchored at every width, so this is web's whole
quick-add SURFACE rather than its twin; and the share sheet
([share-sheet.md](./share-sheet.md)) wears the same two shapes from another
process, where none of this component's machinery runs.

The three used to be three presentations — the add panel in the tree, the editor
an expo-router modal route, Advanced Search an RN `Modal` page sheet — and the
two presented ones each grew a SECOND shell from 768, a kit `Dialog`, because of
one finding:

**On an iPad a presented sheet floats, and nothing in JS can learn where.** Both
presented forms pinned their Cancel/Save row below the scroller and lifted it by
`keyboardHeight − insets.bottom`, which is right only while the bar rests on the
screen's bottom edge. An iPad page sheet held on its side floats above that edge,
and the bar stopped visibly short of the keys (iPad (A16) simulator, iOS 26.5).
Correcting it needs the bar's position in the WINDOW, and nothing inside the
presentation reports one:

- Fabric's `measureInWindow` returns the sheet's coordinates (a form sheet's
  bar "rested" at 650 in both orientations, its height, not its position);
- keyboard-controller's focused-input `absoluteY` is converted natively but taken
  before UIKit raises a form sheet for the keyboard (the first field read 355,
  where it sits in the centred sheet, after the sheet had risen);
- react-native-safe-area-context's provider frame converts to its parent view
  controller's view, the sheet again;
- `TextInput.State.currentlyFocusedInput()` returned a stale field.

A `formSheet` fixes the width (580pt both ways, against the page sheet's 820 and 936) and UIKit then raises the sheet for the keyboard itself, which makes the
lift both unnecessary held upright and unknowable on its side. (The share sheet
meets the same wall from inside another process, and gets past it with a native
view — [share-sheet.md](./share-sheet.md), _on an iPad the sheet floats_. Inside
the app there is no need: leave the presentation instead.)

So the fix is the add panel's model for all three: drawn in the app's own window,
where every number is the window's on both platforms, the same tree at every
width, and so the same code on a phone, an iPad, an Android tablet, a foldable
and a Split View drag across 768. What the presentations cost besides, all gone
with them:

- **The `Modal` was an Android window of its own.** The paywall (a kit `Dialog`
  on the root `PortalHost`) drew BEHIND it, so Advanced Search closed itself
  around the paywall and reopened on "Not now"; and a relock could not hide it,
  so it gated `visible` on `useAppCovered()` ([locks.md](./locks.md)). In the
  tree the paywall stacks above the sheet, as web's does above its popover, and
  the lock's `display: none` reaches it.
- **The bar needed its own keyboard tracking.** keyboard-controller's
  `KeyboardStickyView` moves itself through react-native's `Animated`, and on
  iOS an update did not reach the bar while its `Modal` was presenting: open
  Advanced Search with the basic search box focused, iOS hides the keyboard
  ~150ms into the slide, the library reports it, and the bar stayed a
  keyboard's height up an empty screen until the next re-render (iPhone 17 Pro,
  iOS 26.5). Inside a sheet the whole panel rides the avoider, so the footer is
  simply the row below the `shrink` scroller — on the keys on a phone, 8pt
  above them as a card — and needs nothing of its own.
- **The page sheet's arc forked the header** (the app's only `ios:` variants).

**How it is built** — the add panel's three mechanisms, now the shell's
(`ui/sheet.tsx` carries each in full):

- **Avoidance** — keyboard-controller's `KeyboardAvoidingView` spans the window
  and parks the sheet on the keyboard's top edge (`justify-end`) or centres the
  card in what the keyboard leaves (`justify-center`), so `max-h-full` on the
  panel resolves against "the window minus the keyboard" with nothing measured.
- **The squeeze** — the body's ONE scroller carries `shrink grow-0`, so the cap
  squeezes the fields and never the header or the footer (_the traps_).
- **Focus visibility** — no aware scroller can nest in the avoider, so
  `lib/use-focused-field-reveal.ts` keeps the focused field above the fold: the
  add panel's Note reveal (_the add panel_, below, has its three traps),
  generalised to every field, with the field's blur and its growth (a
  multiline note typed past a line) tracked. It scrolls the field's bottom ON
  the viewport's edge; the 16 between it and the buttons is the footer's
  `pt-4`, which — pinned below the scroller — shows at every scroll position.

**Drawn in the tree, inside `SheetHost`**, which `(app)/links/_layout.tsx`
wraps around the links Drawer: each opener's host (add, edit, Advanced Search)
sits between it and the Drawer and renders its sheet as a sibling after the
covered Drawer (`SheetCovered`). That decides the sheet's REACH (the whole links
section, the docked rail included — drawn in the screen, the add panel's dim
stopped at the rail's edge), its CONTEXT (the links layout's providers), and its
LOCK behaviour (inside AppLockGate: hidden on a relock, back with the draft on
unlock). It replaced `APP_PORTAL_HOST`, which existed for the wide editor's
Dialog alone.

⚠ **Never portal a form whose inputs are controlled from outside the portal —
Android eats keystrokes.** The sheet WAS portaled for a while, to a host in the
same place. `@rn-primitives/portal` passes its children to the host through a
store set from an effect, so the host renders them a commit after the caller
did, and a controlled `TextInput` in there can re-render with a value one
keystroke old after the native field has moved on. React Native writes that
stale value back, and the next character lands on it: on the Pixel 8 AVD a
Maestro `inputText` of `https://…` arrived as `htps://…` — over and over, in
the add panel and in the search flows' setup — the second `t` typed onto a
field just reset to `ht`. No error, no warning; on a phone it reads as a
fumbled keystroke. The kit's Dialogs keep their portal because their inputs
keep their own state inside the portaled content. A sheet body's draft is its
opener's, so the sheet renders in the opener's tree.

**Closing is split in two props**, as the route split it between
`usePreventRemove` and its own buttons: `onClose` is the deliberate ✕ (a body's
Cancel calls the same), `onDismiss` the accidental vectors — the backdrop,
Android's back, and on the narrow shape a downward drag on the header — which a
dirty editor swallows by not closing ([editors.md](./editors.md), invariant 3).

⚠ **Android's back is registered ONCE, at the sheet's mount, and gated inside
the handler — never by re-registering.** `BackHandler` runs listeners
newest-first and is app-global, and both halves of that bit the first version,
whose effect depended on `onDismiss`. The bodies pass a fresh `onDismiss` every
render, so the handler re-registered on every render and climbed back above the
picker opened from the body (ListSelect, TagsField — kit Dialogs, which close
themselves on back): toggle a tag in the open Tags picker, press back, and the
sheet answered instead — dead on a dirty draft, closing the form under the
picker on a clean one. And it was ungated, while the sheet stays mounted under a
pushed route (the paywall's Upgrade opens Subscription over an open Advanced
Search) and under a relock, so it took the press meant for that screen —
`topbar.tsx`'s SEARCH-002 trap again. Now the handler reads `onDismiss` through a
ref and returns `false` (falls through) unless the links route is focused and
the app is not covered. Unregistering on those gates instead would re-register on
the way back, on top of a picker still open. `sheet.spec.tsx` holds both; nothing
on a device has re-driven them yet.

Registering once holds the order only if nothing the sheet COVERS re-registers
while it is up, and `topbar.tsx`'s search handler does: it is gated on its own
`useIsFocused()`, so coming back from Subscription with Advanced Search still
open re-registered it above the sheet's, and the first back press closed the
search row under the sheet. So the covered content's back handlers also stand
down while a sheet is open — `useSheetOpen()` from `ui/sheet.tsx`, read in the
handler's gate — rather than racing the sheet for the top. The bulk-edit bar's
handler needs no such gate only because no sheet opens in bulk-edit mode (the
FAB and the search row are both hidden); a new back handler under SheetHost
takes the gate.

⚠ **The header drag is not decoration: on a phone it is the only accidental
door.** A tall form (the editor, Advanced Search) fills the window to the top
gutter, `insets.top + 8`, and the strip above it is the status bar, whose
touches iOS keeps — measured on the iPhone 17 Pro, a tap at 6% of the height
never reached the backdrop. The route had swipe-down for free; the sheet
restores it on the header only (the body's own downward drag scrolls it), and a
guarded draft springs back home. The card has no drag: anchored to no edge,
there is nowhere for "down" to take it.

**Driven** on the Pixel 8 AVD through the e2e cases (NATIVE-LINK-001,
LINK-EDITOR-002, LINK-CLOSE-001, SEARCH-001, SEARCH-002, VIEWPORT-KEYBOARD-001,
all passing), and on the tablet AVD (1280×800dp) through the ones that do not
assume a phone: NATIVE-LINK-001, LINK-CLOSE-001 and SEARCH-001 pass; the editor
and Advanced Search cases navigate through the narrow window's drawer button and
`keyboard-add-note` taps a Note that the landscape card has scrolled below its
fold, so those flows still need a wide-window pass. By hand, on the iPad (A16)
simulator both ways round (the editor with Note focused, its dirty backdrop
swallowed and Cancel closing it; Advanced Search's Note field revealed above
Clear/Search in landscape) and on the iPhone 17 Pro (the editor full-height,
Note revealed on the keys; swipe-down closing a clean editor and springing back
on a dirty one; Advanced Search on the keys) — **but those iOS checks ran
against the portaled version**, before the portal finding above; the in-tree
sheet has not been re-driven on iOS, nor through the iOS e2e cases.

### the add panel — and why it is not a sheet presentation

The add surface was the first form drawn in the app's own window, and the one
`Sheet` (_the in-app sheet_, above) was later extracted from: a bottom sheet on a
narrow window and a centred card on a wide one (_the two shapes_, below). The
mechanisms below are the shell's now (`components/ui/sheet.tsx`,
`lib/use-focused-field-reveal.ts`), but the findings were made here and are
recorded here. It is not a route, and getting there cost three
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

So the panel lives in the app's own tree, where there is no presentation to
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
  on the viewport's bottom edge. That is the scroller's own end: the 16pt above
  Save is the footer's `pt-4`, not scroll padding, so the gap stays visible
  while the fields are clipped. `onEnd` re-checks one frame later, and a reaction
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
  avoider by one frame. Note's bottom edge can dip under the clip for that
  frame, into the footer's blank `pt-4` band rather than behind Save, and
  `onEnd` puts it back. This is deliberately not a JS
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
- **The header title's width is definite.** Left intrinsically sized,
  Android/Fabric retains a stale paint clip when the keyboard avoider's padding
  relays out the transformed panel: the first keyboard-up frame paints the whole
  title (then "Add a link"), dismissing the keyboard cuts it to "Add a", and the
  clipped paint survives the panel's next mount. `uiautomator` still reports the
  full string and its full 210px text bounds, so neither the string nor the Yoga
  width is truncated — only the paint is. The cure is a width the layout
  _assigns_ rather than one the text measures. Found when the header was a
  `flex-row`, where that took `flex: 1` (the title owning the row's remaining
  width); the header is now a column with the close button `absolute`, and the
  default `align-items: stretch` assigns it instead. `flex: 1` in a column acts
  on height, not width — it is not the fix there, and not a class to add to
  every Text.

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

**The editor used to stay a route below 768**, on the argument that a
full-height opaque form has no dead space to reclaim and the route gave it
swipe-down, the back gesture and `usePreventRemove` for free. The sheet now
gives it all three (_the in-app sheet_), and one shell at every width outweighed
the rest.

### the add panel's two shapes — what an iPad keyboard does to a bottom sheet

**Below the docking width (768, `lib/window-class.ts`) the panel is a bottom
sheet; at and above it, a centred card.** It used to be a bottom sheet at every
width, on the reasoning that its keyboard arithmetic is all about the bottom
edge and none of it cares how wide the panel is. The iPad (A16) simulator, iOS
26.5, showed both halves of that reasoning wrong.

- **⚠ The panel's layer must wrap the Drawer, not sit in the screen.** It is
  `absolute inset-0`, so it reaches exactly as far as its parent's box. While the
  links screen drew it, that box was the Drawer's SCREEN, and on a wide window
  the docked rail sits beside the screen, not under it. So the dim stopped at
  the rail's edge, the rail stayed live and tappable beside an open form, and
  the sheet centred over the list instead of the window. Nothing flags it: on a
  phone the rail is an overlay drawer, so the screen IS the window and every
  flow passes. `link-add-host.tsx` now owns `adding` and renders the panel as a
  sibling AFTER the Drawer, inside `LinksPageProvider` (the panel reads the
  viewing list) and inside `LiveReadPause`. The FAB reaches it through
  `useLinkAdd()`. The accessibility hide wraps the Drawer, so on iOS
  `accessibilityViewIsModal` hides the rail along with the list. Because the
  Drawer's pan gesture lives on the Drawer's own views, a narrow window's edge
  swipe over the panel's backdrop no longer reaches it.
- **⚠ keyboard-controller lifts by the keyboard frame's HEIGHT, wherever that
  frame is.** `KeyboardMovementObserver+Listeners.swift` sets
  `keyboardHeight = keyboardFrame.cgRectValue.size.height` from the
  notification's end frame and never reads the frame's origin. It also observes
  only `keyboardWill/DidShow` and `keyboardWill/DidHide`, never
  `keyboardWillChangeFrame` (pinned 1.18.5). On a phone a shown keyboard is
  docked at the bottom, so height and overlap are the same number. On an iPad
  they need not be: the keyboard can float, undock or split, and a hardware
  keyboard replaces it with the shortcuts bar. Any of these is lifted as if it
  were docked, by its whole height, and a mode switch that posts only frame
  changes leaves the last height in place. A bottom sheet promises contact with
  the keyboard's top edge, so every such error shows: the sheet hangs above an
  empty strip with no keyboard on screen, or its footer stops short of the keys.
  This is the "sometimes right, sometimes wrong" that Connect Hardware Keyboard
  produced, and turning that off made it go away. A centred card promises no
  contact. The same error moves its centre by half and leaves it whole, inside
  the room the avoider computed. **That is why the wide shape is a card**, and it
  is also the iPadOS idiom (a form sheet is a centred card) and what this app's
  dialogs already are.
- **The two shapes are one tree**, so a rotation, a Split View drag or an
  unfold across 768 re-shapes an open panel without losing the draft, the focus
  or the scroll. Two kinds of change are held by e2e: the Android resize across
  768 (`WINDOW-RESIZE-ANDROID-001`), and a rotation with the keyboard up on both
  tablets (`WINDOW-ROTATE-IOS-001`/`-ANDROID-001`, [e2e.md](./e2e.md), _narrow
  and wide_). They share the avoider, the `max-h-full` cap, the `shrink`
  scroller, the pinned footer and every dismissal path. The card's footer is
  still pinned below the scroller, because Save has to stay in view while the
  fields scroll, but it is no longer on the keyboard. The only boxes that
  differ:
  - **the bottom gutter.** The avoider cannot carry it, because under
    `behavior="padding"` it writes its own `paddingBottom` (the overlap, 0 while
    closed) over any the style sets. So a box between the avoider and the panel
    carries it. It is 0 for the sheet, which pays the home indicator inside its
    own fill. For the card it is `max(insets.bottom + keyboardHeight, 0) + 8`:
    `inset + 8` with the keyboard down, 8 with it up. It is padding, not the
    card's margin, because `max-h-full` resolves against the padded box: a
    margin would let a maxed-out card overflow by its own size, and centring
    would push half of that past the top gutter.
  - **the sides**, the bare insets for the edge-attached sheet and DialogOverlay's
    `inset + 8` for the detached card.
  - **the frame**: `rounded-t-2xl border-t` and a `max-w-xl` cap for the sheet;
    `rounded-2xl border shadow-lg` and `max-w-lg` for the card. That width is one
    step past the dialog kit's `max-w-md`, so a picker opened from the card reads
    as a child over it rather than as a replacement for it.
  - **the arrival**: the sheet slides up on the sheet curve, and the card fades
    on the dialog kit's `POPUP_FADE_MS`. The backdrop is `bg-black/50` in both,
    so crossing 768 changes the surface and not the room behind it.
- **Driven** on the iPad (A16) simulator with the software keyboard, in both
  orientations: collapsed and expanded, Note focused, the List picker opened
  from the card and its search focused. The dim covers the rail, and the card
  centres in what the keyboard leaves, maxing out at 8pt from the top and 8pt
  above the keys in landscape (an 820pt-tall window under a 422pt keyboard).
  The iPhone 17 Pro still gets the unchanged sheet. **Not driven**: a floating,
  split or hardware-keyboard-bar keyboard against the card. Simulator could not
  be put into those modes from a script (no assistive access for its menu, and a
  relaunch with Connect Hardware Keyboard on still showed the full keyboard), so
  the bullet above rests on keyboard-controller's source, not on a capture. A
  NARROW window on an iPad (Slide Over, a narrow Split View) still gets the
  sheet and so still inherits that error. Answering it there needs an overlap
  computed from the frame's origin, which keyboard-controller does not report.
- **Unexplained: a picker that vanished as its search field took focus.** It was
  seen by hand with Connect Hardware Keyboard on: open List or Tags from the
  panel, tap the picker's search, watch the keyboard start up and the picker
  disappear. It did NOT reproduce through Maestro with the software keyboard
  (portrait and landscape, keyboard up or down when the picker opened, List and
  Tags), nor with the device in hardware-keyboard mode. Probes on the pickers'
  `onOpenChange` never fired during those runs, and the panel never remounted
  under an open picker. The
  dialog closes only through its overlay press, its ✕/Done, a row select, or
  its owner unmounting; when it recurs, log those four first. One false lead
  is worth recording: in landscape with the keyboard up, the sheet left the Tags
  trigger scrolled under the pinned footer, so a tap at its coordinates landed
  on the panel's chrome, whose `Keyboard.dismiss` drops the keyboard and opens
  nothing. That looks like a dialog opening and closing, and it is not one.

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
in `link-add-panel.tsx` / `link-edit-panel.tsx` depend entirely on 2 and 3.
So does any field that sets **`submitBehavior="submit"`** on purpose to keep the
keyboard for the next entry: `components/links/tags-command.tsx`,
`share/share-list-picker.tsx`, `share/share-tags-picker.tsx`. Those three are
the ones to check first when this regresses. A fourth group gives up Return for
a different reason — to hand the focus to the NEXT field rather than to keep
typing in this one: the fields that spread `advanceTo(…)`
(`lib/input-keyboard.ts`), which are both sign-in usernames,
create-account's username and change-password's proof field. Their hosts are
`auth-screen.tsx` and settings' `scroll-host.tsx`, both aware scrollers carrying
2 and 3 ([editors.md](./editors.md), _typing assistance_).

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

**A scroller that is SWAPPED OUT takes its exits with it**, which is the same
hole arriving by a conditional. The links pane renders its `FlashList` only
while there are rows and an `EmptyState` otherwise (`links/main.tsx`), and the
search box above it has exactly one exit that neither submits nor leaves — the
pane's scroller: return commits the box, ✕ and the search toggle abandon the
search. The empty state was a plain `View`, so a search that matched nothing
left the keyboard up over a pane with no gesture that reached it. It is a
`ScrollView` now, carrying the list's pair (`links/shared.tsx`), and a tap or a
drag anywhere on it drops the keyboard on both platforms — **by different halves
of the pair, so neither is the spare.** On iOS a scroll view shorter than its
frame still bounces, the drag is a drag, and `on-drag` answers it. Android's
`ScrollView` never starts a drag it has no room to scroll, so `on-drag` cannot
fire; the gesture ends as a touch nothing claimed and `"handled"` drops the
keyboard on release, exactly as for a tap. Measured on the Pixel 8 AVD by
removing each in turn: without `on-drag` a drag still put the keyboard away,
and with `"always"` beside `on-drag` it did not. Any pane that trades its
scroller for a placeholder owes the placeholder the same two props;
`main.spec.tsx` pins them for this one, across every settled thing the pane
shows.

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

**A dropdown menu drops it too, but at the TRIGGER, and it waits.** Same
leftover, same container-not-caller rule — a settings row's ⋯ pressed from that
row's own rename field is the specimen — but the dialog's one-liner does not port,
because a dialog is centred and a menu is anchored. `@rn-primitives` measures the
trigger once, in the press, and never again while the menu is open; dropping the
keyboard then MOVES the trigger, since the settings `KeyboardAwareScrollView`
scrolls back to its pre-keyboard offset on hide, and a menu placed from the press
is left hanging up to a keyboard's height above its ⋯. So `ui/dropdown-menu.tsx`'s
`DropdownMenuTrigger` opens the menu but withholds its position while a keyboard
is up, awaits `KeyboardController.dismiss()` (it resolves on `keyboardDidHide`,
after the scroll-back, which is driven frame by frame with the keyboard), and
measures again. The withhold is flash-free only because Fabric's `measure` calls
back synchronously — the primitive's stale position is already stored when the
wrapper's `onPress` clears it, in the same batch; the note on the wrapper has the
detail, and `dropdown-menu.spec.tsx` pins the order. The cost is one keyboard
animation before the menu appears, and only when there was a keyboard to drop —
and a menu opened that way skips its fade, because the keyboard's slide already
answered the press and a fade stacked after it is what read as slow. The wait
itself is irreducible: keyboard-controller's `dismiss` has no `animated` option,
and the hide animation belongs to the OS on both platforms. Dropping it also ends the rename, and `RenameField` commits on `onEndEditing` —
the same save web makes when the click takes focus to the trigger.

**The links drawer drops it on every transition, in the drawer content.** The
same container-not-caller rule, and it is needed in BOTH directions. Closing: the
filter box is focused, and the rule in 2 is what strands the keyboard — `"handled"`
delivers the row tap instead of spending it on the keyboard, so the row selects,
the rail slides away, and the keyboard stays up over the links list, still fed by a
field that is now off screen. Opening: the links search box keeps its focus through
the menu press (`autoFocus`), so its keyboard covers the foot of the rail that press
just opened. A SWIPE close is the one path that was already covered — react-native-
drawer-layout dismisses at gesture start, its `keyboardDismissMode` defaulting to
`'on-drag'` — and it sees only the gesture, so a row press, a footer link and the
backdrop tap all close the drawer straight past it. `links/sidebar.tsx` hangs the
dismiss on `useDrawerStatus` instead, which catches all four. It skips the first run
deliberately: a Drawer mounts its content with the screen rather than on first open,
and `SearchBar` can mount autofocused in that same commit (a `?text=` query arriving
with the screen — _arrival_ below), so a dismiss on mount would race that focus.

That dismiss and an autofocus the row press leads to do NOT race, but only by
an ordering nothing here owns. Selecting a locked list closes the drawer and
mounts a lock pane whose password field autofocuses, and the keyboard stays up.
The row calls `setSimpleQuery` and then `closeDrawer`: the second dispatches to
the navigator at once, while the first is `router.push`, which expo-router only
QUEUES and dispatches from an effect a commit later (`routingQueue`,
`useImperativeApiEmitter`). So the status flips and the dismiss runs in one
commit, and the pane mounts and focuses in the next. Make the selection land
first — a synchronous params write in place of the push — and the dismiss would
arrive after the focus and take the keyboard back down, with nothing failing.

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

| scroller                                                         | mode          | why                                                                                                                     |
| ---------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| links `FlashList` (`main.tsx`), links drawer (`sidebar.tsx`)     | `on-drag`     | full-height, top-anchored; scrolling results is the dismissal already in hand                                           |
| links `EmptyState` (`shared.tsx`)                                | `on-drag`     | stands in for the list above when it has no rows, so it answers the same gestures; Android's drag is `"handled"`'s (2)  |
| `auth-screen`, `lock-pane`, settings `scroll-host`               | `on-drag`     | `KeyboardAwareScrollView` screens — it tracks the focused field, so no field is out of reach                            |
| AdvancedSearch's checklists (`search-bar.tsx`)                   | `on-drag`     | a nested `max-h-40` box; the sheet's own scroller is the one that keeps the keyboard                                    |
| `ListCommand`, `TagsCommand` (every host a `Dialog`)             | `interactive` | the dialog re-centres; filtering is type-scan-type; chrome tap + `"handled"` are the tap exits                          |
| every `Sheet` body (`ui/sheet.tsx`) — add, edit, AdvancedSearch  | `interactive` | above; the reveal scrolls a lower field clear, and the sheet's pressable chrome is the tap exit                         |
| share pickers (`share-list-picker.tsx`, `share-tags-picker.tsx`) | `interactive` | bottom-parked, so the whole sheet fell a keyboard's height mid-drag; `ShareSheet`'s tap layer is the exit (_verifying_) |
| `link-destroy-confirm`, settings drawer, `contract-vectors`      | none          | no keyboard can be up: an alert drops it on open, the other two hold no field                                           |

`"handled"` sits on every row above that carries a mode — the rule in 2 has no
exception.

### a submit drops it — when the answer lands below the button

The three paths above are the USER's. This one is the app's, and it exists
because of rule 2: `"handled"` delivers a press to the button and leaves the
keyboard alone, and a `Pressable` takes no focus, so the field that was being
typed in is still focused when the handler runs. **Nothing dismisses a keyboard
on a button press by default.** RN's own default (`'never'`) looks like it does,
but that is the tap-eating one — it drops the keyboard INSTEAD of pressing the
button.

Usually that is right, and the geometry says when it is not. A button that was
pressed with the keyboard up was above the keys. Whatever the press mounts
**above** the button is therefore on screen (it pushes the button down, not
itself); whatever it mounts **below** is in the band the keyboard covers, because
a `KeyboardAwareScrollView` keeps the focused FIELD clear by `bottomOffset` and
nothing under it. The specimen is `/sign-in` on a tall Android phone: the card is
centred, Sign in sits just above the keys, and "Incorrect username or password"
mounted one line lower, behind them — with the recovery link, the next thing a
wrong password needs, under that.

So: **a terminal submit whose answer renders below its button calls
`Keyboard.dismiss()` first** — in the press handler, before the work, not in the
`catch`. Dismissed late, the keyboard is held up through the request and falls
after the error has already mounted behind it; and on success its hide runs
against whatever the submit navigates to. The sites:

| submit                                                                 | what lands below it                         |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `sign-in-form.tsx`, both doors                                         | the `root` error, then the mode-switch link |
| `account-section.tsx` — delete account, change password, recovery code | the `mt-3` `ErrorText`                      |

Return on the last field of both sign-in doors is wired to the same handler
(`onSubmitEditing`), so the two ways of submitting end in the same state; a
single-line field has already blurred itself by then (1).

**It is not a `Button` default, and must not become one.** Most presses made with
a keyboard up are part of the typing, or have their own answer already:

- the reveal eye in `password-input.tsx`, and the mode toggles that swap in a
  field which then takes focus (sign-in's recovery door, create-account's
  Continue into the confirm step) — the keyboard is about to be wanted again;
- the pickers that set `submitBehavior="submit"` to keep it for the next entry (1);
- anything parked ON the keyboard — the add panel's Save (on the keys as the
  sheet, 8pt above them as the wide card), and every other `Sheet` footer's —
  where nothing can land behind it and the press closes the surface anyway;
- a `Dialog`'s buttons: the avoider lifts the whole card, error slot included;
- a submit whose error belongs to the FIELD and mounts above the button —
  `lock-pane.tsx`, create-account's confirm step. It is visible by the geometry
  above, and the user's next act is to retype.

**A field that goes `editable={false}` while focused drops the keyboard on its
own**, and that is a dismissal nobody wrote. It reads as a double-submit guard —
`editable={!busy}` — and it is one, but disabling a focused input also takes its
focus on both platforms: iOS's `RCTUITextField` maps `editable` onto `enabled`,
and a disabled `UITextField` resigns first responder; Android's `setEditable` is
`view.isEnabled`, and `TextView.setEnabled(false)` hides the soft input. Nothing
puts the focus back when the flag clears.

The specimens were the two lock fields, `lock-pane.tsx` and
`lock-password-dialog.tsx`, both in the list above as submits that keep their
keyboard and both carrying the prop. The pane calls no `Keyboard.dismiss()`, yet
a press on Unlock with a wrong password ended with the error showing and the
keyboard down, and the retype cost the same tap the dismissing sites pay. Their
web twins never disabled the field. Verification leaves both fields editable,
and each has a spec guarding that retry (`lock-pane.spec.tsx`,
`lock-password-dialog.spec.tsx`). Creating a lock is a commitment: its dialog
takes `mode="create"`, holds the password and hide option steady while saving,
and restores editing on failure. The native password field then goes
non-editable; web uses `readOnly` so focus remains in the field.

So the rule has two halves:

- **Re-entry is guarded in the handler and on the button** — `if (busy) return`,
  `disabled={busy}` — at every submit. That is the whole guard; the field is not
  part of it.
- **A field is taken away only where the form is a commitment the screen must
  keep showing while it runs**: `account-section.tsx`'s delete account, change
  password and recovery code (`new-password-field.tsx` through its `disabled`
  prop), and creating an app/list lock (`LockPasswordDialog` with
  `mode="create"`). A new password edited while it is being applied is a
  password the user remembers wrongly. The account operations in the table above have dismissed
  the keyboard already. Lock creation deliberately accepts the dismissal;
  verification keeps the keyboard for a retry.

Everything else — both sign-in doors, the add panel, the editors, the rename
fields, the pickers, lock verification — leaves its fields editable, and
decides the keyboard on purpose or not at all.

Because verification stays editable, both lock surfaces keep the field's latest
text in a ref beside the state. A refused or failed attempt may publish its
field error only if the field still holds what that attempt submitted; a late
answer must not label corrected typing as wrong. The comparison is by VALUE, not
by a count of edits: a character typed and deleted while the answer was pending
leaves the refused text on screen, and a counter would have swallowed that
refusal. The pending button still prevents a second attempt until the first
settles. Component specs cover refusal, failure, retry with the edited value,
and the edit that was put back.

One asymmetry remains in the lock pane, and it is the platform's: Return on a
single-line field blurs before it submits (1), so a wrong password sent from the
keyboard still ends with the keyboard down, while the same password sent from the
Unlock button keeps it. `submitBehavior="submit"` would level them, and is not
taken: with no button press there is no geometry saying the error under the field
is clear of the keys.

The two lock fields were driven after the prop came out, on the Pixel 8 AVD and
the iPhone 17 Pro simulator: a refused password leaves the error showing and the
keyboard up ([locks.md](./locks.md) has the table).

The cost at the sites that do dismiss is one tap back into the field to retry.

**Status:** not yet driven on a device or an emulator. The Maestro flows cannot
tell either way — every one of them runs `hideKeyboard` BEFORE pressing these
submits (`subflows/sign-in-fields.yaml`, `flows/recovery-sign-in.yaml`,
`flows/delete-account.yaml`), so they pass with or without the dismiss. Keep it
that order: a `hideKeyboard` placed AFTER one of these presses finds no IME, and
on Android that is a back press delivered to the app (_verifying any of this_).

## arrival — what may take focus on mount

`autoFocus` on native is not web's `autoFocus`. Focusing a `TextInput` **summons
the keyboard**, so on a pushed screen it runs the keyboard's slide-up against the
navigator's slide-in, and then has the screen's `KeyboardAwareScrollView` scroll
the field clear — all before the screen has finished arriving. This is the same
divergence [editors.md](./editors.md) records for the editor's `focus` field,
where native scrolls the field into view instead of focusing it.

The rule is **not** "never on a pushed screen". It is what sits above the field,
and whether the user arrived already committed to typing:

- **Focus on mount** when the screen exists to receive the typing and carries
  nothing to read first: the add panel's URL field (`links/link-add-panel.tsx`),
  the links search box (`links/search-bar.tsx`), `lock-pane.tsx`'s password when
  there is no biometric to offer instead — and the pane was arrived at.
- **Don't** when the surface went up because the user just asked for the
  opposite. "Lock now" on the list being shown mounts that same lock pane
  underneath the open drawer, and its autofocus raised a keyboard over the rail
  for a field nobody could see. The pane takes `solicit={false}` there and from
  "Lock app", which withholds the focus and the biometric prompt alike
  ([locks.md](./locks.md), _a hand relock does not ask to be undone_).
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
- **`shrink` on a `ScrollView` is only half the pair — it needs `grow-0` too.**
  The cap/`shrink` rule above is written for a body that can OUTGROW the cap;
  the other direction has its own trap. A `ScrollView` arrives with
  **`flexGrow: 1` already set in its own base style** (react-native's
  `ScrollView.js`, `styles.baseVertical`), and no class we write cancels it —
  `shrink` sets `flexShrink` and leaves the grow standing. Directly under
  `AlertDialogContent` that grow claims every point the `max-h-full` cap offers,
  so the Lists/Tags "Delete list?" confirm — two lines of text — rendered FULL
  HEIGHT, its footer pinned at the bottom of the screen and a screenful of empty
  popover between the message and the buttons. Fix is `className="shrink grow-0"`
  (`table-kit.tsx`, `link-destroy-confirm.tsx`); the long-description case still
  shrinks and scrolls, which is the point of keeping both.
  Two things measured on the simulator while cornering it, because each would
  otherwise cost the session again: dropping `max-h-full` does **not** help — it
  is the grow, not the cap — and adding `w-full` to `AlertDialogContent` **does**
  suppress it, which is why `dialog.tsx`'s own `w-full` content never showed this
  and `list-command.tsx`'s `max-h-80 shrink` scroller measured clean under it. We
  did not take that route: the alert dialog omits `w-full` deliberately so a short
  confirmation hugs its text (`ui/alert-dialog.tsx`). Nothing catches any of it —
  no overflow, no clipping, no error; the box is merely the wrong size, and jest
  renders no layout.

## verifying any of this

**The tests barely cover it.** The Maestro flows that need the keyboard gone use
`hideKeyboard`, a native command that bypasses the app's own affordances
entirely, and jest renders none of this. One e2e case is the exception:
`VIEWPORT-KEYBOARD-001` (`e2e/mobile/flows/keyboard.yaml`) requires the add
panel's URL and Note fields, the search box and its controls, and — on Android —
the share tag picker's field, Create row and Done to sit above the keyboard's
measured frame, then dismisses each by the app's own path (the panel's chrome,
a drag on the results, a tap and then a drag on the empty pane a search with
no match leaves, the share sheet's gap) and requires the surface and its
draft to survive. Every other surface and path in this doc is still checked by
hand, on a device or simulator.

**And the instrument has holes.** Driving the keyboard with Maestro ran into six
separate blind spots, each of which reads exactly like a failing fix. They were
measured on iOS except where noted:

- **Over the iOS share extension, the panel leaves the accessibility tree the
  moment the keyboard is presented.** `maestro hierarchy` returns only the
  keyboard's own keys and the status bar; a `testID` that resolved a step
  earlier (`share-back`) goes not-found. Coordinate taps have nothing to confirm
  against, so a tap that does nothing and a tap that was never delivered are
  indistinguishable. **The share sheet's dismissal path is therefore a manual
  check, and no flow will ever make it.** Its tap layer has been driven by hand
  on an iPhone — a tap on the panel's empty space drops the keyboard — and that
  result is what the pickers' `interactive` scrollers rest on (_dismissal_, 3):
  re-drive it by hand after touching `ShareSheet`'s wrapper. Driven the same
  way: `interactive`'s other iOS exit, a drag down into the keys, is not one to
  count on there. A pull down from the top of a picker's list goes to the
  system sheet the extension sits in, not to the scroller — a short one tucks
  the keyboard away and returns it to the still-focused field, a long one
  dismisses the whole sheet. That holds with the keyboard down too, so it is the
  host's gesture rather than anything `keyboardDismissMode` chose; the pickers
  now hold it off natively, so there a pull from the top makes the sheet resist
  and stay ([share-sheet.md](./share-sheet.md), _the pickers hold the system's
  swipe off_).
- **Portaled content is not in the tree either** — the links topbar's dropdown
  (`more-options-menu.tsx`) never appears, so "open the menu, tap Settings"
  cannot be driven that way. Reach settings through the drawer instead.
- **The keyboard's autocorrect bubble intercepts taps and matches text.** A
  `tapOn: "Longreads"` resolved to the suggestion strip floating over the row.
  Prefer a filter term the keyboard won't offer a correction for, or tap the row
  by coordinate below the bubble.
- **`hideKeyboard` is a TAP on iOS and a BACK PRESS on Android**, and it
  misleads on both. On iOS it puts the keyboard away by pressing a blank area, so
  on any surface with a tap-to-close backdrop it closes the surface — the add
  flows lost their Save button to it mid-run, reported as a missing element
  rather than as a dismissal. On Android it is `input keyevent 4`, sent
  **unconditionally**: Maestro never checks whether a keyboard is up (2.8.0,
  `AndroidDriver.hideKeyboard` — one `shell`, a 300 ms sleep, a settle). So the
  moment the field has already dismissed its own IME, the press is a plain back
  press delivered to the app, and whatever `BackHandler` is mounted answers it.
  A `pressKey: Enter` on any single-line field is enough to get there, since RN
  resolves `submitBehavior` to `'blurAndSubmit'` — which is how the shot leg's
  search step lost the search UI to `links/topbar.tsx`'s handler and photographed
  the unfiltered library instead (`e2e/mobile/shots/store.yaml`, and
  [e2e.md](./e2e.md), _keyboard dismissal_). Nothing fails: the back press is
  consumed and reported as handled, and the capture is a perfectly good picture
  of the wrong screen.
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
