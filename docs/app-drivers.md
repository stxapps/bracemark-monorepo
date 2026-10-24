## app drivers — the browser, the simulator, the emulator, and what drives them

How each app is DRIVEN when a change has to be seen running rather than asserted
on: which browser binary, which emulator, which driver, and what each one cannot
do. Split out of [testing.md](./testing.md), which stays the record of the spec
layer — what earns a spec, jest vs vitest, the shared plumbing, coverage.

Three docs meet here and none of them overlaps: this one is the **instruments**,
[e2e.md](./e2e.md) is the **scripted suite** those instruments run
(`e2e/`, playwright and maestro, the contract runs), and
[device-testing.md](./device-testing.md) is **connectivity** — which of the six
apps a real phone or tablet can reach, in which environment. The runnable half of
this doc — the boot/install/screenshot/query commands for an ad-hoc "show me my
change" run — lives in `.claude/skills/verify/SKILL.md`.

Nothing here is part of `npm run test`, and that is deliberate rather than
pending; the reasoning is in _driving bracemark-web_ below.

### driving bracemark-web

> The scripted form of everything in this section now lives in `e2e/web/`, driven
> by `@playwright/test`. This section remains the _reasoning_ — why a browser is
> reached for at all, and why it isn't a `test` target. For the project layout,
> the fixture constraints and the running instructions, see
> [e2e.md](./e2e.md).

**`playwright-core` is a root devDependency.** It drives the _system_ Chrome via
`executablePath` rather than a downloaded browser — that is why it is
`playwright-core` and not `playwright`, whose install pulls a browser bundle this
repo does not otherwise want (`~/Library/Caches/ms-playwright/`, ~550 MB; see
[e2e.md](./e2e.md), _the browser this repo drives_).

**The one thing the system browser cannot do is load the browser extension.**
Google Chrome refuses an unpacked `--load-extension` — silently, with the launch
succeeding and `chrome://extensions` empty — and neither
`--disable-features=DisableLoadExtensionCommandLineSwitch` nor
`--enable-unsafe-extension-debugging` changes that (measured on Chrome 151).
Playwright's bundled Chromium loads the same directory first try. So driving
`bracemark-extension` is the one task that wants `npx playwright install
chromium`, and it is the only exception to the paragraph above; the operational
loop is in `.claude/skills/verify/SKILL.md`.

```js
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, // default true; add slowMo: 250 to actually watch it
});
```

Because it borrows the system browser, it is pinned against whatever Chrome is
installed, and Chrome auto-updates. Expect an occasional version bump when a new
Chrome breaks a protocol assumption. `/Applications/Chromium.app` works the same
way as a fallback.

It is deliberately **not** wired into any `test` target. `npm run test` means
"unit and component, fast, cached"; a browser-driving target has different cache
semantics and belongs behind its own name if it is ever wanted in CI.

Three ways to reach a browser, which are not three competing options:

- **`playwright-core` headless** — the default. Scripted, repeatable,
  assertable.
- **`playwright-core` headful** — the same script with `headless: false`. A
  flag, not a different tool.
- **claude-in-chrome** — your real Chrome, real profile, real logins, visible
  tab. For "show me", and for anything that needs an existing session.

The concrete flows, selectors and gotchas — account creation, the add-link
popover, list management, the cross-origin sign-out — live in
`.claude/skills/verify/SKILL.md`, which is the operational companion to this
section. Keep them there; this doc is the design record.

### driving native Release builds

Maestro controls the installed UI through platform automation; it does not need
a debuggable app or app-side test instrumentation. Android release APKs can run
on an emulator or ADB-connected physical device with R8 enabled. iOS automation
here uses a Release-configured simulator `.app`, not a store IPA or physical
phone. Official Maestro's physical-iOS limitation is separate from Release
configuration. Android's `run-as` sandbox inspection still requires a debuggable
app, so those cases stay local. The staging runner verifies installed artifact
identity and cold-launches it without Metro:
[e2e/STAGING.md](../e2e/STAGING.md). Real-device/store checklists remain separate.

### driving the native apps

The thing that makes a browser useful to automation is not the screenshot, it is
the **queryable tree**. On mobile that tree is the accessibility tree — which
makes [accessibility.md](./accessibility.md) load-bearing twice over: labels and
roles are what a driver's selectors bind to, so an unlabelled control is
untestable as well as inaccessible.

As with the web surface above, the runnable half — the boot/install/screenshot/
query commands for an ad-hoc "show me my change" run — lives in
`.claude/skills/verify/SKILL.md`, and suite runs live in `e2e/README.md`. This
section stays the design record.

**iOS: `simctl` is lifecycle only.** `boot`, `install`, `launch`, `openurl`
(deep links — useful for share flows), `io … screenshot` / `recordVideo`,
`privacy`, `status_bar override`, `push`. There is **no tap, no type, no
query**. Reaching the a11y tree needs a driver on top: Maestro, Appium +
XCUITest, or Detox. (`idb` would also do it, but the homebrew install on this
machine is broken — a dangling `python@3.10` interpreter and no `idb_companion`.)

