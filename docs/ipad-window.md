## iPad windows

What bracemark-expo does in iPadOS 26's windowed multitasking, and the open bug
in it: **the system's window controls sit on top of the app's top-left corner.**

**Status: found and measured, not designed or built.** This doc holds what is
known so the design can start from it. No app code handles the window controls
yet. The rules for layout at any window size are in
[safe-area.md](./safe-area.md), _wide windows on native_. The simulator setting
the e2e runs need is in [app-drivers.md](./app-drivers.md), _the iPad simulator_.

### what a window looks like to the app

iPadOS 26 has three modes, under _Settings → Multitasking & Gestures_: Full
Screen Apps, Windowed Apps and Stage Manager. Every new iPad simulator starts in
**Windowed Apps** (read on a never-booted iPad Air 11-inch, iOS 26.5). A real
iPad's mode, new or upgraded, has not been checked.

Windowed does not always look windowed. Upright on the iPad (A16), the app filled
the screen at 820 × 1180, with a resize grip in the bottom-right corner and no
window controls in the screenshots. Turned on its side, the same app became a
632 × 384 window with the controls showing. Why it took that size, whether iPadOS
remembers it per orientation, and at which sizes the controls appear have not
been worked out.

**Resizing already works.** A 384pt-wide window is under 768, so the app used its
narrow layout, with the drawer and the sheet, as
[safe-area.md](./safe-area.md) says it should.

### the bug

⚠ **The window controls cover the links topbar's drawer button.** They also cover
the "M" of the list name in the topbar and the logo in the drawer's header.
Nothing reports this: no lint, type or test failure, and the e2e runs now refuse
this mode (_test coverage_, below).

Measured on the iPad (A16) simulator, iOS 26.5, Maestro 2.8.0, 2026-10-31, in the
632 × 384 window on a landscape screen:

| what                       | where, from the window's top-left | result                                 |
| -------------------------- | --------------------------------- | -------------------------------------- |
| the controls, as drawn     | x 21–62, y 21–43                  | the system's                           |
| a tap left of the controls | (13, 38)                          | never reached the app; controls expand |
| a tap at the button's foot | (25, 56)                          | opened the drawer                      |

So the button works only through a sliver at its lower edge. **The controls' touch
area is larger than the pill that is drawn**, and a press on it expands them over
more of the corner, so an inset that only clears the drawn 62pt may not be enough.
A tap directly on the pill, and the exact size of the touch area, were not
measured.

The button is `links-open-navigation` in `features/links/topbar.tsx`: `size="icon-sm"`,
`hitSlop={6}`, `-ml-1`.

**Not checked yet**, and likely to share the problem because they use the same
corner: the Settings topbar (`settings-open-navigation`), the docked rail in a
window of 768 or wider, the rail's Show button while it is put away, and any
sheet or dialog with an action in its top-left corner. Stage Manager was not
tried either, and a real iPad has not been used at all.

### the direction

**Keep supporting windows, and move the app's content out of the way.**

**Opting out is not an option.** `UIRequiresFullScreen` is deprecated. Apple's
TN3192 says the key is ignored and offers
`UIRequiresFullScreenIgnoredStartingWithVersion` only as a temporary step during
migration. It would also give up Split View, against the no-orientation-lock
decision in [expo-build.md](./expo-build.md).

System navigation bars adapt to the controls by themselves, according to Apple's
guidance. Bracemark's topbars are custom, so they have to do this themselves.

### candidates

| approach                                                         | needs                                                 | doubt                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| read `edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))` | a small expo module, and a way to hear window changes | **first to try.** In the iOS 26.5 SDK's headers, but untested here. See _open questions_               |
| a fixed leading inset when the window is smaller than the screen | `useSafeAreaFrame()` against the screen, JS only      | the fallback. A guessed number; misses a full-screen-sized window showing controls, if that can happen |
| `UISceneWindowingControlStyle.minimalStyle`                      | a scene delegate, which the app does not have         | only shrinks the controls, so the content may still sit under them. Not a fix alone                    |
| `UIRequiresFullScreen`                                           | a plist key                                           | rejected, above                                                                                        |

Any of these ends in the same place: a leading inset the topbars and the drawer's
header apply, so one shared hook is the likely shape, next to the safe-area
handling in [safe-area.md](./safe-area.md). The existing modules are in
`apps/bracemark-expo/modules/`.

