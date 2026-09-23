## e2e

Whole-flow tests: a real build, a real browser or device, a whole flow. This is
layer two of the three in [testing.md](./testing.md) — read that first, because
most of the value here comes from knowing what does **not** belong at this layer.
Everything below assumes the push-work-down rule and only argues about what
survives it.

`e2e/` is one Nx project, `@stxapps/e2e`. It is deliberately **not** part of
`npm run test`.

### four client surfaces, plus the stitched contracts

| surface       | driver             | what only it can prove                                                          |
| ------------- | ------------------ | ------------------------------------------------------------------------------- |
| **web**       | `@playwright/test` | Dexie survives a reload, cross-origin sign-out, real Argon2id in a real browser |
| **extension** | `@playwright/test` | unpacked MV3 profile/session, popup writes, worker restart, web cross-read      |
| **native**    | Maestro            | real expo-sqlite, secure-store, cold-start session, per-platform navigation     |
| **contract**  | both, stitched     | one password → the same keys → the same blobs, **web ⇄ mobile**                 |
| **vectors**   | Maestro, no stack  | the FROZEN table against real quick-crypto, on device                           |

The third one is the reason this layer exists at all. `web-crypto` and
`expo-crypto` each carry a `contract-vectors.spec.ts`, and those prove both
implementations agree with a frozen table of vectors. What they cannot prove is
the round trip: real Argon2id in a browser → the real api → a real R2 blob → back
out through `react-native-quick-crypto` on a device. `ARGON2_PARAMS` and the
encrypted-blob framing are explicitly frozen cross-platform contracts
(`packages/shared/src/crypto/params.ts`, [local-first-sync.md](./local-first-sync.md)),
and drift in either is **silent** until a user with two devices finds it.

Both directions are run, and they are not redundant: web→mobile proves
expo-crypto can decrypt what web-crypto sealed, mobile→web proves the reverse. A
packing bug on one side only shows up in one of the two.

The **vectors** leg (`runner/vectors.ts` → `mobile/contract/vectors.yaml`) is the
third, and it exists because a round trip has a blind spot that no amount of
running it harder will fix: it proves the two platforms agree with **each other**,
so a param changed on both in one release round-trips perfectly and locks every
existing user out of their own data. That leg pins the frozen bytes themselves,
against the real `react-native-quick-crypto` — the C++ Argon2id/HKDF/AES-GCM that
`@stxapps/expo-crypto`'s jest suite replaces with a Node shim. It drives a
dev-only screen (`/contract-vectors`) rather than asserting through the UI,
because what it needs to compare is bytes, and it needs no account, no api and no
`npm run dev` at all.

### why `e2e/` and not `apps/bracemark-web-e2e`

Nx's generators default to an `<app>-e2e` sibling. That is wrong here, for four
reasons in descending weight:

- **`apps/` is an enumerated contract.** CLAUDE.md and
  [architecture.md](./architecture.md) list exactly six apps and call them
  properties. Two entries that aren't apps would force a caveat explaining that
  the list doesn't mean what it says.
- **Web e2e is not a bracemark-web artifact.** It drives web + api + extractor
  together, and the contract runs drive web _and_ expo. Filing either inside one
  app's folder misattributes ownership; the contract runs have no single owner at
  all.
- **Cache hygiene.** Anything under `apps/bracemark-web/` is in that project's
  `default` named input, so every e2e edit would bust the web build cache. A
  sibling project doesn't.
- **npm workspaces.** `e2e` is listed in the root `workspaces`, so
  `@playwright/test` is declared in `e2e/package.json` rather than at the root.
  That matches the existing convention: jest is pinned at the root because ten
  projects use it, vitest lives in the two app manifests because only they do.

```
e2e/
  playwright.config.ts    extension.playwright.config.ts    global-setup.ts
  cases.json              case ids, tiers, traits, fixtures and artifact contract
  fixtures.json           fixture sizes and deterministic/online URL contract
  paths.ts                the one answer to where a run writes
  web/                    playwright specs + fixtures
  extension/              unpacked-extension specs, shared driver, release checks
  mobile/flows/           maestro flows, run standalone
  mobile/shots/           maestro flows for the native store captures
  mobile/contract/        maestro legs of a contract run (parameterised)
  runner/                 wrappers, filters, preflights and cross-client orchestration
  seed/                   the dev accounts and their archives — not tests (below)
  shot/                   the published screenshots — not tests either (below)
  .artifacts/             gitignored — traces, reports, run manifests, profiles
  credentials/            gitignored — what `npm run seed:accounts` created
```

### staying out of `npm run test`

`npm run test` means "unit and component, fast, cached". A browser-driving target
has different cache semantics and belongs behind its own name. Three things keep
that true, and the first is the one that will bite:

- **Never put a jest config in `e2e/`.** `@nx/jest/plugin` infers a `test` target
  from its mere presence, and the project would silently join `nx run-many -t test`.
- Specs are named `*.e2e.ts`, never `*.spec.ts` — a second line of defence behind
  the first, and the reason `testMatch` is set explicitly.
- Targets are `e2e-web`, `e2e-extension`, `e2e-mobile`, `e2e-contract`. No target
  is called `test`.

Inferred from the project's own files, `@stxapps/e2e` gets `typecheck` and `lint`
for free and no `build`. Both are worth having: a stale selector type is a free
catch, and the project is tagged, so the module boundary below is enforced.

**The e2e targets set `cache: false`.** Nx would otherwise key a run on `e2e/`'s
own files, and report a cached pass after an app change that broke the flow —
which is strictly worse than not caching at all.

### the module boundary

`e2e` is tagged `type:e2e` + `platform:agnostic`, with one constraint in
`eslint.config.mjs`: it may depend only on `type:shared`.

The rule behind the rule: **e2e drives the built apps over the wire and the
screen — it is a client of them, never a consumer of their source.** Importing app
or UI internals would let a refactor "fix" a broken flow, which is the one thing
this layer exists to prevent.

`@stxapps/shared` is allowed for **addressing** — the `LinkQuery` URL grammar
([search.md](./search.md)), sync paths — and never for **expectations**. Copy,
crypto and formatting must be spelled out in the spec. A spec that asserted
against `listing-copy.ts` could not catch a copy regression, and the contract runs
must import no crypto at all, because two independent implementations agreeing is
the entire claim. `web/fixtures/links.ts` re-spells `displayUrl`'s rule by hand
for exactly this reason.

### the browser this repo drives

**`@playwright/test`, launching system Chrome for the web app and bundled
Chromium for the browser extension.** The runner is worth its
dependency for auto-retrying `expect(locator)` assertions, the trace viewer, and
worker fixtures; hand-rolling retry logic is the reinvention this repo's
dependency culture exists to avoid.

What it is _not_ allowed to bring **on its own** is its browser bundle — ~550 MB
into `~/Library/Caches/ms-playwright/`, which no install here populates. That is
what made the original root devDependency `playwright-core` rather than
`playwright`.

**The one sanctioned reason to fetch it deliberately is `bracemark-extension`.**
Google Chrome will not load an unpacked extension from the command line and says
nothing when it declines, so driving the popup needs Playwright's own Chromium
(`npx playwright install chromium`) — see `docs/app-drivers.md`, _driving
bracemark-web_, and the extension section of `.claude/skills/verify/SKILL.md`.

Exactly two entrypoints use it: the `e2e-extension` functional target and
`shot/extension.ts`, the store-screenshot leg (_the published screenshots_,
below). Every web-app spec still goes through `CHROME_PATH`. The browser
extension is the exception because its subject is the unpacked build, which
system Chrome cannot load from command-line flags at all.

**No suppression is needed to keep it that way, and none is configured.** At
1.62.1 none of `@playwright/test`, `playwright`, or `playwright-core` declares an
`install`/`postinstall` hook — the browsers come only from an explicit
`npx playwright install`, which nothing here runs. npm's own record of this is
`hasInstallScript` in `package-lock.json`: sixteen packages in this tree carry it
(`sharp`, `esbuild`, `workerd`, `@swc/core`, …) and none of the three Playwright
entries is among them.

This was not always obvious. A root `.npmrc` carrying
`playwright_skip_browser_download=1` lived here briefly, on the belief that the
hook existed and had to be silenced. It never suppressed anything — the empty
browser cache that seemed to confirm it was empty for the simpler reason — and it
cost two `npm warn Unknown … config` lines on **every** npm command in the
workspace (one for the file, one more because npm re-exports the key into the
environment of each nested `npm run` that `nx` spawns). It is gone. Do not
reintroduce it, or its `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`-from-`.zshenv`
variant, without first confirming there is a hook to suppress.

`@playwright/test` is pinned `^1.62.1`, so a future minor could in principle bring
a download hook back. The tell used to be `~/Library/Caches/ms-playwright/`
appearing at all; it no longer is, because the extension exception above puts a
browser there on purpose. `hasInstallScript` in the lockfile diff is the check
that still means something — a populated cache does not.

Because it borrows the system browser it is pinned against whatever Chrome is
installed, and Chrome auto-updates. Expect an occasional bump when a new Chrome
breaks a protocol assumption; `E2E_CHROME_PATH` overrides the location, and
`/Applications/Chromium.app` works the same way.

#### the browser extension functional target

`e2e-extension` builds the development Chrome MV3 bundle, copies it under the
run's artifact directory, adds `tabs` to that copy, and launches it in a fresh
persistent headed bundled-Chromium profile per case. Headed is required because
this runtime does not register the unpacked MV3 worker in its default headless
mode. The target runs one worker: every case already pairs that browser with a
system-Chrome account client, and two simultaneous pairs stalled both auth
ceremonies in measurement. The copy matters twice: the store
manifest remains unchanged, and the profile preserves the origin-bound,
non-extractable encryption key across popup and browser restarts. Each case also
owns a disposable account; the sync cases use an independent system-Chrome web
profile as the other client.

The `tabs` addition lets popup.html run as an attachable tab and still read the
real active page behind it. It is not a substitute for the shipped manifest's
toolbar-created `activeTab` grant. `EXT-EXTRACT-001` stages a second copy with one
additional host permission — only the local web origin — so the background can
inject the title/image collector into its controlled page. The run manifest
records both differences and records `activeTabToolbarGrantProven: false`.
`EXT-RELEASE-001` in `e2e/extension/RELEASE.md` owns the real Chrome-toolbar
boundary; the Firefox production-build smoke is beside it.

Popup and background remain real extension contexts. The worker-restart case
stops the installed MV3 service-worker version through CDP, observes its stopped
state, then uses the popup's public Sync request to wake it back to running and
observes the pulled link through the live popup. There is no app source import,
storage-state shortcut, or test-only message.

#### the fixture constraint — read this before touching `web/fixtures/`

**The standard Playwright auth fixture cannot work in this app.** The session
lives in IndexedDB (`bracemark-session`) and holds a **non-extractable
`CryptoKey`** — deliberately, so an XSS can use the key but never exfiltrate it
(`packages/web-react/src/data/session-store.ts`, [account.md](./account.md)).
Playwright's `storageState` serialises to JSON; a non-extractable CryptoKey is
structured-cloneable but not JSON-serialisable. So "sign in once, replay
storageState into every test" is out — and it fails by handing you a _signed-out
page_, not by erroring.

What works is a real on-disk profile: `launchPersistentContext` keeps IndexedDB
and the key comes back still non-extractable. **The unit of reuse is a browser
profile, not a state blob.** Hence:

- the context is **worker-scoped**, and the account is created through the real UI
  once per worker;