**Android: `adb` is the complete loop, with no extra tooling.** `adb shell input
tap/swipe/text/keyevent`, `adb exec-out screencap -p`, `adb shell am start -a
android.intent.action.SEND` for share intents, `adb logcat` — and crucially
`adb shell uiautomator dump`, a real queryable XML view tree. This is the
friendliest of the three surfaces. The Play Store image cannot `adb root`, so
pull the plain `google_apis` variant if that ever matters.

#### the AVDs

Two emulators on one system image — the `android-36.1` `google_apis_playstore`
arm64-v8a:

| AVD                | device                                         | window, in dp                              | role                                                                       |
| ------------------ | ---------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `bracemark-pixel8` | **Pixel 8** (1080×2400, 420 dpi)               | 411 × 914 — phone layout upright           | the canonical phone; every e2e run, every shot                             |
| `bracemark-tablet` | **Pixel Tablet** profile at 1920×1200, 240 dpi | 1280 × 800, sw800 — docked rails both ways | the wide window ([safe-area.md](./safe-area.md), _wide windows on native_) |

The image choice is **disk, not preference**: that one was already downloaded
(2.3 GB), and any other API level or variant is a fresh 1.5–2.5 GB. `minSdkVersion`
is 33, so 36.1 is comfortably in range. Both AVDs read it in place, so the
second one cost no download.

Created with `avdmanager`, which needed `cmdline-tools` — the SDK here shipped
with `emulator` and `platform-tools` only, so it was bootstrapped from Google's
zip (`cmdline-tools;latest`, 22.0, 173 MB installed). `avdmanager` prints a
`Could not load devices from …/devices.xml` error while creating and creates the
AVD correctly anyway; it is reading a device list the system image doesn't ship,
not failing.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
avdmanager create avd -n bracemark-pixel8 \
  -k "system-images;android-36.1;google_apis_playstore;arm64-v8a" -d pixel_8
