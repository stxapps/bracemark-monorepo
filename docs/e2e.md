## e2e

Whole-flow tests: a real build, a real browser or device, a whole flow. This is
layer two of the three in [testing.md](./testing.md) — read that first, because
most of the value here comes from knowing what does **not** belong at this layer.
Everything below assumes the push-work-down rule and only argues about what
survives it.

`e2e/` is one Nx project, `@stxapps/e2e`. It is deliberately **not** part of
`npm run test`.

### three surfaces, not two

| surface      | driver             | what only it can prove                                                          |
| ------------ | ------------------ | ------------------------------------------------------------------------------- |
| **web**      | `@playwright/test` | Dexie survives a reload, cross-origin sign-out, real Argon2id in a real browser |
| **native**   | Maestro            | real expo-sqlite, secure-store, cold-start session, per-platform navigation     |
| **contract** | both, stitched     | one password → the same keys → the same blobs, **web ⇄ mobile**                 |
| **vectors**  | Maestro, no stack  | the FROZEN table against real quick-crypto, on device                           |

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
  playwright.config.ts    global-setup.ts
  cases.json              case ids, tiers, traits, fixtures and artifact contract
  fixtures.json           fixture sizes and deterministic/online URL contract
  paths.ts                the one answer to where a run writes
  web/                    playwright specs + fixtures
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
- Targets are `e2e-web`, `e2e-mobile`, `e2e-contract`. No target is called `test`.

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

**`@playwright/test`, launching the system Chrome.** The runner is worth its
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

**Exactly one thing in `e2e/` uses it**, and it is not a spec: `shot/extension.ts`,
the store-screenshot leg (_the published screenshots_, below). Every **spec** here
still goes through `CHROME_PATH`, and that is the line to hold — a spec that needs
the bundled browser has stopped testing what users run. The leg is exempt because
its subject IS the unpacked extension, which system Chrome cannot load at all.

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

If an end-to-end extraction proof is ever wanted, it needs one real public URL in
exactly one spec, tagged so it can be skipped offline — a deliberate network
dependency, not the default.

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

Four repo-specific gotchas:

- **`launchApp` resumes, it does not cold-start.** Every flow that assumes a root
  screen needs its state wiped first, or it passes alone and fails in a directory
  run because the previous flow left the app deep in a navigation stack. That
  failure looks exactly like Maestro's batch-mode driver bug and is not one.
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
- **Maestro's `PATH` entry is in `.zshenv`, not `.zshrc`.** `runner/lib.ts` falls
  back to `~/.maestro/bin/maestro` anyway, so a shell that lost it gets a working
  run instead of `ENOENT`.

#### accounts for a mobile run

Maestro cannot create one: every flow starts signed in, and a native
create-account flow would be a second copy of a form jest already covers. So
`runner/mobile.ts` provisions a throwaway account **through the browser for each
flow** and hands the credentials to `maestro test` as `-e` parameters. Accounts
are not shared across flows: a destructive or failed case cannot change the
starting state of the next case.

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

