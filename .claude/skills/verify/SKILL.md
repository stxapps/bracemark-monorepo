---
name: verify
description: How to build, launch, and drive this repo's apps to verify a change end-to-end — bracemark-web via headless Chromium, bracemark-extension as an unpacked build, bracemark-expo on the iOS simulator or Android emulator. Also which Chrome to drive for which app. Use when the change has to be SEEN running; when a test, typecheck, or a read of the code can settle the question, do that instead.
---

# Verifying changes in this repo

## Pick the cheapest instrument that can answer the question

Driving an app is the most expensive way to learn anything in this repo — not
because of this file, but because of what the loop spends: a screenshot costs
roughly a page of prose, a hierarchy dump several pages, and every tool call
round-trips the whole transcript. Ordered by cost, use the first one that
actually settles the question:

1. **Read the code** — for "is this wired up", "does this branch run".
2. **`npx nx test <project>` / `npx nx typecheck <project>`** — for logic,
   reducers, query builders, anything with an expected value.
3. **A DOM/text assertion in a headless script** (`textContent`,
   `getAttribute`, `count()`) — for "did the right thing render". Costs
   ~nothing next to an image.
4. **A screenshot** — only when the question is genuinely visual: spacing,
   contrast, overflow, safe-area, "does this look right".
5. **A native device** — only when the change is native, or visual on a
   surface web can't show (see the expo section's own gate).

**Then keep the loop tight:**

- **Assert in the script; print a verdict, not the state.** Have the script
  compute the answer and print `PASS`/`FAIL` plus the one number that decided
  it. Reading a tree or an image to judge it by eye costs orders of magnitude
  more than the script printing `scrollWidth 412 > 390 FAIL`. The pixel-read
  recipe in the expo Gotchas is the model: one integer, not a picture.
- **One script per run, not a tool call per step.** Launch, act, assert and
  print in a single node script — each extra round-trip re-sends everything.
- **Reuse what's already up.** `npm run dev` in the background and one browser
  launch serve every check in a session; restarting them buys nothing.
- **Crop, don't shrink.** `locator.screenshot()` or `screenshot({ clip })` is
  the big saving. Lowering `deviceScaleFactor` is not — a full-page shot gets
  downsampled to a fixed budget anyway, so you pay full price and then read the
  detail you wanted at half resolution.
- **Never dump a whole hierarchy into the transcript** — grep it for the node
  you're asking about (both dump commands below show the spelling).

## Launch

- `npm run dev` (background) starts bracemark-web on :3000, bracemark-api (wrangler,
  local D1/R2 emulation) on :8787, and bracemark-extractor. Wait for
  `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200 (~15s).
- Local state lives under `apps/bracemark-api/.wrangler/`; creating a throwaway
  account per run is cheap and avoids depending on existing state.

## Drive bracemark-web (GUI surface)

- **`playwright-core` is a root devDependency** — no per-session install, no scratch
  dir needed. It ships no browser, so drive the system Chrome via `executablePath`:

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

- **WHICH CHROME: system Chrome for everything except the browser extension.**
  System Chrome **will not load an unpacked extension** — measured on Chrome 151
  with the correct arg pair, and it stays unloaded with
  `--disable-features=DisableLoadExtensionCommandLineSwitch` and with
  `--enable-unsafe-extension-debugging` too. It doesn't error: the launch
  succeeds, `chrome://extensions` lists nothing, and no service worker ever
  appears, so it reads as a manifest problem. Playwright's own Chromium loads the
  same directory first try. So: system Chrome for bracemark-web and
  bracemark-site, Playwright's bundled Chromium **only** for
  bracemark-extension — see its section below, which carries the install caveat.

- **Narrow layouts: set the context viewport, don't size the window.**
  `newPage({ viewport: { width: 390, height: 844 } })` lays out at a true 390 —
  verified here: `innerWidth` 390, `documentElement.clientWidth` 390,
  `(max-width:400px)` matches. Chrome's own `--headless --window-size=390,H`
  does **not**: the layout viewport floors at **500px**, so the page lays out at
  500 and the PNG is merely cropped to 390. That reads exactly like a
  horizontal-overflow bug that isn't there. If you ever need that CLI path,
  measure through an iframe instead (iframes have no minimum) — compare
  `iframe.contentDocument.documentElement.scrollWidth` against the iframe width,
  and find the offending element with `el.getBoundingClientRect().right > width`.