$ANDROID_HOME/emulator/emulator -avd bracemark-pixel8 -no-audio -no-boot-anim &
```

**⚠ That trailing `&` runs the emulator at nice 5 under zsh.** zsh's
`BG_NICE` option, on by default, renices every background job, and macOS then
schedules the `qemu-system` process as background work (`ps -o pri,nice` read
priority 4, nice 5, against 47 and 0 for a foreground launch). Nothing fails:
the guest just runs slower. The specimen is `measure:data:android`, whose
calibration read 3,163–3,333 ms against a 761–886 ms band, which made every
stall 4× too long. A `npm run dev` started the same way is niced too. For
anything timed, run the emulator in a terminal of its own, or put
`setopt no_bg_nice;` in front of the line. Check with
`ps -o pri,nice -p $(pgrep -f qemu-system)`
([data-lifecycle.md](./data-lifecycle.md), _readings — expo_, **2026-10-24,
the statement leak**). **Nice 0 is not the whole check.** On 2026-10-24 an
emulator started with `setopt no_bg_nice` read nice 0 but priority 4 just
before a `measure:data:android` run. That run's first size calibrated at
3,336–3,610 ms. By its second size the calibration was back to 760–810 ms, and
priority to 47. What demoted it was not found. Read the calibration whatever
`ps` says (**2026-10-24, the gather profiled**).

Six edits to `~/.android/avd/bracemark-pixel8.avd/config.ini` after creating it,
four for disk and two the defaults get wrong for e2e:

| key                         | default → set    | why                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------- |
| `disk.dataPartition.size`   | `10G` → `6G`     | the qcow2 grows into this cap                              |
| `hw.sdCard` / `sdcard.size` | `yes`/512M → off | nothing here uses one                                      |
| `fastboot.forceColdBoot`    | `no` → `yes`     | a boot snapshot is ~RAM-sized, ~2 GB                       |
| `firstboot.*Snapshot`       | `yes` → `no`     | ditto, plus avoids a snapshot download                     |
| `hw.gpu.enabled`            | **`no`** → `yes` | `no` is software rendering — slow enough to time out flows |
| `hw.keyboard`               | **`no`** → `yes` | hardware keyboard for `inputText`                          |

Measured: 32 s cold boot, and `maestro hierarchy` returns a 69 KB tree at exit
0 — the same attach check _verified against Xcode 26_ below records for iOS.

Disk is **~2.4 GB** in `~/.android/avd`, essentially all of it
`userdata-qemu.img.qcow2`, and it is worth knowing the shape of that number: it
reads 1.0 GB the moment boot completes and settles at 2.3 GB after the first
clean shutdown. Measure after a full boot/shutdown cycle or you will record less
than half the real cost. The cap is `disk.dataPartition.size` above, so it grows
toward 6 GB as the app writes and never past it (it stood at 4.2 GB on
2026-10-23, after two months of dev builds). The cold-boot settings do hold
— the shutdown log says `Snapshots have been disabled by the user, save request
is ignored`, which is the ~2 GB that is _not_ on disk.

#### ⚠ the tablet AVD

`bracemark-tablet` was made the same way, from the `pixel_tablet` profile, with
the same six edits plus four of its own:

| key                     | default → set            | why                                                                                                                            |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `hw.lcd.width`/`height` | 2560×1600 → 1920×1200    | the same 1280 × 800 dp window for 56% of the pixels: smaller frames, smaller captures                                          |
| `hw.lcd.density`        | 320 → 240                | keeps the dp; hdpi is a density neither the phone nor the simulators run, so its rounding (a 1.5× hairline) gets run somewhere |
| `hw.initialOrientation` | `portrait` → `landscape` | a tablet's natural orientation; it boots the way it is mostly held                                                             |
| `showDeviceFrame`       | `yes` → `no`             | no skin is installed for it                                                                                                    |

**Why 1280 × 800 dp.** It is the Android tablet: the Pixel Tablet and most other
10–11" tablets are sw800dp. Both orientations
clear 768, so the rails dock upright and on its side, and the side that does
NOT is reached on the same AVD: split-screen in landscape hands the app roughly
half of 1280, below 768 (not yet measured), and a freeform window narrower still. A 7" (sw600) tablet
would only re-run the phone layout upright. A foldable is a separate AVD
(`pixel_9_pro_fold`), made when the fold itself needs running.

**RAM 2 GB, 4 cores** — the phone's, so a timing measured on one carries to the
other. Measured on the home screen 30 s after a cold boot: 830 MB available in
the guest, the host process at ~4 GB RSS. Cold boot 32 s the first time, 15 s
after. Disk **2.0 GB** after a full boot/shutdown cycle, read the way the phone's
is read above.

**⚠ Boot only the device a leg runs on — it is memory, not the foreground.**
This Mac has 16 GB, and the four e2e devices booted together (both AVDs, the
iPhone and the iPad simulators) beside `npm run dev`, Metro and a browser put it
8.2 GB into a 9.2 GB swap file. The emulators' own CPU read 8–11%: their guests
were paged out, and every Maestro step waited on swap. Measured 2026-10-23: the
Pixel took 9m31s for `SEARCH-002` and 5m51s for `FILTER-001`, where the tablet
AVD running alone took about 3m for each. With the three idle devices shut down
mid-run, swap fell to 4.0 GB and the Pixel's next case, `VIEWPORT-KEYBOARD-001`,
ran in the 53s the tablet AVD takes alone. Nothing fails while a device is
swapped out. Steps slow until a fixed wait — a 10s `extendedWaitUntil` — runs
out under one, and that red reads as a flake. Shut the others down between legs
(`xcrun simctl shutdown <udid>`, `adb -s <serial> emu kill`). Whether a window
in the background costs anything on top, once memory is free, was not measured.

**⚠ It boots with no software keyboard.** `hw.keyboard = yes` (the phone table,
for Maestro's `inputText`) reads as a physical keyboard, and on the tablet,
unlike the phone, Gboard then hides itself: a focused field shows a caret and no
keys, `mInputShown=false`, and nothing fails — the same trap as the iOS
Simulator's hardware keyboard (_the software keyboard_, below). The fix is
Android's _Show on-screen keyboard while a physical keyboard is active_, set once
on the device:

```sh
adb -s <serial> shell settings put secure show_ime_with_hard_keyboard 1
```

It lives in userdata, so it survives cold boots and is lost to `-wipe-data` or
re-creating the AVD. Check with `settings get secure show_ime_with_hard_keyboard`
(should read `1`).

**It is the `wide` device of every Android e2e run** — `e2e:android:tablet`,
`e2e:visual:android:tablet` ([e2e.md](./e2e.md), _narrow and wide_). With both
AVDs up the runner tells them apart by width, so neither needs a `--device`; a
bare `adb` call still needs `-s <serial>` (`adb devices`), and
`npm run expo:android:reverse` needs `ANDROID_SERIAL=<serial>` in front, once
per AVD. The store screenshots are a different leg and stay on the Pixel 8:
`e2e/shot/mobile.ts` accepts only its 1080×2400 ([e2e.md](./e2e.md), _the
published screenshots_).

#### ⚠ the iPad simulator

The `wide` iOS device is an **iPad (A16)** simulator — 820 × 1180 pt upright,
docked rails both ways, and the model `e2e:ios:ipad` expects
([e2e.md](./e2e.md), _narrow and wide_). Not the iPad mini, which is narrow
upright. It needs the iPhone's keyboard settings (_the software keyboard_,
below) and one of its own:

**⚠ AutoFill Passwords goes off, or no wide iOS flow gets past sign-in.** On a
successful sign-in iOS offers to save the password. On the iPhone that sheet is
in Maestro's tree, and `subflows/sign-in.yaml` presses its Not Now. On the iPad
it is a centred card that **nothing in the tree shows**: the hierarchy holds the
status bar and nothing else, neither the card nor the app beneath it, so the
subflow's `tapOn: Not Now` reports WARNED on every pass. The run then fails as
`links-screen is visible` after five minutes, with the links screen signed in and
painted under the card in every screenshot. Measured on iOS 26.5, 2026-10-23. A
point tap cannot stand in for the missing node: the card is centred on the
screen, so its place follows the orientation, and on the passes where no card
is up the same point lands on the link list. So the setting goes off once, on the device:

_Settings → General → AutoFill & Passwords → AutoFill Passwords and Passkeys_

It lives in the device's data, so it survives reboots and is lost to an erase.
**The runner does not check it, and there is nothing it could read.** The
device's `com.apple.WebUI` `AutoFillPasswords` follows the toggle, but it is a
mirror: a `defaults write` of `true` landed in the plist, and Settings, relaunched,
still showed the toggle off. A preflight reading it could pass a device with
AutoFill on. The symptom above is the check.
The iPhone keeps its default, so the AutoFill path `sign-in.yaml` handles still
runs on every phone leg.

#### ⚠ the software keyboard

**Both platforms run with the on-screen keyboard up**, by hand and in e2e,
because a phone always has one and every bug in
[soft-keyboard.md](./soft-keyboard.md) is invisible without it. The flows are
written against it: `flows/add-link.yaml` leaves out `hideKeyboard` because the
panel rides the keyboard, so Save is on screen.

Android gets it with no setting. `hw.keyboard = yes` (the table above) is
what lets Maestro's `inputText` type, and the IME still appears on focus.

iOS gets it from a **Simulator.app** setting, not a device one: _I/O → Keyboard →
Connect Hardware Keyboard_ (⇧⌘K), stored as the single global key
`ConnectHardwareKeyboard` in `com.apple.iphonesimulator`. When it is on or unset,
a focused field shows a caret and **no keyboard at all**, and nothing fails. Maestro's
`inputText` types either way, so a run stays green on a screen no iPhone has.
`e2e/runner/native-run.ts` refuses an iOS run unless the key reads `0`. Simulator
reads the key only at launch, so after changing it, restart Simulator and
re-boot the device. The steps are in `.claude/skills/verify/SKILL.md`,
_Gotchas_.

**…and the device has its own memory of a hardware keyboard, which the Simulator
key does not reach.** The simulated iPhone keeps `HardwareKeyboardLastSeen` in
its `com.apple.keyboard.preferences`, and while that reads true iOS minimizes the
software keyboard to nothing — a caret and an edit menu, no keys — with
`ConnectHardwareKeyboard` correctly `0`. Measured on iOS 26.5, on a device whose
flag something outside any run had set (Maestro's own typing does not set it).
The runner refuses such a device too, and the fix is on the device:

```sh
xcrun simctl spawn <udid> defaults write com.apple.keyboard.preferences HardwareKeyboardLastSeen -bool false
xcrun simctl shutdown <udid> && xcrun simctl boot <udid>
```

Reboot rather than restart SpringBoard (`launchctl stop com.apple.SpringBoard`
also brings the keys back): after that restart the simulator's SpringBoard
crashed three times in the next few hours of runs — a null dereference, with
SafariViewService going down in the same second — each time sending the app to
the Home screen between a flow and the runner's next hierarchy read, where it
failed as a missing `links-list` or a missing keyboard. None after a reboot.

**…and both of those can read correctly on a device that still shows no keys.**
Measured on iOS 26.5 with `ConnectHardwareKeyboard` `0`, `HardwareKeyboardLastSeen`
`0`, Simulator restarted and the device rebooted: the keyboard appeared for the
first focus or two after boot and then never again — a caret and no keys — so the
runner's preflight passed and `VIEWPORT-KEYBOARD-001` failed at its first measure
with _no soft keyboard is up_. The device's log names it
(`xcrun simctl spawn <udid> log show --last 3m --predicate 'eventMessage CONTAINS
"syncMinimizedStateToHardwareKeyboardAttachedState"'`): UIKit logs `Setting
keyboard minimized = 1`, beside a `BKSHIDKeyboardDevice` connecting — the
simulator's own virtual keyboard, attached whatever the two keys say. What attaches
it was not established. What ended it is the device preference that makes iOS
minimize for a hardware keyboard at all:

```sh
xcrun simctl spawn <udid> defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false
```

It takes effect at the app's next launch, no reboot, and the case went green on
the next run. The runner does not check it: the key reads `1` on a device where
the keyboard works, so only the symptom tells you.

**A real iPhone is possible and is the highest-friction path.** It needs a dev
build signed with a profile carrying the device UDID, and WebDriverAgent
installed on the phone for tap and query — which needs its own signing.
Screenshots come through WDA, not simctl. Reserve it for what a simulator cannot
do honestly: the real iOS share sheet from another app, StoreKit sandbox, push,
real performance. See [share-sheet.md](./share-sheet.md) and
[expo-build.md](./expo-build.md). What such a device can reach once it is
running — and which apps work on which of the five devices — is
[device-testing.md](./device-testing.md).

#### ⚠ `adb shell` has no argv

**Everything after `shell` is joined with spaces and re-split by the device's
shell.** `adb` does not forward an argument vector; it concatenates one into a
command string, ships that, and the shell on the other end splits it again on
whitespace. So `execFile('adb', ['shell', 'am', 'start', …, '--es',
'android.intent.extra.SUBJECT', 'Job interview'])` — argv-safe by construction on
this side, and wrong on arrival — hands `ShareActivity` a `SUBJECT` of `Job`,
with `interview` left over as a positional `am` swallows as the intent's package.

Nothing reports it. `am` prints `Starting: Intent { … }` and exits 0, the flow
that follows passes, and the only evidence is the payload itself: the
`save-from-any-app` store capture photographed a page titled **"Job"** across
three runs, which reads as the sheet clipping its own title — a bug in the app —
rather than as the harness having handed it a shorter one. What settles it in
one command is the echoed intent, which names the damage directly:

```sh
adb shell am start … --es android.intent.extra.SUBJECT 'Job interview'
# Starting: Intent { act=… pkg=interview cmp=… (has extras) }
#                       ^^^^^^^^^^^^^^ the second word, parsed as -p
```

**Quote every word on this side** — the remote shell has no argv to preserve, so
there is nowhere else to fix it. `e2e/shot/mobile.ts`'s `adbShell` helper
single-quotes each word and passes the result as one argument; route new `adb
shell` calls through it rather than through `command('adb', ['shell', …])`.
Maestro's own steps are unaffected: it speaks to the device over its driver, not
through a shell.

#### ⚠ `input swipe` can arrive as a tap

**`adb shell input swipe` is not a sequence of events; it is a clock.** The
command (`InputShellCommand.sendSwipe`) injects the DOWN and waits for the app to
_finish_ handling it (`INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH`), then injects
moves only while `now < down + duration`, then the UP at the end point. So if the
app takes longer than the duration to finish the touch-down, the loop never runs
and the whole gesture is a DOWN on one row and an UP far above it. If it takes
nearly that long, one move sneaks in near the end.

Over a list that is a tap, and it opens the row under the finger. No view saw a
move, so the native ScrollView never took the gesture (it intercepts on a move
past touch slop) and never cancelled the JS responder. React Native's
`Pressable` checks its press rect only on moves, not on release, so it fires
`onPress` on the lift. This is the "drag on the search results opens the link"
that kept `VIEWPORT-KEYBOARD-001` intermittently red on Android. It is not an app
bug, because a finger cannot produce it. A touchscreen keeps sampling while the
app is busy, and Android hands a slow app its batched moves before the UP, so
the ScrollView still gets the move it needs to take the gesture.

Measured on the AVD's dev build. The stall shows up right after Maestro has run
(an `inputText`, then a `maestro hierarchy` read, which is the runner's own
order). Driven by `adb` alone, 0 of 40 drags pressed a row. Failing runs had the
300 ms swipe command take 650–840 ms against ~400 ms normally, and JS logged
`touchStart` then `touchEnd` at the swipe's end point with no move between them.
`input motionevent DOWN`, then `UP` 520 px higher with nothing in between,
opened the row 3 of 3 times with the search box focused. In the state where the
stall was most frequent, `input swipe … 300` opened the row in 6 of 12 runs,
`… 1500` in 0 of 4, and the same drag as explicit events in 0 of 8.

**Drag with one `input motionevent` per step** (`DOWN`, several `MOVE`s, `UP`),
each its own injection, so a slow app only slows the drag down and cannot drop
its moves: `androidDrag` in `e2e/runner/mobile.ts`. A longer `input swipe`
duration only moves the threshold. Maestro's own `swipe` is no escape either: it
opened the link twice inside the case before the runner took the drag over. Its
mechanism was not traced, but the symptom is the same.

#### ⚠ an `am start` can decline to start anything

**A second `am start` naming an activity that already has a task does not launch
it — it surfaces the old one, with the old intent.** Extras are not part of
`Intent.filterEquals`, so the new payload is simply dropped, and the shell says
so in a line that is easy to read as success: `Starting: Intent { … }`, then
`Warning: Activity not started, its current task has been brought to the front`,
exit 0.

It bites the Android share capture specifically, because `ShareActivity` declares
`taskAffinity=""` ([share-sheet.md](./share-sheet.md)) and so lands in a task of
its own that outlives the sheet. The second run of `npm run shot:mobile --
android` then either photographs the FIRST run's payload as the second's, or —
what actually happened — never brings the sheet forward at all and times out on
`share-add` with a screenshot of plain Chrome. **`--activity-clear-task` is the
fix** (`e2e/shot/mobile.ts`, `openShareSource`). Note there is no
`--activity-new-task` to pair it with; `am help` lists the options, and the
system supplies `NEW_TASK` itself for an activity launched from a shell, which is
what CLEAR_TASK rides on.

#### ⚠ `pressKey` photographs a focus state no user has

**A hardware key event takes Android out of TOUCH MODE, and the platform then
draws focus highlights the product never shows.** Anything that moves focus after
that point paints one: `pressKey: Enter` on a single-line field blurs it
(`blurAndSubmit`), focus lands on the next focusable view, and Android fills that
view's bounds with its default highlight.

It is easy to read as an app bug and is not one. On the links topbar the drawer
button came out as a **92px square of #ECECEC** — neither a colour this kit uses
(`--muted` is #F5F5F5) nor a shape it can draw, since every button is
`rounded-4xl` and the sibling search button in the same capture is a clean circle
(`ui/button.tsx`). Nobody can reach that pixel by hand: the soft keyboard's own
Search key is a **touch**, and touch mode suppresses the highlight.

**Any touch clears it**, which is both the diagnosis and the fix — measured by
sampling the pixel through the sequence: white, white after `input text`, #ECECEC
the instant `keyevent 66` lands, white again after one `input tap` anywhere.
`e2e/mobile/shots/store.yaml` taps the topbar title — the one element on that bar
with no press handler — between the Enter and the shutter. Worth checking in any
capture that ends on a `pressKey`, since nothing else reports it: the flow is
green, the pixels are wrong, and the result ships to a store listing.

**It also hides the keyboard, whatever the field asked for.** React Native's
Android `ReactEditText.onKeyUp` calls `hideSoftKeyboard()` for a hardware
`KEYCODE_ENTER` on any single-line field, before `submitBehavior` is consulted —
so `adb shell input keyevent 66` and `pressKey: Enter` both put the keyboard away
on a field that sets `submitBehavior="submit"` precisely to keep it. Measured on
sign-in's username, which hands Return on to the password
(`lib/input-keyboard.ts`): the focus moved correctly and `mImeShowing` read
`false` for as long as it was polled, which is a failing result for a feature that
works. The soft keyboard's own action key is a different code path
(`onEditorAction`) and is the one a person presses, so **a "Return keeps the
keyboard" check has to tap that key** — by coordinate, read off a screenshot,
since the IME's keys are not in `uiautomator`'s dump of the app window. With that
tap the same field read `mImeShowing=true` with the password focused. iOS has no
such split: Maestro's `pressKey: Enter` types the return key there.

Two readings that made those checks possible with `adb` alone, no screenshot:
`dumpsys window | grep mImeShowing` for whether the keyboard is up, and the first
`inputType=0x… imeOptions=0x…` in `dumpsys input_method` for what the focused
field told it — the low nibble of `imeOptions` is the action (`2` go, `3` search,
`5` next, `6` done). The second one only refreshes when input RESTARTS, so a
`returnKeyType` changed under a field that keeps its focus shows the old label
until the next focus; refocus before reading it.

#### ⚠ a text match can resolve to a node under the drawer

**Android's hierarchy contains views an overlay covers, so a `tapOn` by text can
pick an element nobody can see — and the tap then lands on whatever is drawn over
it.** Nothing reports this. The step passes, the touch is delivered, and the
screen simply does not change.

The specimen is the drawer in `e2e/mobile/shots/store.yaml`. A React Navigation
drawer is an overlay: the links screen stays mounted and stays in the dump
behind it. The links topbar's title is the current selection's NAME
(`links/topbar.tsx`, `useSelectionLabel`), so opening the drawer on My List puts
**two** "My List" nodes in the tree — the occluded title at `[136,167][838,241]`
and the drawer row at `[200,537][892,590]`. Maestro takes the first in tree
order, which is the title's, and the drawer panel is 933px wide on this AVD, so
the title's centre is under it. The touch went to the drawer, nothing navigated,
and the drawer stayed open — which read as "Android keeps the drawer open when
the destination is already selected" and was written into the flow as a
platform-conditional scrim tap at `96%,50%` for months. It is not an app
behaviour and not a Maestro bug: a finger on that row closes the drawer, and so
does `index: 1` on the same text.

**Bind to a `testID` when an overlay is open** ([e2e.md](./e2e.md), _the testID
contract_) — `links-nav-list-<id>` on the drawer rows, added for exactly this.
Two cheaper-looking fixes are both wrong. `index: 1` encodes the collision rather
than avoiding it: the second match exists only because the title already names
the destination, so it breaks in every other starting state — and these flows
start warm, on whatever view the device last held. A coordinate tap on the scrim
is worse: `96%,50%` is pinned to this AVD's drawer width and would land INSIDE
the drawer on a tablet, silently, in the one kind of run whose output ships to a
store listing.

The general shape, since the drawer is only where it was caught: **any text
selector evaluated while a drawer, sheet, dialog or menu is open can match the
surface underneath.** The tell is a step that passes and changes nothing. Dump
the tree and count the matches — `maestro hierarchy` filtered on the string
answers it in one command, and a second dump after the tap says whether anything
moved.

#### ⚠ a document-picker label is not the file's click target

**Both system document pickers expose the staged filename, accept a Maestro text
tap, report `COMPLETED`, and stay open.** The visible label is not the surface
that selects the file. On iOS 26.5, even the Files tile's resource-id tap has the
same silent result; on Android 36.1, the filename is a non-clickable `TextView`
inside the clickable DocumentsUI card.

`e2e/mobile/flows/import-data.yaml` therefore proves the unique staged filename
is visible first, then taps the only tile: a percentage coordinate over the
first Files grid tile on iOS, and DocumentsUI's clickable `item_root` on Android.
The coordinate is justified only by that one-file fixture contract — using it
against an arbitrary picker would select an unproved file. Android also navigates
from **Recent** to **Downloads** explicitly: `adb push` puts the bytes there but
does not make the current runtime index the archive into Recent.

This is the same failure shape as the share-sheet handoff below: the driver sees
the system surface, a selector resolves, and the gesture reports success without
the operating system performing the action. A receipt inside Bracemark is the
proof that the picker handoff actually occurred.

#### the driver: Maestro, not Appium

> The flows themselves live in `e2e/mobile/`; [e2e.md](./e2e.md) covers the
> `testID` contract they bind to, the `adb reverse` the Android emulator needs,
> and how a flow gets an account.

The choice is **Maestro** — one YAML flow across the iOS simulator, the Android
emulator and a real device, and `maestro hierarchy` dumps the view tree as text
in a single command, which is what makes a flow agent-drivable. It is installed
at `~/.maestro/bin` and **verified working on this machine's Xcode 26**; see
_verified against Xcode 26_ below, which matters more than it sounds like.

Its `PATH` entry lives in **`.zshenv`, not `.zshrc`** — moved there from where
the installer put it. `.zshrc` is interactive-only, so a script, an npm script,
or any tool that shells out gets `NOT FOUND`; `.zshenv` loads for every zsh.
This is the same reason `nvm`, `JAVA_HOME` and the Android SDK paths already
live there, and Maestro needs the latter two anyway.

The reasoning, because this is the kind of decision that gets re-litigated:

- **There is no CI.** Appium's cost is standing infrastructure — a server
  process, two drivers, a WebDriverAgent build, capabilities, session
  lifecycle. That amortizes across a suite run hundreds of times in CI. It does
  not amortize across "I changed the links list, show me it still works," which
  is what driving is actually for here.
- **No session to hold.** `maestro hierarchy` needs no server and no session, so
  an agent mid-task has less state to manage and less to go wrong.
- **The TypeScript argument for Appium is weaker than it looks.** Appium tests
  would be TS and could be a real Nx project with its own target — but that only
  pays if these belong in `npm run test`, and per _driving bracemark-web_ above
  they deliberately don't.

Detox is the stronger CI choice of all three but needs a gray-box dev build and
is much heavier to iterate on.

**Where Appium would genuinely win — and why it still doesn't.** Two flows in
this app play to XCUITest's strengths, and Appium wraps XCUITest:

1. **The iOS share extension.** Driving it honestly means starting in Safari,
   tapping Share, and having a separate process's sheet appear. That is a
   cross-process system-UI flow; Maestro is weak at it.
2. **Biometric unlock** ([locks.md](./locks.md), _biometric unlock
   (expo-only)_). Appium's XCUITest driver has `mobile: enrollBiometric` /
   `mobile: sendBiometricMatch` on the simulator. Maestro has no biometric
   command — and, measured, neither does anything else reachable here.
   `agent-device` advertises `settings faceid <match|nonmatch|enroll|unenroll>`
   and refuses it on this runtime (`UNSUPPORTED_OPERATION: Face ID simulation is