| testID                      | where                                           |
| --------------------------- | ----------------------------------------------- |
| `sign-in-username`          | `src/features/auth/sign-in-form.tsx`            |
| `sign-in-password`          | `src/features/auth/sign-in-form.tsx`            |
| `sign-in-submit`            | `src/features/auth/sign-in-form.tsx`            |
| `sign-in-error`             | ” — the submit-level `root` error               |
| `sign-in-use-recovery`      | ” — the toggle into the recovery door           |
| `sign-in-recovery-username` | ” — `RecoverySignIn`                            |
| `sign-in-recovery-code`     | ” — `RecoverySignIn`                            |
| `sign-in-recovery-submit`   | ” — `RecoverySignIn`                            |
| `sign-in-recovery-error`    | ” — `RecoverySignIn`                            |
| `sign-in-use-password`      | ” — the toggle back out                         |
| `links-screen`              | `src/app/(app)/links/index.tsx` (a root marker) |
| `links-open-navigation`     | `src/features/links/topbar.tsx`                 |
| `links-nav-list-<id>`       | `src/features/links/sidebar.tsx` — a drawer row |
| `links-nav-tag-<id>`        | ” — the tag rows                                |
| `links-nav-all`             | ” — Show All                                    |
| `links-more-options`        | `src/features/links/more-options-menu.tsx`      |
| `links-open-settings`       | ” — the Settings menu item                      |
| `add-link-url`              | `src/features/links/link-add-panel.tsx`         |
| `add-link-save`             | ” — the submit, whose label flips Save→Confirm  |
| `settings-open-navigation`  | `src/features/settings/topbar.tsx`              |
| `settings-close`            | ” — returns to the links route                  |
| `settings-nav-<section>`    | `src/features/settings/sidebar.tsx`             |
| `delete-all-open`           | `src/features/settings/data-section.tsx`        |
| `delete-all-confirm`        | ” — the confirmation checkbox row               |
| `delete-all-submit`         | ” — the destructive action                      |
| `delete-all-complete`       | ” — renders only after a successful wipe        |
| `contract-vectors-pass`     | `src/app/contract-vectors.tsx` (dev-only)       |
| `contract-vectors-fail`     | ” — carries the failing check names in its text |
| `vector-<check>`            | ” — one per vector, `PASS`/`FAIL`/`RUNNING`     |

The three `contract-vectors` ids are the one group NOT in the shipped app: the
screen returns a `<Redirect>` in production. Exactly one of `-pass`/`-fail` ever
renders, and neither renders while checks are still running, so a flow that
asserts the pass marker cannot pass by catching the screen mid-run.

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
server reuse completely. Native resolves Metro in the Expo dev-client link,
requires it to report a running packager from this checkout, and records the
link and all stack origins. It also requires the selected device to be booted,
the development build to be installed, and Android to have completed boot with
the 8081/8787/8788 reverse mappings. A failed preflight happens before account
provisioning.

```sh
npx nx e2e-web @stxapps/e2e
npx nx e2e-web:headed @stxapps/e2e
npx nx e2e-web:report @stxapps/e2e

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

The three targets also have root scripts — `npm run e2e:web`, `e2e:mobile`, and
`e2e:contract`. There is deliberately no bare `npm run e2e`: no honest fan-out
can boot, build, select, and prepare both native platforms. `expo:ios` and
`expo:android` are prerequisites, not tests; see [expo-build.md](./expo-build.md).
On Android, run `npm run expo:android:reverse` after each emulator boot.

#### cases, suites and fixtures

[`e2e/cases.json`](../e2e/cases.json) is the machine-readable registry. Every
case has an id, surface, primary `smoke` or `full` tier, traits, fixture size,
path, and expected artifacts. `npm run check:registry -w @stxapps/e2e` rejects
duplicate ids, missing paths, and tag drift. `full` includes both tiers;
`smoke` selects only smoke. `--case`, `--include-trait`, and `--exclude-trait`
are repeatable or comma-separated and work across the wrappers:

```sh
npm run e2e:web -- --suite smoke
npm run e2e:web -- --case WEB-LINK-001
npm run e2e:mobile -- --platform ios --device <udid> --exclude-trait destructive
```

[`e2e/fixtures.json`](../e2e/fixtures.json) defines the fixture sizes: `empty`
(the normal fresh account), `small` (the minimum multi-entity journey state),
and `scale` (an archive generated from
`e2e/seed/library.ts` and imported into a fresh account). No test uses the human
seed accounts or the published-capture account. Offline deterministic links use
the reserved `.invalid` TLD; a case that deliberately exercises extraction must
carry the `online` trait and use the separate public fixture table in that file.

#### artifacts and retries

Every invocation gets `.artifacts/runs/<run-id>/`. Web writes its HTML report,
failure screenshot, retained failure trace, command, and run manifest there.
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

Measured 2026-09-16 from commit `eb9119b2c393413d15bb85d2bc392c0022de283b`
with the harness changes present in the working tree:

| surface          | measured result                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| web              | **6/6 passed** — Playwright 1.62.1, system Chrome 152.0.7977.83                  |
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

Nothing here runs automatically. There is still no CI ([testing.md](./testing.md)),
and the only git hook guards `internal/`.
