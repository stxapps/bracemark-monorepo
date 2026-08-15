## testing

What is tested, by which runner, and how each app is driven when a change needs
to be seen working rather than asserted on. Three layers, and they are not
interchangeable — most of this doc is about which one a given question belongs
to.

| layer                | what it covers                                       | how it runs                         |
| -------------------- | ---------------------------------------------------- | ----------------------------------- |
| **unit / component** | pure logic, hooks, a rendered component's behaviour  | `npm run test` — jest or vitest     |
| **driving the app**  | a real build, a real browser or device, a whole flow | by hand / by agent, not a target    |
| **typecheck + lint** | boundaries, types, the module-boundary tags          | `npm run typecheck`, `npm run lint` |

The third layer is easy to forget in a testing doc, but it is the one that
catches the largest class of mistake here: `@nx/enforce-module-boundaries` turns
an illegal cross-package import into a lint failure rather than a silent
runtime surprise. See [architecture.md](./architecture.md).

**Nothing runs automatically.** There is no CI workflow in this repo yet, and
the only git hook (`tools/git-hooks/pre-commit`) guards `internal/`, not tests.
`npm run test` is a thing you run.

### the layer to reach for

Push work down. A spec that can be written against a rendered component should
not be written as a browser flow: it runs in milliseconds, it is cached, and it
fails with a stack trace instead of a screenshot. Drive the real app when the
thing under test is genuinely cross-cutting — a whole account flow, sync
landing, the share sheet, a native permission — or when you need to _look_ at
it.

The single most common miss in this repo is an accessibility assertion getting
written as a browser check when it belongs in a component spec. Error
announcement, labels, roles: all reachable from `@testing-library`'s queries.
See [accessibility.md](./accessibility.md).

### which runner, and why

Two runners, split by **the runtime the code has to execute in** — not by
preference, and not by drift.

| runner       | projects                               | why                                                                       |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| **jest 30**  | all 7 packages + `web`, `site`, `expo` | jsdom for web, `jest-expo` for React Native. Pinned in the root manifest. |
| **vitest 4** | `bracemark-api`, `bracemark-extractor` | `@cloudflare/vitest-pool-workers` runs specs **inside workerd**.          |

The two Workers apps are the exception that explains itself: their tests run in
the real runtime via miniflare, so `bracemark-api` gets real local D1, a real
SQLite-backed Durable Object and real R2, and `bracemark-extractor` gets the
real `HTMLRewriter` and stream primitives. A Node runner could only mock those,
which would encode our assumptions back at us. That pool exists for vitest and
has no jest equivalent, so the choice was made by the runtime. Both
`vitest.config.ts` files carry the full reasoning at their top — read those, not
a paraphrase here. Vitest is declared in the two app manifests; jest is pinned
at the root.

`npm run test` is `nx run-many -t test` and covers **all 12 projects with a test
target**. A second run prints almost nothing and finishes in ~150ms — that is
Nx cache reporting `12/12 hit`, not projects being skipped. To force real
execution, `npx nx reset` or scope to one project with
`npx nx test @stxapps/<project>`.

`bracemark-extension` has no test target and no specs.

### the shared jest plumbing

Three config families, because `preset` takes exactly one value:

- **`jest.preset.js`** — the Nx base. Used directly by six packages: `shared`,
  `react`, `web-ui`, `web-react`, `web-crypto` and — note — **`expo-crypto`**,
  which is plain enough to run on node and needs nothing from `jest-expo`. Sets
  `passWithNoTests` (a package generated before it has specs should be green)
  and `watchman: false`.
- **`jest.expo-base.cjs`** — `bracemark-expo` and `expo-react`, the two projects
  that render React Native. Those _must_ have `preset: 'jest-expo'`, so
  everything `jest.preset.js` would have given them is restated once in a
  factory. It is not itself a preset — spread its result, never point a
  `preset:` at it.
- **`next/jest`** — `bracemark-web` and `bracemark-site`. These **layer on top of
  `jest.preset.js`** rather than replacing it: the config handed to
  `nextJest()` still sets `preset: '../../jest.preset.js'`, and both files then
  patch the _resolved_ `transformIgnorePatterns` by hand, because `next/jest`
  only appends to it and can't relax the base `/node_modules/` ignore.