not supported on this simulator runtime`); `xcrun simctl ui` offers only
   `appearance`, `increase_contrast` and `content_size`, with no biometric
   option at all; and `notifyutil` — the historic injection path — is not in the
   iOS 26.5 runtime. Whether Appium's private-API route still reaches it on 26.5
   was **not** established (only 26.5 is installed here, and reading
   Simulator.app's Features menu needs an accessibility grant this machine has
   not given). So the lever Appium is credited with may no longer exist. Do not
   re-open this on the strength of a feature list; the simulator match was
   synthetic anyway, and the real check is a manual pass on a real phone.

Both are also where **the simulator is least representative and neither tool
earns its cost.** The share extension's real risk surface is logic — the
idempotent draft, the drain that never destroys what it couldn't read, the
immediate upload — all of it already reachable from jest, and already covered by
`share-screen.spec.tsx`, `share-url.spec.ts` and `share-theme.spec.ts`. What a
device driver adds on top is one thin assertion ("the sheet appeared when I hit
Share in Safari") that changes rarely and is a 30-second manual check. Simulator
Face ID is a synthetic match, so a green biometric test proves the wiring is
connected, not that it works on a real phone — which is a manual pass on the
actual device either way.

So: **Maestro for the main-app flows on both platforms, jest for the share and
lock logic, hands for the cross-process share invocation and biometrics.**
Adopting Appium's apparatus for two flows it would still be flaky at is the
trade to avoid.

#### verified against Xcode 26

Worth recording because **the GitHub issue tracker is misleading here.** Maestro
has a long trail of iOS 26 / Xcode 26 breakage — driver never listening on port
7001, `list-devices` returning nothing, `maestro test` hanging after the system
banner, and one report (#3318) whose configuration is _exactly_ ours: Maestro
2.6.0, iPhone 17 Pro, iOS 26.5. Most are closed as "waiting for customer
response", which is closed-for-inactivity, not fixed. Reading either the issue
list or its silence as a verdict gets you the wrong answer in both directions.

Measured directly on **Maestro 2.8.0 / Xcode 26.6 / iOS 26.5 / iPhone 17 Pro**,
all of it working:

| check                                   | result                                        |
| --------------------------------------- | --------------------------------------------- |
| `maestro list-devices`                  | sees the iOS 26.5 sims (#2894's symptom gone) |
| `maestro hierarchy`                     | 126 KB of real a11y tree, exit 0              |
| single flow — launch, assert, tap, shot | every step COMPLETED                          |
| 3-flow directory batch                  | driver survived; **#3318 did not reproduce**  |

So the scenario that would have flipped this decision to Appium did not
materialise. Re-measure rather than re-read the tracker if this is ever in doubt
again — the versions in those issues (2.0.10 through 2.6.0) all predate 2.8.0.

One real gotcha found while testing, unrelated to Xcode: **`launchApp` resumes
an app, it does not cold-start it.** A flow that assumes it begins at a root
screen passes alone and fails in a directory run, because the previous flow left
the app deep in a navigation stack. The failure looks exactly like the batch-mode
driver bug and is not one. Write flows to be state-independent, or reset with
`clearState`.

#### measured: the cross-app share flow

The caveat that used to sit here — that "Maestro is weak at iOS cross-app flows"
came from its design rather than from a run against our own share extension —
has been spent. Driving Safari → Share → Bracemark against a dev build, same
Maestro 2.8.0 / Xcode 26.6 / iOS 26.5 / iPhone 17 Pro:

| check                                           | result                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `maestro hierarchy` sees the system share sheet | yes — the target is `accessibilityText: "Bracemark"`, **not** `text`         |
| … sees inside the extension's own process       | yes — `assertVisible` on `Close` and `Sign in to save links`, both COMPLETED |
| `tapOn` the Bracemark target in the sheet       | **COMPLETED, and the extension never launches**                              |
| a coordinate tap on that same element           | launches it — `BracemarkShareExtension … launched.`                          |

So the assumption above is backwards: Maestro **reads** across both process
boundaries perfectly well, and fails only at the one gesture that crosses them —
silently, reporting success. That is tripwire-shaped, so the rule, the specimen
and the workaround live in [share-sheet.md](./share-sheet.md), _driving it from
Safari_, not here. Note the first row too: a selector written against `text:`
finds nothing in that sheet, which reads as "Maestro can't see it" and is really
"you asked for the wrong attribute."

#### the agent-facing drivers — measured, not adopted

A second family arrived after this decision was made: tools whose product is not
a suite but an **agent's access** to a device — `mobile-next/mobile-mcp`
(Apache-2.0), `callstack/agent-device` (MIT), and Maestro's own `maestro mcp`.
They do not compete with the choice above and do not replace `e2e/mobile/`;
agent-device says as much itself, and offers to export its runs _as_ Maestro
YAML.

**The token argument runs the wrong way.** An MCP server's tool schemas are
resident in every request of every session — including the overwhelming majority
that never touch a device. Measured over stdio `tools/list`, bytes ÷ 4 as a token
estimate:

| server             | tools | schema bytes | ≈ tokens, every request |
| ------------------ | ----: | -----------: | ----------------------: |
| `agent-device mcp` |    57 |      216,406 |                 ~54,000 |
| `mobile-mcp`       |    32 |       27,369 |                  ~6,800 |
| `maestro mcp`      |    10 |        9,957 |                  ~2,500 |

Against that, the cost of reading one screen (bracemark-expo's welcome screen):

| reader                        |  bytes |
| ----------------------------- | -----: |
| `agent-device snapshot` (CLI) |    535 |
| `maestro mcp inspect_screen`  |  2,314 |
| `maestro hierarchy` (raw)     | 34,081 |

agent-device's CLI snapshot is the best read of the three by a wide margin — six
named, `@ref`-annotated nodes where `maestro hierarchy` emits 34 KB of nested
bounds, and `press --settle` prints only the resulting UI diff. But that saving
is **per read** and the schema is **per request**: routed through its MCP it
spends ~54k tokens to save ~33 KB a screen. **If any of these is used here it is
`agent-device` as a CLI, and no MCP is registered.**

Two limits found while measuring matter more than the byte counts:

- **It cannot see the iOS share sheet, or the extension behind it.** Bound to the
  session app, it reports Safari's own nodes as `[covered]` and nothing else —
  `snapshot --raw` included. Maestro reads both. →
  [share-sheet.md](./share-sheet.md)
- **It cannot replay this repo's flows.** Its Maestro-compatibility engine
  documents `repeat.while` as unsupported, and
  `e2e/mobile/flows/subflows/sign-in.yaml` uses it — the subflow nearly
  everything else runs through.

`maestro mcp` is the cheapest and needs nothing new installed (it ships in the
CLI already on PATH), but it prefixes **every** tool result with a fixed
instruction to surface its viewer URL to the user.

Remember that `apps/bracemark-expo/ios/` and `android/` are generated and
gitignored — nothing a test setup needs may be hand-edited there.
→ [expo-build.md](./expo-build.md)
