---
name: verify
description: How to build, launch, and drive this repo's apps to verify a change end-to-end — bracemark-web via headless Chromium, bracemark-expo on the iOS simulator or Android emulator.
---

# Verifying changes in this repo

## Launch

- `npm run dev` (background) starts bracemark-web on :3000, bracemark-api (wrangler,
  local D1/R2 emulation) on :8787, and bracemark-extractor. Wait for
  `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200 (~15s).
- Local state lives under `apps/bracemark-api/.wrangler/`; creating a throwaway
  account per run is cheap and avoids depending on existing state.

## Drive bracemark-web (GUI surface)

- **`playwright-core` is a root devDependency** — no per-session install, no scratch
  dir needed. It ships no browser, so drive the system Chrome via `executablePath`;
  **don't count on the `~/Library/Caches/ms-playwright/` browser cache**, which has
  been empty (nothing in the repo populates it).

  ```js
  import { chromium } from 'playwright-core';
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  ```

  Headless is the default, and `deviceScaleFactor: 2` on the context makes
  screenshots legible at this repo's type sizes. Pass `headless: false` (plus
  `slowMo: 250`) to watch a run live. `/Applications/Chromium.app/Contents/MacOS/Chromium`
  works the same way if Chrome is gone.

- Why this and not a browser test target, when to reach for claude-in-chrome
  instead, and how the native apps get driven: `docs/testing.md`.

- Flows that worked headless: create account at `/create-account`
  (Username/Password labels, button /create/i — Argon2 makes this take a few
  seconds; wait for URL /links/), add links via the topbar `Add` popover
  (label `URL`, button `Save`), manage lists at `/settings/lists` (create field
  label `New list name`, Enter commits; rows are inputs — match
  `input[aria-label="List name"][value="<name>"]`, per-row kebab label
  `List actions`), sidebar rows are buttons named by list name.
- `playwright-core` has no Testing Library helpers (`getByDisplayValue` doesn't
  exist) — use attribute selectors for the uncontrolled inputs.
- Layouts render a link's title, falling back to the URL with a leading
  `https://` stripped (host + path, via `displayUrl`) when there's no title;
  the host also shows on a secondary line/column. So untitled links ARE
  distinguishable by path — asserting on distinct paths (or distinct hosts)
  both work.

## Gotchas

- Nx TUI is disabled on purpose (breaks wrangler dev under run-many) — keep
  `--output-style=stream` output; don't re-enable.
- Sign-out now leaves the app for the marketing site's landing page
  (`NEXT_PUBLIC_SITE_URL`, so `localhost:3001` in dev) — a cross-origin
  `location.replace`, not a route change, so don't wait for a bracemark-web URL
  after it and expect the site dev server to be up. Sign-in is `/sign-in`. After
  sign-in, give the initial sync ~2s before asserting on content.
- Creating an account headless: fill `#username`, press "Choose my own" (the
  generated-password step gates Continue behind a saved-it checkbox), fill
  `#signup-new-password`, Continue, fill `#confirm`, Continue, then "Create account without
  a recovery code" on the recovery step (the primary there is disabled until the
  saved-it checkbox is ticked). Argon2 makes the submit take a few seconds.

## Drive bracemark-expo (native surface)

**Check whether you need this first.** Unlike the web surface — where
`npm run dev` is 15 s and driving is nearly free — every path here starts with a
**multi-minute native build that holds the foreground running Metro**, plus a
~32 s cold emulator boot. Most changes are answered cheaper by jest
(`npx nx test @stxapps/bracemark-expo`) or by the web surface above. Reach for a
device when the change is native, visual, or layout/safe-area shaped, i.e. when
you need to _look_ at it.

For **suite** runs (`npm run e2e:mobile`, `npm run e2e:contract`) stop here and
read `e2e/README.md` — this section is the ad-hoc "show me my change" loop.