- two workers, because each pays one Argon2id derivation (64 MiB, t=3) at setup;
- every test in a worker **shares one account and one accumulating data set**.
  Namespace anything you create with `unique()` (`web/fixtures/data.ts`, which the
  runners share so their `.invalid` URLs have the same shape a spec's do), never
  assert on a global count,
  and never sign out — `account.e2e.ts`'s sign-out test buys its own isolated app
  via `launchApp` for exactly that reason. That spec creates a list and signs out
  from **it**, not from bare `/links`: the teardown race it guards only reproduces
  on a user list, since the default selection is a system list that can never look
  deleted ([data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_).

Do **not** speed setup up by weakening `ARGON2_PARAMS`. They are a frozen
cross-platform contract, and a run that derived with different numbers would stop
testing derivation at all.

Two smaller findings from making this work, both of which look like bugs in your
code when you hit them:

- **Playwright already instruments a persistent context.** `use.trace` /
  `use.screenshot` apply to it, and starting tracing by hand in a fixture fails
  with `Tracing has been already started`.
- **The empty destructuring pattern `async ({}, use)` is required**, not stylistic
  — Playwright parses the signature for fixture dependencies and rejects a plain
  identifier. It trips `no-empty-pattern`, so those two sites carry a scoped
  eslint disable.

#### what e2e may not assert

**Extracted titles.** bracemark-extractor's SSRF guard blocks `localhost`,
`*.localhost`, `.local` and every private/reserved IP, and states outright that it
allowlists nothing (`apps/bracemark-extractor/src/lib/ssrf.ts`,
[link-extraction.md](./link-extraction.md)). A local fixture server is therefore
unreachable **by design**, and weakening that guard to serve a test would trade
the app's real security boundary for convenience.

So specs add links at `https://…invalid/…` — the reserved TLD, guaranteed not to
resolve — extraction fails, and the row keeps its URL fallback, which is stable
and assertable. **Assert on what the user typed, never on what was extracted.**
Extraction has five vitest specs against the real `HTMLRewriter`; that is the
right layer for it.

**The exception is the `internet` cases, and it is narrow on purpose.** The
`EXTRACT-*` cases (Phase 7) do assert an extracted title, and they get it from
one real public origin: `example.com`, IANA's reserved documentation domain —
the `onlineExtraction` table in [`e2e/fixtures.json`](../e2e/fixtures.json), read
by `e2e/web/fixtures/extraction.ts`, which both runners use. A run-scoped `?e2e=`
query keeps each saved URL unique (the origin ignores it), and any other path on
the origin answers a real **404**, which `verdictForStatus` settles as
`permanent` — so the one host gives a known title AND a controlled permanent
failure, and a `.invalid` URL still supplies the transient one.

It is a host we do not own, which bounds the claim. It has no `og:image` and never
redirects, so **the preview image, redirect handling and a no-metadata page are
not proved end to end** — they stay in the extractor's and expo-react's unit
specs. A fixture origin of our own (a small Worker with pages for each) was
proposed and deliberately not built: it would add a public deployment to own,
monitor and keep honest; `EXTRACT-FIXTURE-001` in `e2e/NEXT.md` stays open as the
record of that choice. Nothing weakens the SSRF guard either way.

Those cases carry the **`internet`** trait, and it is not `online`: every
stack-backed case already carries `online`, so only `--exclude-trait internet`
yields a run with no third-party dependency. A red `internet` case whose
`fetch` to example.com itself failed is an availability fact, not a product one —
`curl -sI https://example.com/` settles which before anything else is read.

**The backup round trip.** Export ⇄ import looks like a whole-flow question and
is not one, for a reason specific to this app: `exportAllData` claims its
destination through `window.showSaveFilePicker`, which the system Chrome this
repo drives really does implement — so the export opens a **native save dialog
Playwright has no API for**. Stubbing it with `addInitScript` would leave the
browser proving nothing about the save path, which is the only part of this the
browser could prove. Beyond that, `e2e` may depend on `type:shared` alone and
drives the apps over the wire, so it cannot call the orchestrators, and comparing
two libraries entity-by-entity through the DOM is the worst available oracle.
And a file-to-file comparison is wrong for three of the four formats anyway — the
interop ones are lossy BY DESIGN ([data-lifecycle.md](./data-lifecycle.md)), so a
golden file would encode today's lossiness as the contract.

It lives at the unit layer instead, with a real zip container in both packages'
`data/export-import.spec.ts` and golden cross-platform archives in `shared`
([testing.md](./testing.md), _the ported pair_). What is left for this layer, if
it is ever wanted, is thin: that the button produces a download with the right
name and that the receipt announces the right counts.

**A real Paddle purchase.** Every paid state is reachable without one — the seed
writes a `manual` purchase row straight into D1 (_seeding a dev account_ below),
which is a real product state rather than a test hook. What a checkout run would
add on top of that is Paddle's overlay: a third-party iframe on `*.paddle.com`
whose DOM is not ours and changes without notice, a sandbox card, possibly a 3DS
step, and then a wait of seconds to minutes for the webhook that actually flips
the plan. Worse, it is not idempotent — a green run leaves a live sandbox
subscription behind, and the next run's `already_subscribed` 409
([iap.md](./iap.md), _checkout_) refuses to start, so the spec would have to
cancel through Paddle's API in teardown to be runnable twice. The half of that
flow that CAN go wrong silently is config rather than UI, and it is checked
without a browser by `npm run check:paddle`; the delivery half is a manual
release check ([iap.md](./iap.md), _exercising Paddle locally_).

**Keyboard dismissal.** The flows reach for Maestro's `hideKeyboard`
(`subflows/sign-in.yaml`, `flows/recovery-sign-in.yaml`), which is a **native**
command — it puts the keyboard away without touching the app's own affordances.
On iOS it does that by TAPPING A BLANK AREA, which is why the two add-link flows
no longer use it: the add panel's blank area is its backdrop, so the step closed
the surface mid-form and the run failed on a Save button that was no longer
there (docs/soft-keyboard.md, _the add panel_). **On Android it is a BACK press**
— `input keyevent 4`, sent whether or not a keyboard is up — so wherever the
field has already blurred, it reaches the app instead and the topmost
`BackHandler` answers it. `shots/store.yaml`'s search step lost its search UI
that way, one line after the `pressKey: Enter` that had already dropped the IME,
and the run stayed green around a capture of the unfiltered library. Prefer
leaving it out where the form is already above the keyboard, and reach for it
only where an input is still focused — if the flow has just submitted, the step
is at best a no-op and at worst a navigation.
So every one of the app's dismissal paths (return/done, tap-outside,
scroll-to-dismiss) can regress with the whole suite still green, and a field can
end up with no way to close the keyboard at all. That is not a gap to close by
asserting harder here: the mechanisms are RN defaults that jest doesn't render
and the a11y tree doesn't expose. It is a **manual** check, and
[soft-keyboard.md](./soft-keyboard.md) carries the contract, the surfaces to
check, and the four ways Maestro itself misleads you on this (portals and
keyboard-covered panels dropping out of the tree, the autocorrect strip
intercepting taps, and `appId` deciding what is addressable).

### driving the native apps

Maestro, for the reasons in [app-drivers.md](./app-drivers.md) (_the driver: Maestro, not
Appium_) — one YAML flow across the iOS simulator, the Android emulator and a real
device, no server, no session to hold, and `maestro hierarchy` as a text dump of
the view tree.

Flows bind to the **accessibility tree**, which makes
[accessibility.md](./accessibility.md) load-bearing twice over: a control with no
accessible identity is untestable as well as inaccessible. Flows bind to `testID`
and accessible labels, **never to body copy** — copy in this repo changes often,
and a flow keyed to a sentence turns every wording edit into a red run.

Seventeen repo-specific gotchas:

- **`launchApp` resumes, it does not cold-start.** Every flow that assumes a root
  screen needs its state wiped first, or it passes alone and fails in a directory
  run because the previous flow left the app deep in a navigation stack. That
  failure looks exactly like Maestro's batch-mode driver bug and is not one.
- **…though "resumes" means the STORED state, not the process.** A bare
  `launchApp` on an app that is already running stops it first. Measured on both
  platforms by `LOCK-AUTORELOCK-001`: Home then `launchApp` relocked the app after
  a few seconds away, because the in-memory unlock went with the process. A flow
  that means "bring it back to the foreground" says `launchApp: stopApp: false`.
- **…but `clearState: true` wipes expo-dev-client's state too**, which is why the
  wipe goes through `flows/subflows/cold-launch.yaml` rather than `launchApp`.
  `clearState` is `pm clear`: it takes the dev launcher's
  recently-opened-apps registry and the dev menu's `isOnboardingFinished` with it,
  so the next launch shows the launcher's "enter the dev server URL" home screen,
  and then floats the dev-menu sheet over whatever loaded. Both are
  expo-dev-client chrome, neither is assertable, and a flow that ignores them
  fails as a timeout on its first `tapOn`. The subflow launches by dev-client deep
  link instead — bundle URL and `disableOnboarding=1` both stated up front, so
  neither screen has a reason to appear. One link covers both platforms: the
  param rides on the inner URL, which is what Android reads as the manifest URL
  and iOS as `expoUrl`. The hand-driven twins are `npm run expo:ios:open` and
  `npm run expo:android:open`. Its cost is that the mobile legs now assume a
  **dev** build with Metro up, which they already did. The published-captures leg
  opts out of the wipe altogether — _the published screenshots_, below.
- **Android needs `adb reverse tcp:8787 tcp:8787`** (and `8788` for the
  extractor, `8081` for Metro — `npm run expo:android:reverse` does all three). Both
  `.env.development` files point at `http://localhost:8787` and
  `EXPO_PUBLIC_*` is inlined by Metro at bundle time, so one value has to serve the
  iOS simulator and the Android emulator both. Reversing the port teaches the
  emulator that localhost means the host; switching to `10.0.2.2` instead would
  fork the env per platform, which [env-files.md](./env-files.md) is shaped
  specifically to avoid. The same reversal is what lets a PHYSICAL Android device
  run `bracemark-web` without a certificate —
  [device-testing.md](./device-testing.md).
- **On Android a dev build's LogBox toast takes taps ABOVE itself.** Its container
  is a `SafeAreaView` pinned 20px off the bottom, and the inset padding leaves a
  transparent strip over the visible toast that swallows touches — measured on the
  Pixel 8 AVD, from y≈2019px down. A tap there reports COMPLETED and does nothing.
  The toast that raised it in `link-lifecycle.yaml` is a `console.error` from
  `@rn-primitives`' close hook: 50ms after a row menu closes it returns
  accessibility focus to the ⋯ trigger, and RN's bridgeless UIManager logs
  `sendAccessibilityEvent() dropping event: Cannot find view with tag #…` when
  that view is no longer in the committed tree. It runs whether or not a screen
  reader is on. **It is a race with the list's re-render, not "the item removed
  its row"**: across two runs of that flow on the Pixel 8 AVD it fired on exactly
  Pin, Archive, Unarchive and Restore — Pin removes nothing — and never on Unpin or
  Remove, while the same six actions driven one flow at a time in a long-lived
  session logged it 0 times in 30. What decides it was not pinned down; the step
  that raises it is read off `device-logcat.txt` against `commands.json`'s
  timestamps plus durations (start times alone put it a step late). That flow
  unpins its link so the menus it
  presses stay short of the strip, and runs `flows/subflows/dismiss-logbox.yaml`
  before pressing the FAB, which the toast covers outright — a FAB press there
  left no add panel, and no toast either — its ✕ sits under the FAB's centre. The
  subflow is a no-op without a toast and presses the ✕ as a point inside the
  toast's own bounds, not the screen's; a flow that presses low on an Android
  screen after a row-removing menu action owes it the same call. Release builds
  carry no LogBox, so this is harness-only — and the logged error is not what a
  TalkBack user meets either: with TalkBack on, Archive logged nothing and still
  lost focus, which is its own problem ([accessibility.md](./accessibility.md),
  _focus after a row leaves the list_).
- **A flow's `env:` block is not a default — it wins.** Measured on Maestro
  2.8.0: a value in a flow's own `env:` beats `-e` from the command line, and a
  subflow's `env:` beats both `-e` and the caller's `runFlow: env:`. A default
  written there turns the runner's per-run value into a silent no-op, while
  `command.json` still lists the key the runner passed — so no flow carries
  `env:` defaults. A parameter a hand run may omit takes its default inside the
  expression instead, `${NAME || 'default'}`: an unset variable is `undefined`,
  not an error. `flows/subflows/cold-launch.yaml` does this for
  `EXPO_DEV_CLIENT_LINK`; every other parameter is required.
- **…and an EMPTY `runFlow: env:` value arrives as `undefined`, not `''`.**
  `flows/subflows/add-link-filed.yaml` takes `LIST: ''` to mean "leave the default",
  and its first guard, `${LIST !== ''}`, was true for the empty value: the branch
  ran and a link the case needed tag-less was tagged, which surfaced three screens
  later as a search result that should not have matched. Guards on optional
  parameters test truthiness (`${!!LIST}`).
- **iOS keeps checkbox state in the accessibility VALUE, where `checked:` does not
  look.** RN maps `aria-checked` to Android's `checked` attribute, which Maestro's
  `checked: true` reads, and on iOS to the value "checkbox, checked", which it
  does not — the selector fails on a row that is plainly checked.
  `flows/subflows/assert-selection.yaml` asserts `checked` on Android and copies
  the value off the named node on iOS.
- **A composite row name is not an inventory.** A link row's accessible name
  folds in its first tag chip and then "Show 1 more tag", not the second tag, so
  tags past the first are read through the tag views
  (`flows/bulk-actions.yaml`). And on iOS the tree does not always carry the row's
  inner checkbox ("Select <url>") beside the pressable row ("Select <url>, <monogram>,
  <url>, <host>"): the flows match the name with its optional tail,
  `Select .*<url>(,.*)?`.
- **"Visible" is not "unobstructed".** A scroller's rows stay in the tree under a
  pinned footer or header, count as visible, and take a tap that lands on the bar
  instead — reported COMPLETED, changing nothing. Measured in the advanced-search
  sheet: the Tags row at y 800–836 under the footer at 794–830. Scroll such a row
  with `scrollUntilVisible: centerElement: true` before pressing it
  (`flows/search-advanced.yaml`); the one field that cannot be centred, the first,
  is filled before anything scrolls.
- **Maestro's text regex is case-insensitive.** `.*<url>.*Pinned.*` matched a url
  whose slug said "bulk-pinned-first" before any pin existed, and every pin wait in
  the flow passed on it. Anchor on what only the state adds — `, Pinned` with its
  comma — and keep state words out of fixture slugs.
- **An open menu or dialog empties iOS's tree, so `assertNotVisible` passes.**
  `@rn-primitives`' portals are `accessibilityViewIsModal`, which hides every other
  node from XCUITest while they are up. A menu item whose tap did not register
  left its menu open, and the two "this row is no longer pinned" assertions after
  it passed against a tree with no rows in it. After a menu or dialog action, wait
  for something the screen always shows (`links-more-options`) before asserting
  absence, and assert the selection count before acting on a selection.
- **The "links without a preview" prompt covers the middle of the links screen.**
  Every `.invalid` link lacks a preview, so the prompt is up in these flows, and it
  holds the upper half of the screen over the list — where `centerElement` parks a
  row. `flows/bulk-actions.yaml` dismisses it before selecting rows.
- **Android 13+ floats its clipboard preview over the bottom-left corner.** After
  a copy, a tap on the bulk bar's ✕ opened the system clipboard editor ("From
  Bracemark") instead of leaving the mode. `flows/bulk-copy.yaml` leaves the mode
  with the hardware back press there.
- ⚠ **The LogBox badge is not always a number, and `dismiss-logbox` fails
  SILENTLY when it isn't.** RN renders it as `count <= 1 ? '!' : count`
  (`LogBoxNotificationCountBadge`), so a lone log — the common case — names the
  toast `"!, <message>"`, which a `[0-9]+, .+` matcher does not match. The `when:`
  evaluates false and the subflow reports SKIPPED, indistinguishable from the
  no-op it reports when no toast is up. The caller then presses into a toast that
  is still covering the bottom of the screen, the press CLOSES the toast instead
  of doing what it meant to — and since that removes the toast, anything dumping
  the hierarchy afterwards sees an innocent screen. The tap reports COMPLETED and
  the failure surfaces one step later naming whatever the press should have
  opened. The matcher therefore spells both forms. Specimen: `FILTER-001` on
  Android, 2026-09-20 — `add-link-url not found` on the add following a row-menu
  action, with `sendAccessibilityEvent() dropping event: Cannot find view with
tag #N` in the toast. That error is RN-internal and not worth chasing: the app
  makes no accessibility calls at all, so it is the platform dispatching to a
  view the driver just unmounted, and release builds have no LogBox to show it.
- ⚠ **A long press on an empty, unfocused iOS field places the caret instead of
  raising the edit menu**, so `Paste` never exists to tap. `flows/bulk-copy.yaml`
  reads the pasteboard back through the system paste and so focuses the Note
  field first. The trap is that the step fails identically whether the platform
  write landed or not: measured on iOS 26.5, `xcrun simctl pbpaste` held both
  URLs in display order while the flow reported the app broken.
- **A press made while a surface is still leaving is swallowed.** A row's ⋯
  pressed as soon as the add panel dropped out of the tree opened no menu on iOS,
  so `flows/subflows/add-link.yaml` waits for the saved row and for animations to
  end before handing the screen back.
- **A Maestro tap on the Pixel 8 AVD returns about six seconds after it presses.**
  Feedback shorter than that — bulk Copy's 1.5s "Copied" — has reverted before any
  assertion can run, so `flows/bulk-copy.yaml` asserts it on iOS only and proves
  the clipboard write on both through the system Paste.
- **Maestro's `PATH` entry is in `.zshenv`, not `.zshrc`.** `runner/lib.ts` falls
  back to `~/.maestro/bin/maestro` anyway, so a shell that lost it gets a working
  run instead of `ENOENT`.

#### gestures and waits the runner performs

Some native cases need something between flows that no flow can express, so a
case may be a sequence of steps (`CaseStep` in `runner/native-run.ts`): its
registered flow first, then committed part flows in `mobile/flows/parts/` — outside
the directory glob, since each assumes the state the previous step left — and
host-side steps between them. A host step measures, waits, synthesizes a gesture,
acts as ANOTHER client, or cuts the device off the api; the flows it generates
are written under the case's artifacts so the exact gesture is on record. Every
assertion about what the app shows stays in a committed flow, with one
exception: a claim in BOUNDS — where a row is painted relative to the list — is
checked by the host step that read them, since a flow can only say "visible".

- **A touch drag measured off the screen** (`TAXONOMY-DND-002`). A native settings
  row lifts on a long press of its grip (gesture-handler `activateAfterLongPress`,
  200ms — `settings/drag-sort.tsx`). Maestro's `swipe` presses and moves at once,
  so the finger has to stay inside the touch slop for that long: measured on the
  Pixel 8 AVD, 3s and 6s swipes over ~250px never lifted the row and 15s did; the
  iPhone 17 Pro simulator lifted at 3s and still does at 15s. A swipe also takes
  only literal coordinates, validated when the YAML is parsed (`${…}` and
  percentages with variables both fail to parse), and its element-anchored form
  ends at 10% from the screen edge — inside the table's auto-scroll band, where the
  drop never lands. So `runner/hierarchy.ts` reads `maestro hierarchy`, finds the
  grip on the same row as the named rename field, and writes a one-command
  15-second swipe in the driver's own units (points on iOS, pixels on Android). A
  reorder is a vertical drag onto the target row's centre; a reparent is a purely
  horizontal drag two grips wide, which keeps the slot and projects the row one
  level under the row above.
- **Real time as the stimulus** (`LOCK-AUTORELOCK-001`). expo's lock provider
  relocks after 60s in the background, and there is no settled state to poll while
  the app is away and no simulator clock to advance. The runner waits 75s between
  the flow that backgrounds the app and the part that foregrounds it — rather than
  a flow spelling a minute as an assertion expected to fail.
- **Another client's write** (`SYNC-REFRESH-PILL-IOS-001`/`-ANDROID-001`). A
  separate web profile signs into the same account, saves a link and pushes it
  (`writeFromWeb`), so the device can learn of it only by pulling.
- **Bounds** (`SYNC-REFRESH-PILL-*`, `SYNC-LOCAL-TOP-001`). `runner/hierarchy.ts`
  reads a row's box (`rowBoxByText`, the widest node whose name carries the url)
  against the list's own (`links-list`). ⚠ **"In the tree" is not "on screen"
  here, on either platform:** FlashList keeps a prepended row mounted ABOVE the
  viewport, where every selector, `assertVisible` included, still finds it. The
  refresh-pill case compares one fixture row's box before and after the pull
  (it must be identical) and requires the pulled row to be unmounted until the
  pill is pressed, then painted inside the list within one row of its top.
- **Off the api and back** (`SYNC-CONFLICT-001`, Android only).
  `adb reverse --remove tcp:8787` is a device that cannot sync while Metro's 8081
  keeps serving the bundle; the runner restores the mapping after the case
  whether it passed or not. The iOS simulator shares the host's loopback, so
  there is no equivalent short of stopping the api under every other client.
- **Across a real share boundary** (`SHARE-*`). A host step opens Safari with
  `simctl openurl` or launches Android's exported `ShareActivity` with a real
  `ACTION_SEND`; committed Maestro parts make every assertion on the system
  sheet, the share tree, or the foregrounded app. On iOS the system row still
  needs the measured coordinate tap described in [share-sheet.md](./share-sheet.md),
  immediately followed by a `share-*` testID that only the extension renders.
  On Android the helper quotes each `adb shell` word before passing a multi-word
  subject, and the already-running case records the app PID on both sides of the
  share. The killed-app case removes only the API reverse while saving so the
  next launch has a real pending op to drain; cleanup restores it even after a
  failure. Cross-client proof signs a separate persistent web profile into the
  account and requires exactly one row after an explicit native sync.
  `SHARE-CREATE-001` is Android-only: after the first text edit in an iOS share
  extension, XCTest exposes Safari's tree and routes later taps there even while
  the extension remains painted. iOS still proves the real system handoff,
  existing taxonomy pickers, save, outbox drain and cross-client upload; the
  shared create state machine stays at component level. Do not replace the
  missing iOS gesture with screen coordinates and call it a pass.

#### accounts for a mobile run

Maestro cannot create one: every flow starts signed in, and a native
create-account flow would be a second copy of a form jest already covers. So
`runner/mobile.ts` provisions a throwaway account **through the browser for each
flow** and hands the credentials to `maestro test` as `-e` parameters. Accounts
are not shared across flows: a destructive or failed case cannot change the
starting state of the next case.

Two things are done to that account before the device signs in, while the
browser that created it is still open (`provisionAccount`'s `prepare`). A case
whose subject is a Plus lever — nesting, the search editor, locks — gets the
existing `manual` grant (`web/fixtures/plan.ts` over `seed/plan.ts`), so the
device's sign-in reads the entitlement; the web specs take the same grant. And a
`scale` case gets its paged library imported through Settings → Data and synced
(`web/fixtures/library.ts`), so the device pulls it on sign-in. The grant goes
through `wrangler d1 execute --local`, which retries `SQLITE_BUSY` and nothing else:
parallel web workers granting at once contend for the one local SQLite file.

That is not a shortcut around native key derivation — signing in on the device
runs the full Argon2id + HKDF path there, which is the thing under test. It is
also why the web fixture takes create-account's "Choose my own" branch rather than
the generated passphrase: a secret we chose can be passed along, one the app
generated would have to be scraped off a screen.

**The recovery code is the exception, and it has to be.** `recovery-sign-in.yaml`
needs one, and a recovery code cannot be chosen — it is CSPRNG-minted by the
client and never user-supplied by design (`crypto/recovery-code.ts`: "we GENERATE
it and never let users type their own"). So the mobile runner provisions the
recovery case with `withRecovery`, which takes the ceremony's recovery exit and
reads the code off the show-once panel by its `aria-label`. That is scraping a secret out of the DOM
— the thing the paragraph above avoids — but the preference there was
chosen-over-scraped, and here there is no chosen form to prefer. The code is
captured in its **display** form, hyphens included, because that is what a user
would have saved and what the flow should type back;
`normalizeRecoveryCode` strips the grouping before it is key material, so the
round trip is part of what gets exercised.

A recovery door is **additive** — the same account still signs in by password
identically (see [account.md](./account.md), _the doors_) — but the runner does
not reuse that fact as an ordering dependency. The contract runners provision
their own accounts without recovery.

Passwords and recovery codes are never written to the run manifest or command
metadata. They exist only long enough to pass the selected flow, and text
artifacts are redacted again after the case. Because the recovery-code input is
readable rather than masked, its automatic Maestro screenshots are deleted; the
named post-sign-in checkpoint is retained after the form has unmounted. Inspect
all remaining native screenshots before any upload. CI must upload only the
documented run directory after that review, never process environment or shell
history.

Contract legs live in `mobile/contract/`, outside the `mobile/flows/` glob, because
a parameterised leg run without its `-e` values fails on unset variables rather
than on anything meaningful.

#### the testID contract

What the flows bind to. These are an interface, not decoration: renaming one
breaks a flow silently — the YAML still parses, and the run fails as a timeout on
a missing element rather than as anything that names the cause.

All of them are in the app:

| testID                      | where                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `sign-in-username`          | `src/features/auth/sign-in-form.tsx`                                                |
| `sign-in-password`          | `src/features/auth/sign-in-form.tsx`                                                |
| `sign-in-submit`            | `src/features/auth/sign-in-form.tsx`                                                |
| `sign-in-error`             | ” — the submit-level `root` error                                                   |
| `sign-in-use-recovery`      | ” — the toggle into the recovery door                                               |
| `sign-in-recovery-username` | ” — `RecoverySignIn`                                                                |
| `sign-in-recovery-code`     | ” — `RecoverySignIn`                                                                |
| `sign-in-recovery-submit`   | ” — `RecoverySignIn`                                                                |
| `sign-in-recovery-error`    | ” — `RecoverySignIn`                                                                |
| `sign-in-use-password`      | ” — the toggle back out                                                             |
| `links-screen`              | `src/app/(app)/links/index.tsx` (a root marker)                                     |
| `links-open-navigation`     | `src/features/links/topbar.tsx`                                                     |
| `links-nav-list-<id>`       | `src/features/links/sidebar.tsx` — a drawer row                                     |
| `links-nav-tag-<id>`        | ” — the tag rows                                                                    |
| `links-nav-all`             | ” — Show All                                                                        |
| `links-more-options`        | `src/features/links/more-options-menu.tsx`                                          |
| `links-sync`                | ” — the Sync menu item (`syncNow`)                                                  |
| `links-open-settings`       | ” — the Settings menu item                                                          |
| `links-list`                | `src/features/links/main.tsx` — the FlashList, the viewport bounds are read against |
| `links-refresh-pill`        | `src/features/links/shared.tsx` — the "New updates" pill                            |
| `add-link-url`              | `src/features/links/link-add-panel.tsx`                                             |
| `add-link-save`             | ” — the submit, whose label flips Save→Confirm                                      |
| `add-link-optional`         | ” — the "List, tags & note" disclosure                                              |
| `add-link-list`             | ” — the optional fields, each named like its label                                  |
| `add-link-tags`             | ”                                                                                   |
| `add-link-note`             | ”                                                                                   |
| `add-link-cancel`           | ” — the explicit discard                                                            |
| `edit-link-title`           | `src/features/links/link-edit-screen.tsx`                                           |
| `edit-link-list`            | ”                                                                                   |
| `edit-link-tags`            | ”                                                                                   |
| `edit-link-note`            | ”                                                                                   |
| `edit-link-save`            | ”                                                                                   |
| `edit-link-cancel`          | ” — the explicit discard                                                            |
| `list-picker-search`        | `src/components/links/list-command.tsx`                                             |
| `list-picker-create`        | ” — the Create row                                                                  |
| `tag-picker-search`         | `src/components/links/tags-command.tsx`                                             |
| `tag-picker-create`         | ” — the Create row                                                                  |
| `tag-picker-rows`           | ” — the rows' scroller, for `childOf`                                               |
| `tag-picker-done`           | `src/components/links/tags-field.tsx`                                               |
| `link-options`              | `src/features/links/link-row-menu.tsx` — a row's ⋯                                  |
| `link-menu-<action>`        | ” — `edit` `pin` `unpin` `archive` `unarchive` `remove` `restore` `delete`          |
| `link-destroy-submit`       | `src/features/links/link-destroy-confirm.tsx`                                       |
| `links-title`               | `src/features/links/topbar.tsx` — the view the route projects                       |
| `links-search-toggle`       | ” — summons the search row                                                          |
| `links-search-input`        | `src/features/links/search-bar.tsx`                                                 |
| `links-search-clear`        | ”                                                                                   |
| `links-search-advanced`     | ” — opens the advanced sheet                                                        |
| `advanced-search-<field>`   | ” — `text-all` `text-any` `text-none` `url` `title` `note`                          |
| `advanced-search-submit`    | ” — also `-clear`, `-close`                                                         |
| `links-select-links`        | `src/features/links/more-options-menu.tsx` — enters bulk edit                       |
| `links-lock-app`            | ” — relocks the app                                                                 |
| `bulk-count`                | `src/features/links/bulk-edit-bar.tsx`                                              |
| `bulk-<action>`             | ” — `exit` `select-all` `copy` `move` `more` `remove` `restore` `delete`            |
| `bulk-menu-<action>`        | ” — `edit-tags` `pin` `unpin` `archive` `unarchive`                                 |
| `bulk-tags-save`            | `src/features/links/bulk-tags-dialog.tsx`                                           |
| `list-picker-rows`          | `src/components/links/list-command.tsx` — the rows' scroller, for `childOf`         |
| `list-menu-<action>`        | `src/features/settings/lists-section.tsx` — `move-to` `lock` `unlock` `remove-lock` |
| `app-lock-set`              | `src/features/settings/misc-section.tsx` — also `app-lock-remove`                   |
| `lock-dialog-<part>`        | `src/components/lock-password-dialog.tsx` — `password` `checkbox` `submit` `error`  |
| `app-lock-pane`             | `src/components/app-lock-gate.tsx` — the gate is up                                 |
| `list-lock-pane`            | `src/features/links/main.tsx` — a locked list's pane is up                          |
| `lock-pane-<part>`          | `src/components/lock-pane.tsx` — `password` `unlock` `error`                        |
| `settings-open-navigation`  | `src/features/settings/topbar.tsx`                                                  |
| `settings-close`            | ” — returns to the links route                                                      |
| `settings-nav-<section>`    | `src/features/settings/sidebar.tsx`                                                 |
| `extraction-mode-<mode>`    | `src/features/settings/extraction-section.tsx` — `off` `saves` `all` radio rows     |
| `extraction-count-<bucket>` | ” — the number in `done` `pending` `will-retry` `wont-retry`                        |
| `extraction-progress`       | ” — "N of M links previewed."                                                       |
| `extraction-generate-all`   | ” — also `extraction-pause`, which replaces it while the job runs                   |
| `delete-all-open`           | `src/features/settings/data-section.tsx`                                            |
| `delete-all-confirm`        | ” — the confirmation checkbox row                                                   |
| `delete-all-submit`         | ” — the destructive action                                                          |
| `delete-all-complete`       | ” — renders only after a successful wipe                                            |
| `delete-account-open`       | `src/features/settings/account-section.tsx`                                         |
| `delete-account-password`   | ” — the fresh-proof password re-entry                                               |
| `delete-account-confirm`    | ” — the confirmation checkbox row                                                   |
| `delete-account-submit`     | ” — the destructive action                                                          |
| `share-title`               | `src/features/share/share-specimen.tsx` — the payload title                         |
| `share-url`                 | ” — the normalized address                                                          |
| `share-add`                 | `src/features/share/share-screen.tsx` — the Save action                             |
| `share-list-row`            | ” — the current destination disclosure                                              |
| `share-tags-row`            | ” — the current tag-set disclosure                                                  |
| `share-saved`               | ” — the durable-save confirmation                                                   |
| `share-signed-out`          | ” — the no-session terminal state                                                   |
| `share-no-url`              | ” — the no-HTTP-URL terminal state                                                  |
| `share-quota`               | ” — the at-cap terminal state                                                       |
| `share-list-input`          | `src/features/share/share-list-picker.tsx`                                          |
| `share-list-create`         | ” — the new-list action                                                             |
| `share-tag-input`           | `src/features/share/share-tags-picker.tsx`                                          |
| `share-tag-create`          | ” — the new-tag action                                                              |
| `share-close`               | `src/features/share/share-kit.tsx` — the process/surface exit                       |
| `contract-vectors-pass`     | `src/app/contract-vectors.tsx` (dev-only)                                           |
| `contract-vectors-fail`     | ” — carries the failing check names in its text                                     |
| `vector-<check>`            | ” — one per vector, `PASS`/`FAIL`/`RUNNING`                                         |

The three `contract-vectors` ids are the one group NOT in the shipped app: the
screen returns a `<Redirect>` in production. Exactly one of `-pass`/`-fail` ever
renders, and neither renders while checks are still running, so a flow that
asserts the pass marker cannot pass by catching the screen mid-run.

The `share-*` group is the opposite special case: none of those ids is in the
main app route tree. Seeing one after Safari's system sheet or Android's
`ACTION_SEND` is the far-side proof that the dedicated share host mounted; a
successful system tap or `am start` status alone is not a pass.

The recovery-door ids are deliberately **distinct** from the password ones rather
than shared. The two modes never mount together, so reuse would work — but the
flows read as prose, and `sign-in-recovery-submit` says which door was opened
where a second `sign-in-submit` would not. The two mode toggles are ids for the
same reason everything else here is: their labels are sentences ("Forgot your
password? Use a recovery code"), and a flow keyed to a sentence turns a wording
edit into a red run. The two error ids exist so the failure paths — a wrong
password, a wrong recovery code — have something legal to assert on; the message
text itself is copy.

The `links-nav-*` group is derived from the row's SELECTION, not its label, and
the three system lists are the only ones a flow can name outright
(`links-nav-list-my-list`, `-archive`, `-trash` — `MY_LIST_ID` and friends in
`packages/shared/src/sync/system-lists.ts`); a user list or tag gets the same
shape around its uuid. Two reasons, and the second is the load-bearing one.
Every label here is renameable user data — even the system three
(`settings/lists-section.tsx`). And with the drawer open, the links topbar is
still in Android's hierarchy behind it showing the current list's name, so
`tapOn: 'My List'` is ambiguous there and resolves to the node underneath:
[app-drivers.md](./app-drivers.md), _a text match can resolve to a node under the
drawer_.

A user list or tag row is reached without knowing its uuid by requiring BOTH
halves on one element — `id: 'links-nav-list-.*'` (Maestro's `id` is a regex) and
`text:` the fixture's name. The pair cannot resolve to the topbar title, which
carries the name and no id, and the flows use it wherever a list they created is
the destination (`link-editor.yaml`).

**The editor field ids exist because the fields' names repeat their labels.**
Every native editor draws a muted `<Text>` label over each control, and the
control's accessible name starts with the same word — measured on iOS, the add
panel exposes a `List` label node ahead of the `List: …` combobox, and a `Note`
label ahead of the textarea — so `tapOn: 'List'` resolves to the label. The picker
ids are FIXED rather than props: every host (both editors, the move-to and bulk
dialogs) mounts one picker at a time, which is the same bargain the share sheet's
`share-tag-create` makes. Tag rows inside a picker take no id; they are checkboxes
named by the tag, and a removal is scoped to the picker's rows with `childOf: {
id: 'tag-picker-rows' }` — required on Android, whose tree keeps the editor behind
the portaled picker, where the Tags trigger renders each chosen name as its own
text node; an unscoped tap on the name hit that node. The row menu's `link-menu-*`
ids are the drawer rule again: the menu is a portal over the list, and "Archive"
is also a drawer row and, once there, the topbar's title.

**A combobox's name carries its value.** The native `ListSelect` trigger was
named plain `List`, which overrode the child text, so neither VoiceOver nor a flow
could read which list a link was filed in. It now reads `List: Work / Reading`,
as `TagsField` already read `Tags: reading, work` ([accessibility.md](./accessibility.md),
_naming things that have no visible label_), and the editor flows assert the
persisted list and tags through those two names. A pin reaches the row's name the
same way: the pinned badge's label is folded into it ("…, journal.example.net,
Pinned"), so `link-lifecycle.yaml` asserts the pin on the row itself as well as
off the menu (`link-menu-unpin` replacing `link-menu-pin`). It did not for a long
time, and the flow read the menu alone: the label was an `aria-label` on an icon,
which react-native-svg drops ([accessibility.md](./accessibility.md), the note at
the top).

`add-link-save` is the sharpest case for why these are ids and not text: its label
is `Save` until a malformed/duplicate/trashed warning relabels it `Confirm`, so
there is no stable string to tap even setting the rule aside. The URL field also
carries `aria-label="URL"`, which is not a substitute — see below.

What the flows do bind to by name is an **accessible label**, never body copy:
`add-link.yaml`'s `tapOn: 'Add link'` resolves to the FAB's `aria-label`
(`add-link-fab.tsx`), which is why that one needs no id.

**A `testID` and an `aria-label` are different jobs; the sign-in fields needed
both.** They were `Input`s whose only label was a visually adjacent `<Text>`, with
no `aria-label` and no association — RN has no `<label for>` — so VoiceOver
announced an unnamed text field. That is the same class of miss
[accessibility.md](./accessibility.md) exists to catch, and it is why "an
unlabelled control is untestable as well as inaccessible" is the framing above
rather than a slogan. The fields now carry `aria-label` and `aria-invalid`
alongside their ids, matching `new-password-field.tsx`.

### cross-client sync

Hub and spoke, not a complete graph: every client writes, at least one
independent client reads, and both native platforms run the frozen vectors and
both web ⇄ mobile directions. The contract legs keep ONE registry id each across
iOS and Android (`CONTRACT-*-001`, with both platform traits); a result line
names its platform from the run manifest.

| case                                         | client that writes → client that reads                     |
| -------------------------------------------- | ---------------------------------------------------------- |
| `CONTRACT-WEB-MOBILE-001`                    | web → iOS, web → Android                                   |
| `CONTRACT-MOBILE-WEB-001`                    | iOS → web, Android → web                                   |
| `EXT-SYNC-001` / `-002`                      | web → browser extension, browser extension → web           |
| `SYNC-REFRESH-PILL-WEB-001`                  | web profile → an engaged web profile                       |
| `SYNC-REFRESH-PILL-IOS-001` / `-ANDROID-001` | web profile → an engaged native list                       |
| `SYNC-CONFLICT-001`                          | web ⇄ Android, both offline, on one link                   |
| `SYNC-BLOCKED-001`                           | web → the server's quota gate → an independent web profile |

**The refresh pill is reached through the ⋯ menu's Sync, and that is the
point.** The only non-local trigger a mounted list has is a user's request — no
timer or focus event runs a cycle — so the case's pull is the path a real
reader takes, and it caught that path promoting past the pill
([client-queries.md](./client-queries.md), _the staged snapshot rule_).

**`SYNC-CONFLICT-001` proves the documented LWW result, not a merge.** The device
reconnects first and pushes its title; the web profile reconnects second, finds
the server changed since its base, resolves local-wins, and pushes over it
([local-first-sync.md](./local-first-sync.md), _conflict policy_). Both clients
end on the web title; the device's edit is the one the policy drops, and the
case asserts it is gone from the device after a pull. The conflict matrix itself
(fast-forward vs conflict, apply-time re-reads) stays at unit level. The device's
push is read off Settings → Data ("Last synced" with nothing waiting), because
the ⋯ trigger's name reads the same during a cycle as after one.

⚠ **`SYNC-BLOCKED-001` fills a real account with real bytes, and nothing lowers
the ceiling for it.** Eleven 10 MiB preview files (`web/fixtures/heavy-library.ts`,
random so they cannot compress) against the free plan's 100 MiB: content puts
drain before metadata puts and the gate reads usage as it stood before each sign
batch, so the one content chunk lands and the links behind it are refused. The
case asserts the Data card's storage-full sentence and the ⋯ trigger's "storage
full" name, that neither turns into "Sync failed" after a retry, and that an
independent profile never receives the refused links. It ends by deleting all
data, which is the only thing that gives the local R2 its 110 MiB back — a run
that FAILS before that line leaves them in `apps/bracemark-api/.wrangler/`.
Writing the size map directly, or a test-only ceiling, would prove the UI
against a state the server never reached.

### running it

Everything needs Metro and an installed Expo development build except web. The
API/web/extractor stack is additionally required by every `online` native or
contract case; frozen vectors are the exception because they have no account or
server. Web starts the stack when the ports are free. Native runners require it
already running:

```sh
npm run dev # api :8787, web :3000, extractor :8788
```

Every entrypoint now owns a preflight. Web resolves existing listeners on 3000
and 8787 to their process cwd before Playwright may reuse them; CI disables
server reuse completely. Playwright starts or reuses the web and API legs
independently, so an orphaned same-checkout Next listener cannot prevent the
missing API from starting. Native resolves Metro in the Expo dev-client link,
requires it to report a running packager from this checkout, and records the
link and all stack origins. It also requires the selected device to be booted,
the development build to be installed, and Android to have completed boot with
the 8081/8787/8788 reverse mappings. A failed preflight happens before account
provisioning.

```sh
npx nx e2e-web @stxapps/e2e
npx nx e2e-web:headed @stxapps/e2e
npx nx e2e-web:report @stxapps/e2e
npx nx e2e-extension @stxapps/e2e

# Exact ids come from `xcrun simctl list devices booted` or `adb devices`.
npx nx e2e-mobile @stxapps/e2e -- --platform ios --device <udid> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform ios --device <udid>
npx nx e2e-mobile @stxapps/e2e -- --platform android --device <serial> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform android --device <serial>
```

Platform and device are mandatory and are passed to every Maestro invocation.
Having both platforms booted is no longer ambiguous, though the full legs should
still be run serially because they share the local stack and are intentionally
expensive. The vectors case remains first in a full contract run. Run it alone
with `--case CONTRACT-VECTORS-001`.

The four targets also have root scripts — `npm run e2e:web`, `e2e:extension`,
`e2e:mobile`, and `e2e:contract`. There is deliberately no bare `npm run e2e`: no honest fan-out
can boot, build, select, and prepare both native platforms. `expo:ios` and
`expo:android` are prerequisites, not tests; see [expo-build.md](./expo-build.md).
On Android, run `npm run expo:android:reverse` after each emulator boot.

#### cases, suites and fixtures

[`e2e/cases.json`](../e2e/cases.json) is the machine-readable registry. Every
case has an id, surface, primary `smoke`, `full`, or `release` tier, traits,
fixture size, path, and expected artifacts. `npm run check:registry -w
@stxapps/e2e` rejects duplicate ids, missing paths, and tag drift. Ids are unique
**per surface**: a journey proven on web and on native (`LINK-CLOSE-001`) keeps one
id on both entries so their results line up, and every runner selects within its
own surface, so one invocation never picks up both. Automated
`full` includes smoke and full but never release qualification; `smoke` selects
only smoke. `--case`, `--include-trait`, and `--exclude-trait` are repeatable or
comma-separated and work across the wrappers:

```sh
npm run e2e:web -- --suite smoke
npm run e2e:web -- --case WEB-LINK-001
npm run e2e:extension -- --case EXT-AUTH-001
npm run e2e:mobile -- --platform ios --device <udid> --exclude-trait destructive
```

[`e2e/fixtures.json`](../e2e/fixtures.json) defines the fixture sizes: `empty`
(the normal fresh account), `small` (the minimum multi-entity journey state),
and `scale` (an archive generated from
`e2e/seed/library.ts` and imported into a fresh account). No test uses the human
seed accounts or the published-capture account. Offline deterministic links use
the reserved `.invalid` TLD; a case that deliberately exercises extraction must
carry the `internet` trait and use the separate public fixture table in that file
(_what e2e may not assert_, above). The registry check enforces that every entry
in that table is `https` and tagged `internet`.

#### ⚠ one IP, one bucket — the local rate limit

`bracemark-api`'s baseline limiter buckets by **IP + path** (`middleware/rate-limit.ts`,
the `standard` tier). In production that sizes a bucket for one user. Locally
every client is `127.0.0.1` — both Playwright workers, every tab a case opens,
the browser extension, both simulators — so the whole machine shares one bucket
per path, and `/v1/iap/status` carries no query string, so they all collide on a
single key. The deployed 60 req/60s is therefore **deliberately raised to 6000 in
the `development` env only** ([`wrangler.jsonc`](../apps/bracemark-api/wrangler.jsonc)).
Do not lower it back to match the deployed tiers for realism: a full web run
429s, and nothing in the resulting failure says "rate limit". The binding stays
wired rather than removed so the middleware path and the env's shape still match
the deployed tiers; the 429 envelope and the client backoff are proved at unit
level (`app.spec.ts`, `middleware/rate-limit.spec.ts`, shared `api/retry.spec.ts`),
never here.

Two specimens, both from one run (web, 2026-09-18, the 23 then-existing cases),
and both disguised:

- **A dialog that opens — the wrong one.** `LOCK-APP-001` took 8× 429 on
  `/v1/iap/status`, so `useEntitlements` never left `FREE_SUBSCRIPTION_STATUS`.
  A Plus-gated control renders on the free plan too; it just opens the paywall.
  The trace shows a click that landed and a dialog that opened, and the page
  snapshot shows the upsell — nothing anywhere names the plan.
- **A wipe that looks hung.** `WEB-DATA-001` took 5× 429 on `/v1/ops/list`. The
  api answers `Retry-After: 60` and the client half honours the hint (shared
  `api/retry.ts`, four tries), so a single 429 parks that call for 60–75s; and
  `deleteAllData` awaits the in-flight cycle _before_ its own server call, so the
  receipt sits behind minutes of backoff while the spinner says "Deleting all
  your data…". Raising the case's expect timeout chases a backoff window rather
  than the wipe and cannot win — 60s was tried, and did not.

Both passed alone throughout, because one case never fills a bucket. A red suite
whose cases are individually green is this until proven otherwise.

#### ⚠ granting Plus is two steps, and the second one is silent

`grantPlus` ([`web/fixtures/plan.ts`](../e2e/web/fixtures/plan.ts)) writes the
`manual` purchase row to local D1 and verifies it landed. That is the server
half only. The client still has to fetch `GET /v1/iap/status` and honour it —
deliberately, because the alternative is priming the cache and proving the UI
against a state no client ever reached.

So **a web case calls `grantPlusAndLoad(page, username)`**, never bare
`grantPlus`. It grants, loads `/links`, and blocks until that client holds Plus.
Three details are what make it a wait rather than a `reload()` and a hope:

- `subscriptionStatusQueryOptions` holds a **5-minute `staleTime`**, so a client
  that already answered `free` never re-asks on its own. Only a fresh document
  gets a fresh queryClient. Before this existed, two of the five call sites had
  a hand-rolled `page.reload()` and three had nothing.
- It waits on the **persisted last-known copy**, not on the response, because
  `writeCachedStatus` runs in the hook's effect — which only happens after React
  has rendered with the fresh value. A `waitForResponse` resolves one render
  early, and one render early is the entire window.
- `awaitPlus` is module-private. The failure being closed here is "someone
  forgot the second call", so there is exactly one entry point.

The native runner keeps calling bare `grantPlus`: it grants **before** the device
signs in, so that device's first status fetch already carries the plan.

#### artifacts and retries

Every invocation gets `.artifacts/runs/<run-id>/`. Web and browser extension
write their HTML report, failure screenshot, retained failure trace, command,
and run manifest there. The extension manifest also records bundled Chromium,
the staged permission differences, and that the toolbar grant was not proven.
Native writes a secret-free run manifest plus per-case JUnit, Maestro
manifest/commands/logs/screenshots, named stable checkpoints, sanitized command
metadata, and an accessibility hierarchy when a case fails. The manifest names
the platform, device/model/OS, Maestro, installed app build, Metro URL, stack
origins, checkout commit, selected cases, and timings.

Playwright still retries once to retain diagnostic evidence, but
`failOnFlakyTests` makes a pass-after-retry exit red. Videos remain off until a
case specifically owns motion or system chrome. Passing local artifacts are
disposable; keep failures until resolved. Never upload environment dumps or
shell history, and inspect native screenshots before uploading a run because a
device can paint user input that text redaction cannot see.

Open the latest web report with `npx nx e2e-web:report @stxapps/e2e`; traces and
native evidence live below the run directory printed by the wrapper. Test
passwords and recovery codes are not persisted, so a failed throwaway account
is intentionally not reusable.

Local api state lives in `apps/bracemark-api/.wrangler/`. Nothing resets it, on
purpose: a throwaway account per worker is cheaper and less brittle than clearing
that directory, and it means two runs never contend for the same rows.

### seeding a dev account

`e2e/seed/` is not a test. It is `init` for a session of looking at the app by
hand: four accounts on the local stack, two of them with a full library, so
"Show more", the list/tag tree, filtering, drag-and-drop and the search editor
have something to work on without anyone typing 190 links into a form.

```sh
npm run dev            # the stack, as always
npm run seed:accounts            # all four accounts
npm run seed:accounts -- free-full   # or just one
npm run seed:fixtures            # the archives only — no browser, no api
```

⚠ **`seed:accounts` regenerates the archives itself; it does not consume
`seed:fixtures`' output.** They are derived from `seed/library.ts` and cost
milliseconds, so a stale zip on disk is a trap with no upside — it would import
yesterday's library and report a clean run. `seed:fixtures` exists to let you
LOOK at what is about to be imported, or to hand the file to an account you
already have, not to be step one of a pipeline.

Credentials land in `e2e/credentials/accounts.json` (gitignored, and **not**
under `.artifacts`: they outlive the run that made them, so clearing run output
must not take them with it). The catalog:

| key          | username          | plan | library                                    |
| ------------ | ----------------- | ---- | ------------------------------------------ |
| `free-empty` | `seed_free_empty` | Free | nothing — the first-run screens            |
| `plus-empty` | `seed_plus_empty` | Plus | nothing — paid, and still empty            |
| `free-full`  | `seed_free_full`  | Free | 190 links, 8 flat lists, 14 flat tags      |
| `plus-full`  | `seed_plus_full`  | Plus | 1,000 links, 24 nested lists, 40 flat tags |

#### the split down the encryption boundary

The seed is two mechanisms, not one, and which half does what is forced:

- **The library goes in through the app.** Links, lists, tags and pins are E2E
  encrypted — bracemark-api holds AES-GCM blobs it cannot read (_crypto
  boundary_, [local-first-sync.md](./local-first-sync.md)) — so there is no
  database to seed them into. The only writer that can produce them is a
  signed-in client holding the key. So `seed/library.ts` generates the entities,
  `seed/archive.ts` packs them into a real Bracemark backup, and the seed picks
  that file in Settings → Data → Import. It lands through `bulkWriteEntities`
  like any other local edit ([data-lifecycle.md](./data-lifecycle.md)).
- **The plan goes in through D1.** A subscription is the opposite: plaintext
  server state. `seed/plan.ts` writes a `manual` purchase row with a null expiry
  — the source that already exists for comps and lifetime grants — via
  `wrangler d1 execute --local`. Nothing test-only was added to bracemark-api to
  make this work, and `needsRefresh` skips `manual` rows because there is no
  provider to ask ([iap.md](./iap.md)).

Accounts are still created through the real create-account form, Argon2id and
all: the rule in `web/fixtures/account.ts` — there is no seeding shortcut and
there should not be one — holds here too. The only thing the seed adds is
`launchApp`'s `create` option, which chooses the credentials instead of minting
throwaway ones, because these accounts are meant to be signed back into tomorrow.

#### four things that will surprise you

- **Re-seeding does not update an account that already exists.** A backup merge
  is skip-existing **by path**, so an account seeded before you edited
  `seed/library.ts` keeps its old entities. That is the right behaviour for a
  restore and the wrong one for iterating on a fixture: use Settings → Data →
  Delete all data first, then re-run `seed:accounts`. Re-running with no edits is
  a genuine no-op, which is what makes a half-finished run safe to repeat. (The
  shot account answers the same trap with a flag — `shot:account --fresh` —
  because its fixture is a hand-edited URL list that changes more often.)
- **The seed waits for sync, and must.** An import lands in Dexie and pushes in
  the background, and the browser profile is deleted when the run ends. Close
  early and the account exists, the plan is granted, and the library is nowhere —
  an empty account with nothing to explain it. The wait reads the Data section's
  own sync row and requires the settled reading three polls running, because both
  halves of it can lie for one frame after a navigation.
- **The free library is 190 links, and that is not a round number by accident.**
  Free holds 200 and a backup over the cap is refused **whole** (the
  take-what-fits prompt is the interop path only), so the fixture is sized under
  it with room to add a few by hand and watch the create surfaces refuse.
- **The free trees are flat**, because that is what a free account that never
  imported looks like, and the fixture is for exercising the create surfaces. It
  is not the only reachable shape: a backup restores `parentId` verbatim on any
  plan and an import builds the tree its folder paths name, so a nested free
  account is a state the product does produce — the one a downgrade or a
  migration leaves behind. Seed that deliberately if it is what you are testing.

#### what the generator guarantees

Everything you would search for or point at is a pure function of the account
key: ids (`seed-link-0042`, `seed-list-00` — readable on purpose, they show up in
URLs), urls, titles, tags and list membership are identical on every machine and
every re-seed. Topics and hosts are assigned round-robin, so the distribution is
predictable rather than merely plausible — a thousand-link library holds 41 or 42
links per topic, and "rust" is a number you can count, not "some results".

Timestamps are the one exception: they walk backwards from the moment you seed,
so the library reads as one someone has been keeping. Every state worth seeing is
deliberately represented — links in Trash and Archive, a failed and a permanent
extraction (both render `host(url)` with a monogram), a user `customTitle` over an
extracted title, notes, pins spread through the library rather than sitting on
top, and a generated preview image on every third link so the `files/` half of the
backup format is exercised at all.

### the published screenshots

`e2e/shot/` is the seed's odd cousin, and sits beside it rather than inside it: a
fifth account whose only job is to be photographed — `npm run shot:account` makes it,
three `shot:*` legs photograph it. Everything this project publishes a picture of
the product for is made here — the marketing site's one figure (the links page under "A private
library is still a library"), the screenshots `apps/bracemark-web`'s
`manifest.json` hands Chrome's install dialog, and the browser extension's Chrome
Web Store and AMO listings, and the native captures used to compose the App Store
and Play Store phone listings.

**ONE PRODUCER, THREE CONSUMERS, and they do not share a browser.**
`shot/account.ts` builds the account — import, plan, extraction drain, synced
settings — and nothing else photographs anything. Then `web.ts` drives
bracemark-web through `launchApp` and system Chrome; `extension.ts` drives the
browser extension's popup, and has to launch Playwright's own Chromium with an
unpacked build (_the browser this repo drives_, above); `mobile.ts` drives the
native app with Maestro on exactly one booted platform. The three consumers share
the account and nothing else — a prerequisite rather than a coupling: each signs
in, and each refuses to run against an account `shot:account` has not built, naming
it in the error.

```sh
npm run dev              # api + web + extractor (the extractor is the point)
npm run shot:preflight   # check the URL list — seconds, no browser
npm run shot:account        # the account: import → extract → previews → sync
npm run shot:account -- --fresh   # …after wiping the account's data first
npm run shot:web         # every web scene
npm run shot:web -- library-narrow search-narrow   # …only these
npm run shot:ext         # the browser extension's popup
npm run shot:ext -- ext-sync                   # …only this PNG (the flow still runs whole)
npm run shot:mobile -- ios      # four native iPhone captures
npm run shot:mobile -- android  # four native Pixel captures; boot it separately
npm run shot:mobile -- ios --fresh             # …wiping the device first (see below)
```

**Why the whole thing is a folder of its own.** It was `seed/shot/` until the
split made the cost visible: `seed/` is the DEV-ACCOUNT seed — four accounts a
human signs into — and this is an asset pipeline that happens to need an account,
which is why the paragraph above has always had to call it a cousin. Now `seed/`
holds only what `seed:fixtures` and `seed:accounts` need, and `shot/` holds the
fixture (`library.ts`, the 26 URLs), what to photograph (`scenes.ts`), the
producer and the four legs — and the producer stays with them because every leg
imports `./library`: moving it alone would have separated one thing from itself
and left the two folders importing each other.

**Every entry point's path is its target with a slash for the colon**, which is
the rule the move bought and the reason `seed:shot` became `shot:account`:

| target           | file                |                                       |
| ---------------- | ------------------- | ------------------------------------- |
| `seed:fixtures`  | `seed/fixtures.ts`  | the four backup archives              |
| `seed:accounts`  | `seed/accounts.ts`  | the four dev accounts                 |
| `shot:preflight` | `shot/preflight.ts` | check the URL list                    |
| `shot:account`   | `shot/account.ts`   | build the account the pictures are of |
| `shot:web`       | `shot/web.ts`       | the site figure + the PWA scenes      |
| `shot:ext`       | `shot/extension.ts` | the browser extension's popup         |
| `shot:mobile`    | `shot/mobile.ts`    | the native store captures             |

`shot:ext` is the one abbreviation. Nothing else needs remembering: `seed/` is the
dev accounts, `shot/` is the published pictures, and the four `shot:*` legs after
`shot:account` are the pipeline in the order you run them.

**Why the producer is its own step.** It is minutes of real network and the same
minutes whatever is being photographed, so a re-capture after a viewport moved by
40px should cost the screenshot and nothing else — and before the split it cost
the whole drain, because the only entry point that could photograph the web
scenes also rebuilt the account. The split also puts `--fresh` where the wipe
belongs: on the thing that owns the account, not on three legs that merely look
at it. **There is deliberately no bare `npm run shot`**, for the reason there is
no bare `npm run e2e` (_running it_, above): the three consumers have different
prerequisites — a booted simulator, Playwright's Chromium, one platform at a time
— so a script that fanned out to all of them could only fail in the middle.

Out comes one PNG per scene in `e2e/.artifacts/shot/`, and for `library-list` the
run also prints the `tools/scripts/make-image-variants.sh` line that turns it into
the `.webp` variants `SCREENSHOT` in `apps/bracemark-site/src/app/page.tsx` points
at. The mobile runner freezes the platform status bar, captures three app scenes
plus the real platform share surface, verifies the native raster, and restores
the status bar. Run iOS and Android separately: iOS uses Safari plus the share
extension; Android uses Chrome behind `ShareActivity`. These are raw captures,
not finished store canvases.

**The mobile leg restarts the app; it does not wipe it.** `mobile/shots/store.yaml`
goes through `shots/subflows/start.yaml` rather than straight to
`flows/subflows/sign-in.yaml`, and the difference is `clearState`. The wipe is
load-bearing for the REGRESSION flows — they run as a directory and each has to be
state-independent (_launchApp resumes_, above) — and inherited baggage here: this
leg runs two flows in one order against a durable account, so the wipe only buys
the landing screen, Argon2id on the device, and a first sync of the whole library
plus a favicon per host, every run, to reach the state the device was already in.
So: `stopApp`, `launchApp`, and the session comes back with it (it lives in
expo-secure-store + expo-sqlite, which `flows/sign-in.yaml` is the regression for).
If no session comes up — a device that has never run this — the subflow falls
through to the cold path by itself, so a first run needs no special invocation.
The warm start is also the better picture: the favicon cache is device-local, so
the icons are on disk before the capture and the half-loaded icon column below
cannot happen.

`--fresh` is the one case that wants the wipe back: the run straight after
`npm run shot:account -- --fresh` rebuilt this account's data, where a warm device would
otherwise photograph the library it already held while sync caught up. It is a
runner flag rather than a flow `env:` default because — measured on Maestro 2.8.0
— a flow-level `env:` value **beats** `-e` from the command line instead of
yielding to it, so a default would have made the flag a silent no-op.

⚠ **Android's frozen status bar is entered with `exit` first, and the reason is a
leak that outlives the run.** SystemUI demo mode is not idempotent the way the
broadcast makes it look: `enter` builds its `DemoStatusIcons` only when there is
not one already, so a second `enter` moves nothing and cannot repair a container
that has gone wrong. One goes wrong on any CONFIGURATION CHANGE — a density,
font-scale or theme change reaches `StatusBarIconControllerImpl
.onDensityOrFontScaleChanged` → `refreshIconGroups()`, which destroys and re-adds
every icon group while `mIsInDemoMode` is still true, because `destroy()` is only
`mGroup.removeAllViews()` and the demo container hangs off the group's parent. The
wifi holder coming back then calls `DemoStatusIcons.addModernWifiView` a SECOND
time; it de-dups nothing and overwrites its own reference, so the first view is
orphaned in the container, still drawn, and the removal path can never reach it
again. **The status bar carries two wifi icons** from then on, in every capture,
and nothing in the run fails — a picture of a device the emulator is not.
Measured on the API 36 emulator: one extra icon per config change, a `font_scale`
write taking the collapsed bar 1 → 2 → 3 and the shade header with it. Demo mode
also outlives an interrupted run, `clearStatusBar` reaching the device only from
`main`'s `finally`, so the count is INHERITED by the next run. `freezeStatusBar`
therefore sends `exit` before `enter` — the one command that tears the container
down — after the `sysui_demo_allowed` write, since an unavailable
`DemoModeController` drops commands rather than queuing them. iOS needs no
equivalent: `simctl status_bar override` sets state, it does not build views.

⚠ **The mobile leg needs `deviceExtractionMode: 'all'`, and the reason is not
extraction.** Favicons are the one enrichment that never syncs
([link-extraction.md](./link-extraction.md), _favicons: a device-local host
cache_), so the titles and covers the web run wrote reach the phone and the icons
do not — the device has to guess `https://{host}/favicon.ico` itself, and expo
gates that guess on the mode reaching `all`. Every link on this account arrived by
sync, so the shipped `saves` default does not cover them either: the captures ran
for a while with the mode at `off` and produced a column of real covers beside a
column of empty chips, which is what a half-loaded app looks like. The value is
seeded in `shot/library.ts` rather than clicked the way `serverExtraction` is
— it is in no plan, so there is no grant to prove, and it has no device-local
override, so the synced value wins outright. On this account it costs nothing:
`all` arms the drain, but the web capture has already resolved every facet, so the
drain finds no work and the only requests are six favicons. Two consequences worth
knowing before reading a capture. It photographs an **opt-in** state, deliberately,
exactly as the site's figure does with `serverExtraction`. And `standardebooks.org`
serves no `/favicon.ico` at all (it declares a PNG instead), so row 3 wears the
quiet plate on the phone and in the figure alike — one cause, the deferred
`faviconUrl` step in the extract contract, and not something a different URL fixes.

**`scenes.ts` is WHAT, `web.ts` is HOW, and the split is the point.** The
account, the import, the extraction drain and the waits are one apparatus every
picture needs; the only things that vary are a viewport, a URL and what "finished"
means on that screen. A scene declares `viewport`, `scale`, `goto`, an optional
`prepare` and a `settle`; the file it produces is `<id>.png` at `viewport × scale`
device pixels. Nothing in `e2e/` knows where a picture ends up.

⚠ **A scene's geometry is a contract with something off-stage, and nothing in this
repo checks both ends.** `library-list` answers to the marketing site:

| where                   | what                    | why                                                                                                                                       |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `viewport.width` = 1000 | the capture's CSS width | sets the type size in the figure (1088/1000 ≈ 1.09x) **and** the air between a title and the date column, which grows straight with width |
| `viewport.height` = 760 | `56 + 6*107 + 62`       | six whole rows, the seventh cut past its host line and before its tags                                                                    |
| `aspect-[25/19]`        | the frame, in page.tsx  | the capture's own ratio, so `object-cover` crops nothing                                                                                  |

Move one and the other two are wrong — silently. A frame that no longer matches
the capture just starts slicing the bottom row somewhere ugly, and a width change
re-scales every glyph in the picture. `scale: 3` is the odd one out and is **not**
a design number: `make-image-variants.sh` refuses to upscale and the site ships a
2200px variant, so a 1000px-wide capture has to be rastered at 3x to feed it. That
is why `launchApp` takes a `deviceScaleFactor` at all.

The `library-{narrow,wide}` and `search-*` scenes answer to the **install dialog**
instead, and their contract is stricter: each is exactly one of the two PWA sizes
(1170x2532 narrow, 2560x1600 wide), the compositor refuses a capture whose pixels
disagree with the size it expects, and `npm run check:assets` refuses a
`manifest.json` that declares a size the file does not have. What each size is and
why is `docs/brand-assets.md`, _the generated pictures_.

`library-window` answers to a **store listing**, and its width is the contract:
1152 CSS px is the content width of the browser window the compositor draws
around it, so the capture lands at 1:1 and the app's own type is never resampled.
Its height is deliberately more than the frame shows — the window runs off the
bottom of the picture the way the card's pane does. DPR 2 rather than 3, because
this one is composed into a 1x canvas and a third raster would be thrown away.

⚠ **One launch per DPR.** `deviceScaleFactor` is a **browser-context** option, not
a page one, so scenes at different `scale` cannot share a launch — `web.ts`
groups on it and calls `launchApp` once per group. Setting it per page does not
fail; it silently photographs everything at the first context's density.
`page.setViewportSize()` per scene _within_ a group is fine, which is why the
viewport is the thing that varies freely and the scale is not. The account setup
runs on the first group only; later groups sign back in and wait for the pull,
which is why `prepareAccount` ends on a `waitForSync` — a half-pushed library is a
partial one to the next context.

#### the browser extension leg

`shot/extension.ts` photographs the popup for the two store listings. Three
of its rules are silent ones — each is a way to get a picture that renders
perfectly and shows the wrong thing.

⚠ **The popup is photographed as a TAB, and a tab cannot see the tab behind it.**
The real popup window is not attachable: `chrome.action.openPopup()` opens
something that never enters `context.pages()` and fires no `page` event, and the
OS route needs a screen-recording grant. A tab at 360 CSS px lays out identically
(the browser sizes that window to the document, so 360 is the whole viewport
either way), which is what makes the leg possible. But `SaveFlow` reads
`tabs.query({ active: true, currentWindow: true })`, and the manifest is
`activeTab`-only **by design** — the grant is created by the user's click on the
toolbar action, which no harness can perform. Without it the query returns a tab
with its `url` and `title` stripped, `SaveFlow` finds no saveable page, and what
gets photographed is **"Nothing to save here"**.

So the leg **stages a copy** of the build with `tabs` added to its permissions and
loads that. It is a copy, in `.artifacts/`, rebuilt every run; `.output/` and the
source are untouched and no store sees it. The alternative — faking `tabs.query`
with `addInitScript` — was refused on the same principle the rest of this
directory runs on: it would make the harness author the one thing the picture is
of. Here every string in the specimen is the browser's real answer about a page
that is genuinely open.

⚠ **It is the DEVELOPMENT build or it is pointed at production.** `nx build` is
`wxt build`, i.e. `api.bracemark.com`, which knows nothing about the local seeded
account. `nx build:development` is the same bundle with
`WXT_PUBLIC_API_URL=localhost:8787`; only that value differs, so the pixels are the
production build's. The leg runs it itself.

⚠ **Nothing is saved, and that is what makes the run repeatable.** The obvious
script — open the editor, press Save, photograph the receipt — works exactly once:
the save writes a link, so the next run opens on the "already saved" screen and
scene one silently becomes scene two. Instead the leg opens **two** tabs: a page
the library does not hold (the editor) and one it does (the receipt, by the
revisit path — the same component with the same content). Undoing a save would
otherwise mean deleting the link _and_ emptying the trash through bracemark-web,
in a second browser, to leave the account as it was found.

One consequence, worth knowing before trying to "fix" it: on the revisit path the
specimen's tile is the live tab's **favicon**, never the extracted cover. The
upgrade `Complete.tsx` describes belongs to the save path, where the extension
extracts the active tab itself; a link saved elsewhere carries an `imageId` whose
bytes the extension has not pulled (`sync-runner.ts` materializes `files/`
lazily). The leg asserts the tile is _an image_ rather than a host monogram, which
is the outcome that would actually look broken.

**It also drives the real pickers**, so the list and the tags in the picture are
chosen the way a person chooses them — and it waits for those popovers to
**detach**, not merely to close. They are Radix popovers with an exit animation:
`Escape` returns immediately, and a capture on the next line catches the panel
mid-fade, printing a ghost of the tag list straight through the Note field and the
Save button. Invisible in the diff and in the log; obvious in the picture, which
is how it was found.

**It photographs the LIST layout, and that is a step the card grid did not need.**
The swap is argued at the top of `web.ts` and in `SCREENSHOT`'s own comment.
`shot:account` sets it through the Settings → Misc radio (`useListLayout()`) because
`linksLayout` **syncs** and this account is reused, so one manual click in the app
would otherwise silently photograph cards on the next run — and `shot:web`
re-reads that radio before it photographs anything, since the seeding and the
capture are now separate runs and a human can sit between them. Set, once;
checked, every time.

⚠ **The shared seed helpers live in `seed/steps.ts`, and the reason is a silent
failure.** `seed/accounts.ts` and `seed/fixtures.ts` both end in a top-level
`await main()`, and only `fixtures.ts` was guarded on being the entry module.
While the shot run imported `importArchive`/`waitForSync` from the unguarded one,
that import **re-seeded all four dev accounts** before the capture started — no
error, no failed check, just the seed's own receipts in the log and ten wasted
minutes, because the seed is idempotent. The steps both seeds share now live in a
module that runs nothing, so neither seed imports the other; both guards stay as
backstops. A new top-level `await` in a module something imports is the same bug
again.

**It is not a fifth entry in `SEED_USERS`, deliberately.** `npm run seed:accounts`
fans out over that list, and this account does not belong in a dev session's 2x2: it exists
for one asset, its library is a hand-typed list rather than the generator, and —
alone in `e2e/` — it fetches real, public URLs off the machine it runs on. It has
its own entry point for all three reasons.

**Nothing in the picture is authored.** The archive carries twenty-six bare URLs,
their list membership and their tags, and no `extractions/` entities at all — absence
counts as pending, so every link lands in the drain's queue. The run then turns on
the `serverExtraction` opt-in through the real Switch, presses **Generate all**,
and waits for the section's own "N of N links previewed" before it photographs
anything. Every
title and every cover in the shipped image was fetched by `bracemark-extractor`
and written back by the client. That is the whole design: the band's claim is
about what the product looks like, and the placeholder it replaces is a labelled
box precisely because a convincing mock grid is the trap this site has fallen into
once already (the hero's hand-typed ciphertext).

**What is IN the library is decided by the hero paragraph, not by taste.** That
paragraph names the four things a saved library is a picture of — "what you are
reading, buying, worrying about and working on" — and the figure four screens
below it is the only place the site can show that being true. So the lists answer
it one for one: `Reading`, `Interview prep`, `Health`, `Shopping`, with everything
else as texture. It is a deliberately narrow test, because the loose version of it
("more personal categories, so the privacy point lands") admits `Invest` as
happily as `Health` and ends up arguing a different product. Two boundaries come
with it. `Health` goes as far as blood pressure, sleep and walking — what a person
reads after a routine checkup — and no further: a symptom, a diagnosis or a drug
name is a confession, and a confession makes a reader think the picture was
staged. And a **video** is not a candidate however far below the fold it sits,
because `shot:preflight` gates every URL in the file rather than the seven in
frame: an item that can be deleted, made private or fronted by a consent wall is
an item that can block every future capture.

**Four things that are load-bearing and look like details:**

- **The library is not `seed/library.ts`'s.** That generator speaks rust,
  Postgres, Kubernetes and WASM over `example.com` hosts, with a failed extraction
  every eleventh link and a preview image every third. All three are wrong here:
  fake hosts have no covers, a column two-thirds monograms argues against the band
  it sits in, and the vocabulary casts the user as a distributed-systems engineer —
  the exact repair `HeroPanel`'s comment records making, twice. The shot library is
  the hero's persona: an interview on Thursday, a checkup, a trip, a tenancy,
  dinner, a bike, a chair to replace, something to read.
- **The URL list is checked, not trusted.** `shot:preflight` asks the local
  extractor about every URL and fails on any that is not `ok` _with an
  `imageUrl`_ — a title-only result is a fine saved link and a bad row. It goes
  through the extractor rather than `curl` because the two disagree: a zone behind
  Cloudflare answers a Worker where it 403s a shell. Run it after any edit to the
  list. A URL that has 404'd or lost its og:image since costs one monogram in the
  column of covers, which is invisible in a diff and obvious in the shipped PNG.
  Only the top seven links are in frame, so an edit near the top of
  `SHOT_LINKS` is the one to re-check hardest. It then reports a second, **host**
  pass — `/favicon.ico` on each distinct host, which is a property the per-URL
  pass structurally cannot see, since a host can serve every page and og:image
  here perfectly and still have no icon at the guessed path. That one **warns
  rather than fails**: the hole is a 14dp plate rather than a monogram filling the
  row, the render path calls it a correct final state, and no edit to this file
  repairs it.
- **The drain is two mechanisms, and each has a way of looking finished when it
  is not.** `Generate all` starts it — the auto drain would not, being
  displayed-scoped, visibility-gated and budget-capped by design (web-react's
  `ExtractionProvider`), where extract-all is the one mode that is finite rather
  than attention-bounded. But `extractAll()` is client state on the provider, so
  **a full page load ends the job**: a first version of `fillPreviews` polled by
  re-visiting the settings page every thirty seconds, cancelling the drain on
  every pass, and sat at zero previewed while the log read like a slow network. Phase
  one therefore stays on the page it started on and watches the Pause button
  disappear. Then phase two, for a different failure: a link whose fetch fails
  _transiently_ (a slow site against the extractor's 8s per-hop timeout, or a 429
  from its own per-IP cap during the image pass) gets a `failed` facet, which
  leaves the pending bucket at once and does not come back for
  `backoff(attempts)` — ten minutes, doubling. The screen then reads Pending 0,
  **Generate all disabled** (it gates on the pending count), two cards blank:
  settled-looking, and not settled, with no button to press. Only the auto drain
  retries it, and only for rows it can see — the list is virtualized, so a
  failure below the fold is never re-scanned while the run parks at the top.
  That stuck three short of the library and looked exactly like a bad URL list.
  Phase two walks the whole list, which is the gesture the provider's cost model
  is built around.

  **And the bug that hid behind both of those.** "Generate all" is
  `disabled={pendingCount === 0}`, where `pendingCount` comes from the same
  on-demand liveQuery — which has no result for the first moment after the
  section mounts. Sampling `isEnabled()` there reads the button as disabled
  because the count is _unknown_, not because there is nothing to do, so the
  click was skipped, extract-all never ran, and phase two's scrolling dragged the
  whole library in by itself. It still finished, which is why it survived a dozen
  captures: the only symptom was `previewed 0/25` logged between two phases that
  both appeared to work, and the shortfall it produced was misread for a while as
  the extractor's per-IP cap. Read the progress line BEFORE the button — waiting
  for the line is waiting for that query to answer, so the button's state means
  something by the time it is read. With the click actually landing, a clean run
  previews the whole library in one pass and finishes in under a minute.

- **The rail is a height budget, and adding a list spends it.** The frame is
  760px tall: the lockup takes 56 and the filter box 40, the Lists header 34, and
  every row after that is 32 with a 2px gap. The system three (My List / Archive /
  Trash) plus ten of ours make 13 rows and fill it to about 604, which leaves
  **four whole tag rows** and a fifth cut through — where the eight-list library
  before it showed six. So a list added to `LISTS` is a tag removed from the
  picture's rail, and both arrays are ordered on that basis. Nothing checks this:
  the arithmetic is read off `sidebar.tsx`'s Tailwind classes, and those are free
  to move under it. Re-count it against the capture. Note also that the system
  three are **interleaved** among the user's, not stacked above them (`use-lists`
  merges one tree ordered by `rank`), so `LISTS` order decides a list's
  neighbours rather than its row number. The tags do not vanish with the rail rows — every row in the main
  column prints its own chips — but the rail is where a scanning eye reads them.
  The same budget is why the tree is **one pair deep** (`Weekends > Lisbon`): the
  nest costs no row, since both lists already existed, and it puts the first item
  of the Plus footnote under the figure ("Nested lists, hidden lists, the app
  lock…") into the picture that footnote sits under.

**Reach for `--fresh` whenever you edit the URL list.** A Bracemark backup merges
skip-existing **by path**, so re-running against the account that already holds
these ids imports nothing — you would photograph the old library while the log
reports a clean import, which is the same trap the four seeded accounts carry
(_four things that will surprise you_). It is also the way out of a stuck drain:
the `backoff(attempts)` ladder lives on the facet and survives re-runs, so a link
that has failed three times is 40 minutes from its next attempt and a fresh run
can spend its whole budget waiting for one retry window. A wipe drops the facets
and the next import starts the ladder at zero.

The capture is the default **My List** view (`/links`). Its seven links are the
visible fold every lead frame draws; the remaining nineteen stay distributed
through the ten named lists, so the drawer and global search still show a real
filed collection. Keeping the title and the visible rows in the same list also
means no compositor has to rewrite product chrome.

### state today

Web, native, and contract were measured 2026-09-16 from commit
`eb9119b2c393413d15bb85d2bc392c0022de283b` with the Phase 1 harness changes
present in the working tree. Extension was measured the same day from commit
`6a214440e5789e660934809fffcb9d966ae1b9df` with the Phase 2 changes present in
the working tree:

| surface          | measured result                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| web              | **6/6 passed** — Playwright 1.62.1, system Chrome 152.0.7977.83                  |
| extension        | **9/9 passed** — Playwright 1.62.1, bundled Chromium 151.0.7922.34               |
| iOS native       | **4/4 passed** — iPhone 17 Pro simulator, iOS 26.5, app 1.0.0 (1), Maestro 2.8.0 |
| Android native   | **4/4 passed** — `sdk_gphone64_arm64`, Android 16, app 0.0.0 (1), Maestro 2.8.0  |
| iOS contract     | **3/3 passed** — frozen vectors, web→mobile, mobile→web                          |
| Android contract | **3/3 passed** — frozen vectors, web→mobile, mobile→web                          |

The iOS native matrix was completed across two invocations. Sign-in passed in
the first; before recovery provisioning, an orphaned same-checkout Next process
owned port 3000 but stopped answering. The runner now checks web responsiveness
as well as port ownership. Recovery, add-link, and delete-all then passed in one
filtered invocation. Android's first preflight also exposed an ADB formatting
assumption (space versus tab between serial and state); the parser is now
whitespace-agnostic, and the complete four-flow rerun passed.

They have now been run, and the earlier note that "their first real run will find
things" turned out to be the accurate part of this doc. It found four, and the
split matters: **three were bugs in the harness, one is in the app.**

The harness three are recorded where they bite — `subflows/sign-in.yaml`
(iOS AutoFill's "Save Password?" sheet, which covers the app in a window the app
does not own), the `.*…*` matchers in the three link flows (Maestro matches text
as a regex against the WHOLE accessible name, and a link row's is a composite),
and `recovery-sign-in.yaml` (`eraseText` deletes backwards from a caret that sits
at index 0 after a rejected submit, so it cleared nothing and the real code was
typed IN FRONT of the wrong one). All three presented as the app being broken,
which is the reason each carries its reasoning inline rather than a fix.

The app one was real and is fixed: **a link saved on the device stayed absent
until the app was relaunched.** The write itself was fine — the duplicate check
saw the link immediately, and a cold start showed it — but `useLiveRead` filtered
expo-sqlite events by `databaseName`. Native reports the attached schema there
(`main`); the database filename is in `databaseFilePath`, so every real insert
event was discarded. The hook now filters the file path instead.

`flows/add-link.yaml` keeps the failure shape intact: it saves one link into an
empty account (mounting FlashList), then saves a second into that already-mounted
list and asserts both without a relaunch or refresh. Persistence alone is not a
pass; the screen where the user saved the link has to update immediately.

The Phase 3 account cases were measured the same day from commit
`9358e0ad994063c38d6a78884aafb559194d2af7` with their changes present in the
working tree, on the same browser, simulator, emulator and Maestro as above:

| surface        | measured result                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| web            | **9/9 passed** — `WEB-ACCOUNT-001`/`002` and `ACCOUNT-DELETE-001`, three repeats, no retry |
| iOS native     | **3/3 passed** — `NATIVE-ACCOUNT-001`/`002` and `ACCOUNT-DELETE-002`                       |
| Android native | **3/3 passed** — the same three flows                                                      |

Both delete-account cases were also run against a client that skipped the
delete-account POST but still ended its local session. Each failed at its
refused-sign-in assertion, which is the half a local sign-out cannot fake.

The Phase 3 link lifecycle and editor cases were measured 2026-09-16 from commit
`ca3c815b96d7d9d2a0d6fbbbcab7a6683b18b76e` with their changes present in the
working tree, on the same browser, simulator, emulator and Maestro as above:

| surface        | measured result                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| web            | **15/15 passed** — `WEB-LINK-001`/`002`, `LINK-EDITOR-001`, `LINK-CLOSE-001`, `LINK-LIFECYCLE-001`, three repeats, no retry |
| iOS native     | **4/4 passed** — `NATIVE-LINK-001`, `LINK-EDITOR-002`, `LINK-CLOSE-001`, `LINK-LIFECYCLE-002`                               |
| Android native | **4/4 passed** — the same four flows                                                                                        |

The three new web cases were each run against a deliberately broken client and
failed at the step that guards the break: quick-add's dirty guard removed (at the
Escape check), the edit dialog's guard removed (at its Escape check), the edit
dropping the list change (at the moved-list read after reload), Restore sending
the link back to Trash, Pin as a no-op, and the delete confirmation skipping the
delete. The native flows have **not** yet had that check; it is the open half of
their definition of done.

The Phase 4 cross-client cases were measured 2026-09-18 from commit
`1ea5a58b130d3d8c85396fb1fd70eea4ce285431` with their changes present in the
working tree — system Chrome 153.0.8010.48, bundled Chromium 151.0.7922.34, the
iPhone 17 Pro simulator on iOS 26.5, `sdk_gphone64_arm64` on Android 16, app
1.0.0 (1), Maestro 2.8.0:

| surface          | measured result                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| iOS contract     | **3/3 passed** — frozen vectors, web→mobile, mobile→web                                        |
| Android contract | **3/3 passed** — the same three                                                                |
| extension        | **2/2 passed** — `EXT-SYNC-001`/`002`                                                          |
| web              | **6/6 passed** — `SYNC-REFRESH-PILL-WEB-001`, `SYNC-BLOCKED-001`, three repeats each, no retry |
| iOS native       | **2/2 passed** — `SYNC-REFRESH-PILL-IOS-001`, `SYNC-LOCAL-TOP-001`                             |
| Android native   | **3/3 passed** — `SYNC-REFRESH-PILL-ANDROID-001`, `SYNC-LOCAL-TOP-001`, `SYNC-CONFLICT-001`    |

They found two app bugs, both fixed in the same change, and neither visible to
any unit test (details in [client-queries.md](./client-queries.md), _the staged
snapshot rule_):

- **A user's Sync opened the local-write grace window**, so a pull landed
  straight under a scrolled reader. On web every row moved down by one (80px),
  on native the pill never lit. The menus and Data cards now call `syncNow`.
- **The native pill hid the row it promoted.** Promotion and an animated
  scroll-to-top raced FlashList's content anchor, leaving the new row a row
  above the viewport on iOS — mounted, and "visible" to every selector.

Each new case was also run against the behaviour it guards and failed: the web
refresh-pill case at the anchor row's position with the menu on `requestSync`;
the native one at its held step (Android); local-top without
`autoscrollToTopThreshold` (Android); the capacity case with the engine
rethrowing `quota_exceeded`, at "Sync failed — Retry" in 20s; and the iOS pill at
its bounds check with each of the two earlier `applyAndScrollTop` orders.
`SYNC-CONFLICT-001` has not had that check: breaking local-wins means changing
the reconcile, which its unit specs own.

The Phase 7 extraction cases were measured 2026-09-22 from commit `59a9dad` with
their changes present in the working tree — system Chrome, the iPhone 17 Pro
simulator on iOS 26.5, `bracemark-pixel8` on Android, Maestro 2.8.0, against
live example.com:

| surface        | measured result                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| web            | **9/9 passed** — `EXTRACT-WEB-001`, `EXTRACT-WEB-ALL-001`, `EXTRACT-OFFLINE-001`, three repeats, no retry |
| iOS native     | **2/2 passed** twice — `EXTRACT-NATIVE-001`, `EXTRACT-NATIVE-ALL-001`                                     |
| Android native | **2/2 passed** twice — the same two, with the device's route to the extractor removed                     |

They found one app bug, fixed in the same change: **Expo's Generate all never
finished when eight pending links in a row sat on dead hosts.** A drain step in
which no host answered was read as "the device is offline" and rethrown for a
backoff with the cursor unmoved, so the same step was retried forever — Pause
over "0 of 27", nothing logged, and the auto drain wedged the same way. The step
now asks NetInfo, and records the links as transient failures when the device is
connected ([link-extraction.md](./link-extraction.md), _expo drains in the
foreground_).

Each case was also run against the behaviour it guards and failed: the web
auto drain disabled (`EXTRACT-WEB-001` at the extract request,
`EXTRACT-OFFLINE-001` at the first refused attempt), the extract-all batch
skipped (`EXTRACT-WEB-ALL-001` at the settled progress line), the drain's
transport retry removed (`EXTRACT-OFFLINE-001` at the post-reload retries),
the add panel's `extractNow` removed (`EXTRACT-NATIVE-001` at the title, iOS),
and the dead-host stall above (`EXTRACT-NATIVE-ALL-001`, iOS, before the fix).
iOS cannot remove the extractor from one simulator — it shares this Mac's
loopback — so "without calling the server extractor" is proved on Android only;
expo has no extractor origin configured at all.

### the red full suite, and what it was

The web suite was red for a while with every case passing alone, which is the
signature described under _one IP, one bucket_ above. It is green now. Measured
2026-09-20 from commit `26eae3e` with the fixes below present in the working
tree, system Chrome 153.0.8010.48, the iPhone 17 Pro simulator on iOS 26.5,
`bracemark-pixel8` on Android, app 1.0.0 (1), Maestro 2.8.0:

| surface        | measured result                                                                  |
| -------------- | -------------------------------------------------------------------------------- |
| web            | **25/25 passed** in one invocation — the full suite, no retries, 2.2 min         |
| iOS native     | 15/16 in one leg; `BULK-COPY-001` green on its own after the focus-first fix     |
| Android native | 9 cases in one leg, then `FILTER-001` red; green on its own after the LogBox fix |

**Nothing was wrong with the app.** All four failures were in the harness, which
is now the fourth time that has been the split (see _state today_ above), and
each one presented as a product bug:

- `LOCK-APP-001` and `WEB-DATA-001` were the shared rate-limit bucket — an
  entitlement read stuck on free opening a paywall, and a wipe apparently hung
  behind a `Retry-After: 60` backoff. Raising the case's expect timeout to 60s
  was tried first and could not have worked; the limit was the lever.
- `BULK-COPY-001` was the iOS edit menu never opening on an unfocused field, with
  `simctl pbpaste` proving the app's write had been correct all along.
- `FILTER-001` was the LogBox toast eating the FAB press, because the
  dismissal subflow matched only a numeric badge and a lone log renders `!`.

Neither native leg has a clean single-invocation pass yet: iOS stopped at
`BULK-COPY-001` and Android at `FILTER-001`, and the Android cases after it have
not run since. Both legs need one uninterrupted re-run before this table can
claim a repeat for every native case.

Nothing here runs automatically. There is still no CI ([testing.md](./testing.md)),
and the only git hook guards `internal/`.