**`jest.esm-packages.cjs` is the single source of truth** for node_modules that
ship raw ESM and must be transpiled rather than ignored. All three families read
it. Adding an ESM-only dependency that any spec touches means adding it there,
once — the symptom of forgetting is `Cannot use import statement outside a
module` from inside node_modules.

`watchman: false` appears in two places on purpose. Watchman's watch root here
is the whole monorepo, so every run made each project `syncToNow` over the full
tree; once the fsevents queue overflows, that sync never lands and jest burns
its full 60s timeout before falling back to the node crawler anyway. The crawl
is ~1s per package. Do **not** "fix" this by adding `node_modules` to
`.watchmanconfig`'s `ignore_dirs` — Metro needs the symlinked `@stxapps/*`
packages watched for expo HMR.

#### tripwire: the `jest` bin collision

`jest` and `jest-expo` both claim `node_modules/.bin/jest`, and **which symlink
npm writes depends on reify order — it can flip on any install.** When
`jest-expo` wins, every project's inferred `test` target runs its nested jest 29
instead of the real jest 30 and fails on untransformed ESM. The root
`postinstall` runs `tools/scripts/fix-jest-bin.mjs` to relink it
deterministically after every install. If `npm run test` starts failing
workspace-wide with `Cannot use import statement outside a module` right after
an install, check that link before anything else.

### coverage today

The honest state, so nobody reads a green `npm run test` as coverage:

| project               | specs | note                                   |
| --------------------- | ----- | -------------------------------------- |
| `shared`              | 37    | the best-covered project, by a lot     |
| `bracemark-api`       | 12    | real D1/DO/R2 through the Workers pool |
| `expo-react`          | 9     |                                        |
| `bracemark-expo`      | 7     |                                        |
| `bracemark-extractor` | 5     |                                        |
| `web-react`           | 3     |                                        |
| `web-crypto`          | 1     |                                        |
| `expo-crypto`         | 1     |                                        |
| `bracemark-site`      | 1     | scaffold only                          |
| **`bracemark-web`**   | **1** | **scaffold `page.spec.tsx` only**      |
| **`web-ui`**          | **0** | test target, no specs                  |
| **`react`**           | **0** | test target, no specs                  |

The bottom three are the gap worth naming: `bracemark-web` is the primary app
and has one generated spec, and the two web packages it is built out of have
none. `passWithNoTests` is what keeps that green — it is the right setting for a
young package and the wrong thing to read as a pass.

### driving bracemark-web

**`playwright-core` is a root devDependency.** It drives the _system_ Chrome via
`executablePath` rather than a downloaded browser — that is why it is
`playwright-core` and not `playwright`, whose install pulls a browser bundle
this repo has never had (`~/Library/Caches/ms-playwright/` has been empty).

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

### driving the native apps

The thing that makes a browser useful to automation is not the screenshot, it is
the **queryable tree**. On mobile that tree is the accessibility tree — which
makes [accessibility.md](./accessibility.md) load-bearing twice over: labels and
roles are what a driver's selectors bind to, so an unlabelled control is
untestable as well as inaccessible.

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
friendliest of the three surfaces. Note there is no AVD created yet; the
`android-36.1` `google_apis_playstore` arm64-v8a image is downloaded. The Play
Store image cannot `adb root`, so pull the plain `google_apis` variant if that
ever matters.

**A real iPhone is possible and is the highest-friction path.** It needs a dev
build signed with a profile carrying the device UDID, and WebDriverAgent
installed on the phone for tap and query — which needs its own signing.
Screenshots come through WDA, not simctl. Reserve it for what a simulator cannot
do honestly: the real iOS share sheet from another app, StoreKit sandbox, push,
real performance. See [share-sheet.md](./share-sheet.md) and
[expo-build.md](./expo-build.md).

#### the driver: Maestro, not Appium

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
   command.

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

One caveat that remains untested: the claim that Maestro is weak at iOS
cross-app flows comes from its design, not from a run against our share
extension. If it ever matters enough, spike it rather than take it on faith.

Remember that `apps/bracemark-expo/ios/` and `android/` are generated and
gitignored — nothing a test setup needs may be hand-edited there.
→ [expo-build.md](./expo-build.md)