- **The prerequisite is an installed dev build**, and nothing installs it for
  you: `npm run expo:android` or `npm run expo:ios` (from the root; both hold the
  foreground, so background them or use a second terminal). App id is
  `com.bracemark.app`. Both native dirs are prebuilt already — only re-run
  `npm run prebuild` after an `app.config.ts`/plugin/native-dep change.
- **Android additionally needs `npm run expo:android:reverse`** once per emulator boot,
  before anything hits the api — it is `adb reverse` for 8081 (Metro), 8787 (api)
  and 8788 (extractor). It is deliberately NOT chained onto `expo:android` (that
  script never returns), it is idempotent and instant, and it survives reinstalls
  but not a device reboot. Re-run it whenever unsure.
- **Launch with `npm run expo:ios:open` / `expo:android:open`, not the app icon**
  (both platforms — same code path, not an Android quirk). The dev build only
  opens straight into the app while expo-dev-client's own prefs survive; anything
  that clears app data (a Maestro `clearState`, so any `npm run e2e:mobile`, or a
  remembered-bundle entry older than 3 days) leaves it showing the dev-launcher
  home screen — "enter the dev server URL" — and then the dev-menu sheet on top
  of the loaded bundle, both of which have to be dismissed by hand before the app
  can be driven. Those two scripts are the dev-client deep link with the bundle
  URL and `disableOnboarding=1` in it, so neither screen appears. Maestro flows
  get the same treatment via `e2e/mobile/flows/subflows/cold-launch.yaml` →
  `docs/e2e.md`.

### Android is the cheap path — `adb` alone is a complete loop

No driver, no session, nothing to install. `adb`/`emulator` are on PATH via
`.zshenv`, with `ANDROID_HOME=~/Library/Android/sdk`.

```sh
$ANDROID_HOME/emulator/emulator -avd bracemark-pixel8 -no-audio -no-boot-anim &
adb wait-for-device                          # ~32 s cold; the only AVD, a Pixel 8
adb exec-out screencap -p > shot.png         # capture
adb shell uiautomator dump                   # query → /sdcard/window_dump.xml
adb shell cat /sdcard/window_dump.xml        # the real view tree, as XML
adb shell input tap <x> <y>                  # drive: also text / keyevent / swipe
```

### iOS: `simctl` is lifecycle only — `maestro` is the only way to query

`simctl` has **no tap, no type, no query**. It boots, installs, launches, opens
deep links (useful for share flows), and screenshots; anything that reads the
screen needs Maestro on top (`~/.maestro/bin`, on PATH via `.zshenv`, verified
working on this machine's Xcode 26).

```sh
xcrun simctl boot 'iPhone 17 Pro'            # `simctl list devices available`
xcrun simctl io booted screenshot shot.png
xcrun simctl openurl booted '<deep link>'
maestro hierarchy                            # the a11y tree as text, no session
```

### Gotchas

- **Boot ONE platform at a time.** `e2e/runner/lib.ts` passes Maestro no
  `--device`, so with both a simulator and an emulator up it picks
  non-deterministically or hangs on an interactive picker. Shut one down before
  booting the other.
- **`launchApp` resumes an app, it does not cold-start it.** A flow that assumes
  it begins at a root screen passes alone and fails in a directory run, because
  the previous flow left the app deep in a navigation stack. Reset with
  `clearState`. The failure looks like a driver bug and is not one.
- **Selectors are `testID`s, and they are an interface** — renaming one fails a
  flow as a bare timeout that names nothing. The list is in `docs/e2e.md`, _the
  testID contract_. Selectors otherwise bind to the a11y tree, so an unlabelled
  control is untestable as well as inaccessible (`docs/accessibility.md`).
- **Write screenshots to the scratchpad, not the repo** — nothing gitignores a
  stray `shot.png` at the root.
- `apps/bracemark-expo/ios/` and `android/` are generated and gitignored — never
  hand-edit them to make a run work. → `docs/expo-build.md`
- Why Maestro and not Appium/Detox, what a real device buys, and the AVD's
  config: `docs/testing.md`, _driving the native apps_.