### open questions

1. **Does the layout region report the controls in this app?** Developers on
   Apple's forums said in 2025 that they found no public API for the controls'
   frame. The layout-region API exists in the SDK now, but whether it answers for
   these controls, in an app with no scene delegate and on a React Native root
   view, has to be measured first. Log its insets beside the plain safe area,
   in a window and full screen.
2. **Which view asks, and when?** The insets have to update on resize, rotation,
   and a change of multitasking mode. What fires on each is unknown.
3. **Horizontal or vertical adaptation?** Moving content sideways keeps the bar's
   height, and a narrow window then has less room for the title. Pushing it down
   costs height in a short window.
4. **Which surfaces need it?** Work through the unchecked list above.
5. **When do the controls appear?** The answer decides whether the fallback can
   rest on window size at all.
6. **What does Android do?** Freeform windows on a tablet were not looked at for
   this.

### scene lifecycle

Not this bug, but it sits next to it and has a deadline. The app has no
`UIApplicationSceneManifest`, and its `AppDelegate` starts React Native on a
`UIWindow` directly. Apple's migration guide says apps built with the iOS 27 SDK
must adopt the scene-based lifecycle or they fail to launch. The workspace builds
with the iOS 26.5 SDK, so nothing is broken today. It has to be done before the
SDK moves, and how far Expo already covers it was not checked. `ios/` is generated,
so any change goes through a config plugin ([expo-build.md](./expo-build.md)).

It is also what would make `preferredWindowingControlStyle` available.

### test coverage

**Nothing covers this today.** The wide iOS runs refuse any iPad not in Full
Screen Apps (`iosFullScreenApps`, `runner/device.ts`), because a window breaks
`WINDOW-ROTATE-IOS-001`. That is right for those runs, and it means the windowed
layout never runs in e2e.

What the fix should add:

- **A manual check before a release**, in the iPad list in
  [safe-area.md](./safe-area.md): Windowed Apps, at a small and a medium window,
  both ways round, pressing each top-left control. That list and the _wide windows_
  section still name only Split View, Slide Over and Stage Manager.
- **A unit test** for whatever computes the inset.
- **An e2e case, if it can be made reliable.** See below.

### driving a window

Notes for whoever repeats these measurements:

- Set the mode by tapping Settings with Maestro. On `com.apple.Preferences`, the
  sidebar row is `com.apple.settings.multitaskingAndGestures`, and the modes are
  `…multitaskingAndGestures.fullScreenApps`, `.windowedApps` and `.stageManager`.
  `simctl openurl` with `prefs:root=MULTITASKING` fails (error 115).
- Read the mode back from `com.apple.springboard`'s `SBMedusaMultitaskingEnabled`
  and `SBChamoisWindowingEnabled`, with `xcrun simctl spawn <udid> defaults read`
  ([app-drivers.md](./app-drivers.md)).
- ⚠ **Maestro's boxes for the app's own nodes are wrong in a landscape window.** It
  reported `[435,548][820,1180]` for the 632 × 384 window, an offset box clipped to
  the upright screen. Do not measure app nodes there, and do not `tapOn` an `id`.
- Maestro sometimes returns SpringBoard's tree instead, and that one is right, in
  upright coordinates: `card:com.bracemark.app:sceneID:com.bracemark.app-default`
  is the window, `window-controls:com.bracemark.app` the controls and
  `resize-grabber` the grip. Which tree comes back was not controlled.
- `tapOn: point:` takes landscape screen coordinates in that state, and hit the
  expected places. Screenshots from `simctl io` stay upright whichever way the
  device is turned.
- Leave the simulator in Full Screen Apps and upright afterwards, or the next wide
  run is refused.

### sources

- [TN3192: migrating from the deprecated `UIRequiresFullScreen` key](https://developer.apple.com/tutorials/data/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key.md)
- [`UIRequiresFullScreen` deprecation](https://developer.apple.com/forums/thread/793406), Apple forums
- [avoiding the iPadOS 26 window controls](https://developer.apple.com/forums/thread/789303), Apple forums: the report that no API exposes their frame
- [transitioning to the UIKit scene-based life cycle](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle.md)
- `UIViewLayoutRegion.h`, `UISceneWindowingControlStyle.h`, in the iOS 26.5 SDK
