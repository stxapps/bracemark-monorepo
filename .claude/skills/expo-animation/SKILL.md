---
name: expo-animation
description: Motion in bracemark-expo — Reanimated 4 worklets, gestures, layout animations, press feedback, sheets, screen transitions and reduced motion, in the order that decides whether they feel right. Use when animating anything in `apps/bracemark-expo`, adding a gesture or drag, or fixing motion that stutters on device. Not for bracemark-web (CSS/Tailwind transitions there). Vendored from expo/skills and adapted; `docs/` wins on conflict.
version: 1.0.0
license: MIT
---

# Building Animations in Expo

This skill was created in collaboration with [Emil Kowalski](https://github.com/emilkowalski) and can also be found in the [emilkowalski/skills](https://github.com/emilkowalski/skills) repository, along with other useful animation skills.

> **Vendored from [expo/skills](https://github.com/expo/skills) (MIT, `plugins/expo/skills/expo-animation`), 2026-08-23.**
> Local edits: the "In this repo" section below, the dependency/haptics/setup
> notes marked _(bracemark)_, and the removal of the upstream feedback command.
> Where this file and `docs/` disagree, **`docs/` wins** — it is the design record.

## In this repo — read before anything below

Scope: **`apps/bracemark-expo` only.** `bracemark-web` has no Reanimated; it
animates with CSS/Tailwind transitions.

- **The roots are already mounted.** `GestureHandlerRootView` and
  `KeyboardProvider` wrap the tree once in `src/app/_layout.tsx` (the gesture
  root outermost, deliberately — that file's header says why). Never add a
  second one.
- **Nothing here is installed with a version.** The convention is
  `npx expo install <pkg>` from inside `apps/bracemark-expo`, then move the
  app's entry to `*` and pin the real version once in the **root**
  `package.json`; packages declare a peer `*`. Never write `*` in the root
  manifest, never declare `expo-modules-core`, and follow any bump with
  `npm dedupe`. → `docs/expo-native-deps.md`, `docs/architecture.md`
  (_dependency versions_). Anything native then needs `npx expo prebuild`
  before it exists on a device.
- **`expo-haptics` is deliberately NOT installed.** Step 8's table is a
  proposal here, not an instruction — adding it is a native-dependency
  decision (a new native module, a prebuild, a doc entry), so raise it rather
  than install it mid-animation. `src/features/settings/drag-sort.tsx` and
  `src/features/links/link-row.tsx` already record, in comments, the exact
  seams a tick would hang off and why they're empty.
- **New Architecture is on** (`newArchEnabled: true` in `app.config.ts`), with
  Reanimated `~4.1` and worklets `0.5.1` — so `scheduleOnRN` (not the
  deprecated `runOnJS`) is correct. Gesture Handler is pinned at `~2.28`, so
  the v2 `Gesture.Pan()` builder is the API: **ignore the "Gesture Handler v3"
  note in RECIPES.md.**
- **Styling is uniwind `className`, not `StyleSheet`.** Recipes written with
  `style={{ … }}` are right for the animated half — `useAnimatedStyle` output
  belongs in `style` — but the static half is a class list. Two failures there
  are silent: a class uniwind can't map produces no style and no error, and
  `rem` is baked at build time (`value * 16`), so an expo `max-w-*` does not
  move with OS font scale. → `docs/theme.md`.
  `src/components/ui/native-only-animated-view.tsx` is the existing carrier for
  `entering`/`exiting` on a view that must not animate on web.
- **Reduced motion has a house spelling.** Layout animations carry
  `.reduceMotion(ReduceMotion.System)` — see `components/ui/alert-dialog.tsx`,
  `dialog.tsx`, `dropdown-menu.tsx`. Match it. Font scaling and announcement
  rules for anything the animation reveals: → `docs/accessibility.md` (an error
  message that MOUNTS must announce; `components/error-text.tsx` is the one
  carrier).
- **Expo Router is v6 on SDK 54**, and navigation is `@react-navigation/drawer`
  plus native stacks. Anything below that needs SDK 56+ (`@expo/ui`,
  `expo-router/react-navigation` imports) does not apply, and the SDK is capped
  by `@nx/expo` — never "upgrade to fix" a motion problem.
- **`ios/` and `android/` are generated and gitignored.** Every native-side
  change — `CADisableMinimumFrameDurationOnPhone` included — belongs in
  `app.config.ts` or a config plugin. An Xcode edit leaves a clean tree and
  dies at the next `expo prebuild --clean`. → `docs/expo-build.md`.
- **To judge feel, use the `verify` skill.** There is no Expo Go here (dev
  client only), and the simulator is not where a spring is judged.

---

A construction skill for React Native. It turns a request for motion into an implementation that survives a strict review on a real device — not in the simulator, not on a flagship phone in dev mode.

Mobile changes three things about animation, and everything in this skill follows from them:

1. **There is no hover.** Every affordance the web puts in hover has to live in press, position, or nothing.
2. **There are two runtimes.** Worklets (Reanimated 4) makes this explicit: the React Native runtime, where React renders and your app logic runs, and the UI runtime, where worklets run every frame (plus optional worker runtimes for background work). An animation that touches the RN runtime stutters the moment the app does anything else. The whole craft is keeping motion on the UI runtime.
3. **The user's finger is on the element.** Gestures are the primary input, so interruptibility and velocity handoff aren't polish — they're the baseline.

## Operating Posture

You are a senior mobile engineer building the animation yourself. Make the call, state the reasoning in one line, write the code. Never present motion options as a menu.

Two failure modes, and the first is worse:

1. **Animating something that shouldn't animate.** The gate below exists to produce zero lines of code sometimes.
2. **Animating the right thing on the wrong thread** — a `setState` per frame, a `PanResponder`, an animated `height`. It looks fine in dev on your phone and drops to 20fps on a three-year-old Android.

## Hard Rules

1. **Run the sequence in order.** Steps 1 and 2 gate everything.
2. **Reanimated, not core `Animated`.** Core `Animated` can't be driven by a gesture without crossing the bridge, and `useNativeDriver` refuses anything but transform and opacity anyway. Reanimated worklets run on the UI thread and keep running while JS is busy.
3. **No approximated values.** Curves and spring configs come from the tables below.
4. **Reduced motion ships with the animation**, not as a follow-up.
5. **Feel is judged on a release build on the slowest device you support.** Nothing else counts as verified.

## The Build Sequence

### 1. Should this animate at all?

| Frequency | Decision |
| --- | --- |
| 100+ times/day — tab switches, keyboard open/close, scrolling, toggles in settings | **No animation.** Platform default or nothing. Stop here. |
| Tens of times/day — press feedback, list navigation, row selection | Near-imperceptible only: under 150ms, or nothing |
| Occasional — sheets, modals, toasts, onboarding steps | Standard animation |
| Rare / first-time — success states, empty-state illustrations, celebration | The delight budget lives here |

**Tab switches never slide.** Tabs are peers, not a hierarchy — sliding implies depth that isn't there, and the user pays for it dozens of times a session. `animation: 'none'`.

If the request fails this gate, say so and don't write it.

### 2. What is the purpose?

Name it in one word before continuing: **feedback**, **spatial consistency**, **state indication**, **preventing a jarring change**, **explanation**, or **delight** (rare tier only).

Can't name it? Don't build it.

### 3. Pick the tool — cheapest that works

Walk down; stop at the first that fits.

| Need | Tool |
| --- | --- |
| A state-driven change with no gesture — press, toggle, color, a value flipping | **Reanimated CSS transition** (`transitionProperty` in the style) |
| Loop, multi-stage, or plays on mount with no state change | **Reanimated CSS animation** (`animationName` keyframes) |
| An element mounting or unmounting, or a list reflowing | **Layout animations** (`entering` / `exiting` / `itemLayoutAnimation`) |
| Anything a finger touches, or anything derived from scroll | **`useSharedValue` + `Gesture` + `useAnimatedStyle`** |
| Screen to screen | **Native stack options in Expo Router.** Never hand-roll this |
| A bottom sheet that is its own screen | **`presentation: 'formSheet'`** — it's a real UISheetPresentationController, free and correct |
| Tab bar | **`NativeTabs`** (from `expo-router/unstable-native-tabs`) — the platform's real tab bar, its behaviors and transitions included. _(bracemark: this app has no tab bar — top-level navigation is `@react-navigation/drawer`.)_ |
| Context menu, press-and-hold preview | **`Link.Menu` / `Link.Preview`** (Expo Router, iOS-only) — native menus and peek, never rebuilt in JS |
| Header that collapses into a large title | **`headerLargeTitleEnabled`** on the native stack (iOS-only; `headerLargeTitle` is deprecated) — not a scroll worklet |
| Pull to refresh | **`RefreshControl`** — hand-roll only when it's a signature interaction (see the threshold recipe) |
| UI that tracks the keyboard | **`react-native-keyboard-controller`** — the keyboard's real position, frame by frame, on the UI thread |
| Vector illustration, celebration, empty state | **Lottie** — for illustration only, never for UI state |
| A huge animated scene, freeform drawing | **`@shopify/react-native-skia`** — a canvas, for when the view hierarchy itself is the bottleneck |

Reach for a shared value only when the value is continuous or interruptible. A press scale is a CSS transition; a drag is a shared value. Using a worklet for a two-state toggle is the mobile equivalent of installing a motion library for a fade.

**Dependencies.** _(bracemark)_ `npx expo install <package>` from inside
`apps/bracemark-expo` to resolve the SDK-54-compatible version — then move the
app's entry to `*` and pin the real version once in the **root**
`package.json`, and `npm dedupe`. Plain `npm install` picks the wrong version;
leaving the pin in the app manifest breaks the workspace's version scheme. Of
the table below, only `expo-haptics`, `lottie-react-native` and Skia are absent
today, and adding any of them is a native-dependency decision — raise it:

| Need | Package |
| --- | --- |
| Animation | `react-native-reanimated` + `react-native-worklets` |
| Gestures | `react-native-gesture-handler` |
| Navigation, sheets, native tabs, menus | `expo-router` |
| Haptics | `expo-haptics` |
| Keyboard-following UI | `react-native-keyboard-controller` (needs `KeyboardProvider` at the root — see the keyboard recipe) |
| Illustration, celebration | `lottie-react-native` |
| Very large animated scenes, custom drawing | `@shopify/react-native-skia` |

### 4. Pick the properties

- **`transform` and `opacity` are free.** Everything else is a layout pass. `width`, `height`, `margin`, `padding`, `flex`, `top`, `left`, `gap` re-run Yoga on every frame for that node *and its siblings*.
- **The one exception: an absolutely positioned element with no children** — a tab pill, a progress bar fill. It's out of flow, so nothing else re-lays-out, and animating `width` keeps the corner radius that `scaleX` would smear.
- **Never `scale(0)`.** Start from `scale(0.9–0.97)` + `opacity: 0`. Nothing in the real world appears from nothing.
- **`transform` is an array and order matters** — `[{ translateY }, { scale }]` scales after moving; reversed, the translate gets scaled too. Keep translate first unless you want the multiplication.
- **Android shadows are `elevation`, and animating elevation re-renders the shadow every frame.** Animate opacity of a pre-shadowed layer instead.
- **Never animate `BlurView` intensity.** On Android it re-renders the blur each frame. Crossfade the opacity of a static `BlurView` instead.
- **Percentages work in `translate`** and are relative to the element's own size — `translateY('100%')` moves a sheet by its own height whatever its content.

### 5. Timing or spring

**If a finger was involved, use a spring.** Springs carry velocity through an interruption; timing curves restart. Everything else uses timing.

Reanimated's spring takes Apple's two designer parameters directly — use this form, not mass/stiffness/damping:

| Interaction | Config |
| --- | --- |
| Default settle, no overshoot | `{ duration: 400, dampingRatio: 1 }` |
| Reposition / snap back after a drag | `{ duration: 400, dampingRatio: 0.8, velocity }` |
| Sheet, drawer | `{ duration: 300, dampingRatio: 0.8, velocity }` |
| Must not pass a hard edge | add `overshootClamping: true` |

**Bounce only when the gesture carried momentum.** Overshoot on a menu that faded in feels wrong; overshoot on a card you flicked feels right.

**Easing**, for everything without a finger on it:

| Situation | Easing |
| --- | --- |
| Entering or exiting | `ease-out` |
| Moving / morphing on screen | `ease-in-out` |
| Constant motion (progress, marquee) | `linear` |
| Default | `ease-out` |

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching. Reanimated's built-ins are as weak as CSS's — use these:

```js
import { Easing } from 'react-native-reanimated';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);      // strong ease-out for UI
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);  // on-screen movement
const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1);    // iOS sheet curve
```

**Duration:**

| Element | Duration |
| --- | --- |
| Press feedback | 100–150ms |
| Toggle, chip, small state change | 150–200ms |
| Sheet, modal, drawer | spring, ~300ms perceived |
| Screen transition | the platform default — don't override it |

Mobile UI animations stay under 300ms, same as web. The platform's own transitions are longer (iOS push is 350ms); match the platform for navigation, beat it everywhere else.

### 6. Keep it off the JS thread

This is the mobile-specific craft, and it's where most React Native motion dies.

- **Never `setState` from a gesture or scroll handler.** One React render per frame is the single biggest cause of jank in RN apps. Shared value → `useAnimatedStyle`, and React never re-renders at all.
- **Never schedule back to the RN runtime inside `onUpdate` or a scroll handler.** `scheduleOnRN(fn, ...args)` from `react-native-worklets` — the Reanimated 4 replacement for the deprecated `runOnJS(fn)(...args)` — queues an RN-runtime call, and in `onUpdate` that's 60–120× per second. It belongs in `onEnd`, or in a `useAnimatedReaction` that fires when a value crosses a threshold.
- **Never read a shared value during render** (`translateY.get()` in JSX). It's a snapshot that never updates and it silently desyncs. **Never write one during render either** — it fires mid-reconciliation, and a re-render you didn't cause replays the write. Touch shared values only in worklets, handlers, and effects.
- **Use `.get()` / `.set()`, not `.value`.** Same API, but direct `.value` access is the form the React Compiler can't see through — the Reanimated docs call `get`/`set` the compiler-safe way. `set` also takes a functional update: `sv.set((v) => v + 1)`.
- **Functions called from a worklet need `'worklet'`** as their first line, or they throw at runtime on device while working fine in the debugger.

### 7. Press, not hover

Every hover affordance from the web has to be redesigned, not ported.

- **Feedback on press-in, commit on press-out.** Waiting for the tap to complete before showing anything feels dead — this is the latency the user actually perceives.
- **`scale: 0.97` in 100–150ms** on any pressable, `Pressable` + a CSS transition. `scale` takes the label and icons with it, which is what makes it read as physical.
- **44×44pt minimum touch target** (48dp Android). If the visual is smaller, add `hitSlop` — don't grow the visual.
- **`pressRetentionOffset`** so a finger drifting a few pixels doesn't cancel a press the user meant.
- **Android ripple only in a Material-styled app.** In a custom-designed app, the same scale on both platforms is more coherent than a ripple on one.

### 8. Haptics

> _(bracemark)_ **`expo-haptics` is not installed, on purpose.** Treat this
> section as the design for a tick, not a licence to add one: propose it, name
> the seam, and let the native-dependency call be made explicitly.
> `features/settings/drag-sort.tsx` and `features/links/link-row.tsx` mark the
> two seams that are deliberately empty.

Mobile has a sense the web doesn't. Use it sparingly and it becomes the thing that makes the app feel expensive; use it everywhere and users turn it off.

| Moment | Call |
| --- | --- |
| A value ticks past a step — picker, slider detent, segmented control | `Haptics.selectionAsync()` |
| Something snaps home, a sheet detent catches, a drag commits | `Haptics.impactAsync(ImpactFeedbackStyle.Light)` |
| A heavy object lands, a destructive action fires | `Haptics.impactAsync(ImpactFeedbackStyle.Medium)` |
| Operation succeeded or failed | `Haptics.notificationAsync(NotificationFeedbackType.Success / Error)` |

Three rules, and they're absolute:

- **Same frame as the visual.** A haptic that lags its animation reads as a glitch, not as feedback. Fire it at the causal moment — the detent catching — not when the animation finishes.
- **One per user action.** Never on scroll, never per frame, never on an entrance animation the user didn't cause.
- **Never the only feedback.** Haptics are off system-wide for many users, and silent on most Android hardware. The visual has to stand alone.

From a worklet, haptics must be scheduled back to the RN runtime: `scheduleOnRN(Haptics.selectionAsync)`.

### 9. Reduced motion and accessibility

```jsx
import { useReducedMotion, ReduceMotion, withSpring } from 'react-native-reanimated';

const reduced = useReducedMotion();
const y = useSharedValue(reduced ? 0 : SHEET_HEIGHT);

// or let each animation decide
withSpring(0, { duration: 300, dampingRatio: 0.8, reduceMotion: ReduceMotion.System });
```

_(bracemark)_ The house spelling for layout animations is
`.reduceMotion(ReduceMotion.System)` on the entering/exiting descriptor —
`components/ui/alert-dialog.tsx`, `dialog.tsx` and `dropdown-menu.tsx` are the
reference sites. Match them rather than branching on `useReducedMotion()` where
a descriptor will do.

Reduced motion means **fewer and gentler**, not zero: keep opacity and color changes that explain a state change, drop translation, scale, parallax and overshoot. Screen transitions become `animation: 'fade'`.

**Text scales.** `allowFontScaling` is on by default, so any height you measured at default type size is wrong at 200%. Never animate to a hardcoded height — measure with `onLayout`, or animate a transform instead.

## Setup that silently breaks motion

Check these first when "the animation just doesn't run":

- `babel-preset-expo` configures the worklets Babel plugin automatically — no
  `babel.config.js` step. A missing or misplaced plugin throws `Failed to create
  a worklet` at runtime rather than falling back silently.
- `GestureHandlerRootView` must wrap the app, or gestures do nothing with no
  error. _(bracemark: already mounted in `src/app/_layout.tsx` — check there
  before adding one.)_
- Reanimated 4 requires the New Architecture. _(bracemark: on —
  `newArchEnabled: true` in `app.config.ts`.)_
- **A dev build is not a performance environment.** Judge feel in a release
  build; a dev build's JS thread is slow enough to hide exactly the problems
  you're looking for. _(bracemark: there is no Expo Go here at all — it's a dev
  client. See the `verify` skill for getting either build onto a device, and
  `docs/expo-build.md` for the release variant.)_

## 120fps

On ProMotion iPhones, third-party animations are capped at 60fps unless `CADisableMinimumFrameDurationOnPhone` is set. Recent Expo SDKs set it by default — confirm it's there, and add it if not:

```json
{ "expo": { "ios": { "infoPlist": { "CADisableMinimumFrameDurationOnPhone": true } } } }
```

Then the frame budget is 8ms, not 16. This is also why a UI-thread animation
matters more on mobile than it does on web.

_(bracemark)_ `apps/bracemark-expo/app.config.ts` does **not** currently set it.
If a 120fps-sensitive animation lands, add it to that file's `ios.infoPlist` —
never in Xcode, since `ios/` is generated and gitignored
(→ `docs/expo-build.md`) — and say so in the change.

## Recipes

For ready-to-build implementations — press feedback, drag-to-dismiss sheet, swipe-to-delete, collapsing header, list entrances, keyboard-synced UI, tab indicator, screen transitions — see [RECIPES.md](RECIPES.md). Load it whenever the request matches one; start from the recipe rather than from a blank file.

## Never Ship

| Never | Instead |
| --- | --- |
| `PanResponder` | `Gesture.Pan()` from gesture-handler |
| `setState` in a gesture or scroll handler | shared value + `useAnimatedStyle` |
| `runOnJS` (deprecated in Reanimated 4) | `scheduleOnRN` from `react-native-worklets` |
| `scheduleOnRN` per frame | `onEnd`, or `useAnimatedReaction` at a threshold |
| Reading or writing a shared value during render | `.get()` / `.set()` in worklets, handlers, effects |
| Core `Animated` for anything a finger touches | Reanimated |
| Animating `height` / `width` / `margin` / `flex` / `top` | `transform` + `opacity` (absolute, childless elements exempt) |
| Animating `BlurView` intensity or Android `elevation` | crossfade a static layer |
| `entering` on a virtualized list row | animate the container, or `itemLayoutAnimation` |
| A screen transition rebuilt in JS | native stack `animation` |
| Sliding between tabs | `animation: 'none'` |
| `Easing.in(...)` on a UI element | `Easing.bezier(0.23, 1, 0.32, 1)` |
| `scale(0)` entrance | `scale(0.95)` + `opacity: 0` |
| Distance-only dismissal threshold | velocity **or** distance — a flick is enough |
| Hard stop at a boundary | rubber-band resistance |
| A haptic per frame, or as the only feedback | one per commit, always paired with a visual |
| Judging feel in Expo Go or the simulator | release build, slowest supported device |

## Output

Write the code. Then, in at most a few lines:

- **The gate result** — frequency tier and named purpose. Say what you rejected and why.
- **The ingredients** — tool, properties, spring or curve + duration, thread.
- **What to feel-check on device** — gestures, velocity handoff and haptic timing cannot be judged from code. Name what to try: flick it, interrupt it mid-flight, reverse it, run it on the slowest Android you have. _(bracemark: the `verify` skill owns launching the simulator/emulator, and its cost ladder applies — don't screenshot what a read or a test settles.)_

The code is the deliverable. Don't pad it into a report.

## Tone

Opinionated and brief. When the honest answer is "this shouldn't animate," or "this needs a real device before I can tell you if it's right," give it.

## Feedback on this file

This is a vendored copy — the upstream `submit-expo-feedback` flow is not wired
up here. If something in it is wrong for this repo, fix it in place and, when
the correction is really about the repo's design, record it in the matching
`docs/` file instead.