- **To capture a state that resolves too fast to screenshot**, stretch it with
  CDP rather than racing it. A local-first read (Dexie → decrypt → render)
  resolves in tens of ms, so a skeleton can't be caught by screenshotting in a
  tight loop — every frame lands after it.

  ```js
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.goto(url); // the transient state now spans several frames
  // …screenshot burst…
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  ```

  Network throttling does nothing here — the work is CPU-bound and local, not
  fetched — and adding an artificial delay to the app to see it means shipping
  (or forgetting to remove) test-only code. Remount the component by navigating
  between views rather than reloading, so the one-time app-shell gates
  (`InitialSyncGate`'s "Decrypting your links…") don't cover the frames you want.

- Why this and not a browser test target, when to reach for claude-in-chrome
  instead, and how the native apps get driven: `docs/app-drivers.md`.

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

## Drive bracemark-extension (popup + options)

**Try the tab first.** `chrome-extension://<id>/popup.html` in an ordinary page,
with `newPage({ viewport: { width: 360, height: 700 }, deviceScaleFactor: 2 })`,
lays out and paints exactly as the real popup does and is screenshot-able.
Everything below the first two bullets is only for questions about the popup
**window** — its width, its scrollbars — which a tab cannot answer.

- **Build first; there is no dev-server path.** `npx nx build
@stxapps/bracemark-extension` → `apps/bracemark-extension/.output/chrome-mv3`,
  ~2 s and gitignored. Load it with **both** args — `--load-extension` alone
  silently loads nothing, even on Chromium:

  ```js
  import { chromium } from 'playwright'; // NOT playwright-core: needs the bundled browser
  const ext = path.resolve('apps/bracemark-extension/.output/chrome-mv3');
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false, // headed: see the scrollbar note below
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0]; // poll for it; it is the background worker
  const id = new URL(sw.url()).host; // the extension id
  ```

  **The bundled browser is not installed by default** — `npx playwright install
chromium` (~550 MB into `~/Library/Caches/ms-playwright/`) if it is absent.
  That is the one sanctioned reason to run that command here; see
  `docs/e2e.md`, _the browser this repo drives_, for why it is otherwise avoided.

- **Signed-out screens need no setup.** A fresh `userDataDir` opens on `SignIn`.
- **The popup window is NOT an attachable page.** `chrome.action.openPopup()`
  from the service worker opens it, but it never appears in `ctx.pages()` and no
  `page` event fires, so you cannot `evaluate` or screenshot it directly. Nor can
  the OS: `screencapture` fails with `could not create image from display` (no
  screen-recording permission for the terminal). Measure it from **inside**:
  append `<script src="./probe.js">` to `.output/chrome-mv3/popup.html`, have it
  `chrome.storage.local.set({...})` after a delay, and read that back with
  `sw.evaluate(() => chrome.storage.local.get(…))`. **A rebuild deletes the probe
  and rewrites the html** — re-inject after every `nx build`, or the read silently
  returns nothing.
- **Popup width is content-driven, height caps at 600.** Measured: a 360px shell
  gives a 360px popup; once the document passes 600px Chrome grows the popup to
  **375** and paints the scrollbar outside the shell. So a fixed-width popup frame
  never moves — which is why it opts out of the scrollbar gutter
  (`entrypoints/popup/Shell.tsx`, `docs/safe-area.md`).
- **Scrollbar bugs are invisible to the DOM — pixel-scan a screenshot, headed.**
  The gutter bug that motivated all of this measured _perfectly_: `innerWidth`
  360, shell 360, inputs 16→344, `p-4` resolving to 16px — while everything past
  x=345 was never painted. `getBoundingClientRect` cannot see a paint clip. Shoot
  a narrow `clip` of the edge in question, then decode it in a throwaway headless
  page (`img` → `canvas` → `getImageData`) and print the last non-white x as a
  number. Headless renders zero-width scrollbars, so the _subject_ browser must be
  `headless: false` (`docs/safe-area.md`, _checking any of this_); the browser
  doing the decoding can be headless.

## Gotchas

- **Nx TUI is disabled on purpose** (`"tui": { "enabled": false }` in `nx.json`) —
  keep `--output-style=stream` output; don't re-enable. The TUI's pseudo-terminal
  stops wrangler's local proxy from ever becoming reachable under
  `nx run-many -t dev`: `localhost:8787` is dead while next on `:3000` is fine, so
  it reads as an api problem. Standalone `nx run @stxapps/bracemark-api:dev` works,
  because that task gets a plain terminal. Confirmed both ways — `NX_TUI=false`
  makes the dev servers reachable, and wrangler's own
  `--show-interactive-dev-session=false` does NOT fix it. The setting is global
  because a raw `nx run-many -t dev` would otherwise still break, and `nx.json` is
  plain JSON that can't hold a comment saying so. Unrelated but adjacent:
  `wrangler.jsonc` pins `dev.port: 8787`, so a port conflict fails loudly instead
  of silently drifting to 8788.
- **`Error evaluating Node.js code` from a Next dev server: clear the turbopack
  cache before you touch `node_modules`.** `.next/dev/cache/turbopack` (hundreds
  of MB, per Next app) caches the **result of evaluating `postcss.config.js` in
  Node**, including the _failure_, and its invalidation keys are source files
  (`globals.css`, `postcss.config.js`) — **not** `node_modules`. So a package
  that was missing when the config was first evaluated stays missing to the cache
  after you install it: `next dev` replays the old error forever, across
  restarts. Seen as `http://localhost:3000/` → HTTP 500 with
  `Error: Cannot find module 'enhanced-resolve'`, require stack
  `@tailwindcss/node/dist/index.js` ← `@tailwindcss/postcss` ← a
  `.next/dev/build/chunks/*` file. Tell it apart from a real dependency problem:
  with a stale cache `ls node_modules/<pkg>`,
  `npm ls <pkg>`, `npm install --dry-run` ("up to date") and
  `node -e "require('<the requiring file>')"` **all pass** while the server still
  500s; the 500 also arrives instantly, with no compile pause, and names a chunk
  hash `.next/dev/build/postcss.js` no longer references. Fix is
  `rm -rf apps/<app>/.next/dev/cache/turbopack` — that directory alone, no need
  to nuke `.next`, and `nx reset` does not touch it. Both `bracemark-web` and
  `bracemark-site` are Next 16 + Turbopack and can both hit it.
- **A hydration error on `localhost:3001` is your browser, not the site.** Under
  `npm run dev:site`, visiting the marketing site can log "Hydration failed…" with
  `+ <main className="flex-1">` / `- <div className="px-safe">`. It is not an app
  or Next bug: `curl localhost:3001/` returns exactly what `layout.tsx` +
  `page.tsx` should emit, and an extension-free headless load has zero console
  errors with shell children `["HEADER","MAIN","FOOTER"]`. React prints `+` for a
  client fiber with no matching DOM node and `-` for leftover server DOM, so
  `<main>` was already gone at hydration time with its child in its place — the
  DOM was mutated before React ran, which the app cannot cause. Re-confirm in an
  Incognito or guest window and ignore it in dev. The Bracemark **browser
  extension** is ruled out: its dev manifest declares no `content_scripts`.
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
adb shell uiautomator dump                   # bounds only — see Gotchas, not state
adb shell cat /sdcard/window_dump.xml \
  | tr '>' '>\n' | grep -i '<testID or text>' # ONE node — never cat the whole tree
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
maestro hierarchy | grep -i '<testID>'       # the a11y tree, no session — grep it,
                                             # the whole tree is a screenful of JSON
```

### Gotchas

- **`uiautomator dump` is reliable for bounds, NOT for state.** With the
  navigation drawer or a dropdown menu open it repeatedly returns the links
  screen underneath, so a tap that DID work reads as a no-op — the dump reflects
  one window's a11y tree, and RN's overlay surfaces don't land in it the way a
  screenshot shows them. Two hitSlop tests looked like failures on that evidence
  and passed when re-checked. Assert on pixels instead: `adb exec-out screencap
-p`, then either `magick compare -metric AE before.png after.png null:` for
  "did anything change", or read an exact token colour with `magick shot.png
-crop WxH+X+Y +repage -colorspace gray -format '%[fx:round(minima*255)]'
info:` (on light, foreground is 10, muted-foreground 111, muted 245).
- **Metro can serve a bundle that predates your edits** — it starts cleanly,
  answers `:8081/status` with 200, and there is no error at the point of use.
  The tell is in Metro's own log, not the app: `Watchman error: query failed:
synchronization failed: syncToNow: timed out waiting for cookie file to be
observed by watcher within 60000 milliseconds`, usually alongside `Recrawled
this watch 1 time, most recently because: MustScanSubDirs`. With the watch
  wedged Metro never learns the files changed, so its cache stays authoritative —
  and `expo start --clear` alone does NOT fix it, because the rebuilt cache is
  populated from the same broken watch. Fix:

  ```sh
  ROOT=$(git rev-parse --show-toplevel)
  watchman watch-del "$ROOT" ; watchman watch-project "$ROOT"
  cd apps/bracemark-expo && npx expo start --clear
  ```

  Confirm the new bundle is live by asserting on a pixel your change moved
  (above) before trusting any behavioural result — a stale bundle makes a correct
  change look broken.

- **The simulator may have no software keyboard at all.** With Simulator's
  _Connect Hardware Keyboard_ on (the default here), a focused field shows a
  caret and NO keyboard — so any keyboard-shaped change (avoidance, dismissal,
  a sheet that sizes itself around the keys) photographs as if the keyboard did
  not exist. Turn it off before driving one, and note it restarts Simulator:

  ```sh
  defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
  osascript -e 'quit app "Simulator"'; open -a Simulator
  ```

  Quitting Simulator SHUTS DOWN the booted device and boots its own default
  (an iPhone 17, not the 17 Pro these notes and `docs/app-drivers.md` measure
  against) — re-boot the right one and re-check `simctl list devices booted`
  before reading a single pixel. Maestro's `inputText` works either way, which
  is why the e2e flows never noticed.

- **Boot ONE platform at a time.** `e2e/runner/lib.ts` passes Maestro no
  `--device`, so with both a simulator and an emulator up it picks
  non-deterministically or hangs on an interactive picker. Shut one down before
  booting the other.
- **`launchApp` resumes an app, it does not cold-start it.** A flow that assumes
  it begins at a root screen passes alone and fails in a directory run, because
  the previous flow left the app deep in a navigation stack. Reset with
  `clearState`. The failure looks like a driver bug and is not one.
- **The iOS share-sheet tap lies.** `tapOn` the Bracemark entry in the system
  share sheet returns COMPLETED **without launching the share extension** —
  reproduced twice; the extension's `log stream` shows no `launched.` line and
  the sheet just dismisses to Safari. Tap it by coordinate instead (read the
  icon centre off `xcrun simctl io booted screenshot`), then assert on something
  only the extension draws (`Close`, "Sign in to save links"). Also: its label
  lives in `accessibilityText`, not `text`, so a `text:` selector finds nothing
  and looks like the driver being blind. → `docs/share-sheet.md`, _driving it
  from Safari_.
- **Selectors are `testID`s, and they are an interface** — renaming one fails a
  flow as a bare timeout that names nothing. The list is in `docs/e2e.md`, _the
  testID contract_. Selectors otherwise bind to the a11y tree, so an unlabelled
  control is untestable as well as inaccessible (`docs/accessibility.md`).
- **Write screenshots to the scratchpad, not the repo** — nothing gitignores a
  stray `shot.png` at the root.
- `apps/bracemark-expo/ios/` and `android/` are generated and gitignored — never
  hand-edit them to make a run work. → `docs/expo-build.md`
- Why Maestro and not Appium/Detox, what a real device buys, and the AVD's
  config: `docs/app-drivers.md`, _driving the native apps_.
