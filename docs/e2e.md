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
  paths.ts                the one answer to where a run writes
  web/                    playwright specs + fixtures
  mobile/flows/           maestro flows, run standalone
  mobile/contract/        maestro legs of a contract run (parameterised)
  runner/                 the orchestrators: mobile, web→mobile, mobile→web
  seed/                   the dev-account seed — not a test (below)
  .artifacts/             gitignored — traces, reports, run manifests, profiles
  credentials/            gitignored — what `npm run seed` created
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

What it is _not_ allowed to bring is its browser bundle — ~450 MB into
`~/Library/Caches/ms-playwright/`, which this repo has never had. That is what
made the original root devDependency `playwright-core` rather than `playwright`.

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
a download hook back. The tell is `~/Library/Caches/ms-playwright/` appearing after
an install; check `hasInstallScript` in the lockfile diff before assuming a version
bump is inert.

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

### driving the native apps

Maestro, for the reasons in [testing.md](./testing.md) (_the driver: Maestro, not
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
  **dev** build with Metro up, which they already did.
- **Android needs `adb reverse tcp:8787 tcp:8787`** (and `8788` for the
  extractor, `8081` for Metro — `npm run expo:android:reverse` does all three). Both
  `.env.development` files point at `http://localhost:8787` and
  `EXPO_PUBLIC_*` is inlined by Metro at bundle time, so one value has to serve the
  iOS simulator and the Android emulator both. Reversing the port teaches the
  emulator that localhost means the host; switching to `10.0.2.2` instead would
  fork the env per platform, which [env-files.md](./env-files.md) is shaped
  specifically to avoid.
- **Maestro's `PATH` entry is in `.zshenv`, not `.zshrc`.** `runner/lib.ts` falls
  back to `~/.maestro/bin/maestro` anyway, so a shell that lost it gets a working
  run instead of `ENOENT`.

#### accounts for a mobile run

Maestro cannot create one: every flow starts signed in, and a native
create-account flow would be a second copy of a form jest already covers. So
`runner/mobile.ts` provisions a throwaway account **through the browser** and
hands the credentials to `maestro test` as `-e` parameters.

That is not a shortcut around native key derivation — signing in on the device
runs the full Argon2id + HKDF path there, which is the thing under test. It is
also why the web fixture takes create-account's "Choose my own" branch rather than
the generated passphrase: a secret we chose can be passed along, one the app
generated would have to be scraped off a screen.

**The recovery code is the exception, and it has to be.** `recovery-sign-in.yaml`
needs one, and a recovery code cannot be chosen — it is CSPRNG-minted by the
client and never user-supplied by design (`crypto/recovery-code.ts`: "we GENERATE
it and never let users type their own"). So the mobile runner provisions with
`withRecovery`, which takes the ceremony's recovery exit and reads the code off
the show-once panel by its `aria-label`. That is scraping a secret out of the DOM
— the thing the paragraph above avoids — but the preference there was
chosen-over-scraped, and here there is no chosen form to prefer. The code is
captured in its **display** form, hyphens included, because that is what a user
would have saved and what the flow should type back;
`normalizeRecoveryCode` strips the grouping before it is key material, so the
round trip is part of what gets exercised.

A recovery door is **additive** — the same account still signs in by password
identically (see [account.md](./account.md), _the doors_) — so provisioning with
one costs the other flows nothing. The contract runners still provision without.

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
| `add-link-url`              | `src/features/links/link-add-screen.tsx`        |
| `add-link-save`             | ” — the submit, whose label flips Save→Confirm  |

The recovery-door ids are deliberately **distinct** from the password ones rather
than shared. The two modes never mount together, so reuse would work — but the
flows read as prose, and `sign-in-recovery-submit` says which door was opened
where a second `sign-in-submit` would not. The two mode toggles are ids for the
same reason everything else here is: their labels are sentences ("Forgot your
password? Use a recovery code"), and a flow keyed to a sentence turns a wording
edit into a red run. The two error ids exist so the failure paths — a wrong
password, a wrong recovery code — have something legal to assert on; the message
text itself is copy.

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

Everything needs the dev stack: **`npm run dev`** (api on 8787, web on 3000,
extractor on 8788). `playwright test` boots and waits for it itself via
`webServer` + `global-setup.ts`; the `runner/` scripts check and tell you to start
it.

```sh
npx nx e2e-web @stxapps/e2e        # the web suite, headless, 2 workers
npx nx e2e-web:headed @stxapps/e2e # the same, watchable
npx nx e2e-web:report @stxapps/e2e # open the last HTML report
npx nx e2e-mobile @stxapps/e2e     # provision an account, run mobile/flows
npx nx e2e-contract @stxapps/e2e   # web → mobile, then mobile → web
```

The three run-it targets also have root scripts — `npm run e2e:web`,
`e2e:mobile`, `e2e:contract` — matching the `dev` / `dev:ext` / `dev:site`
convention. **There is deliberately no bare `npm run e2e`.** A script that fanned
out to all three would be a lie: it cannot boot a device, cannot install a dev
build, cannot know which platform was meant, and would fan out to a target pair
that cannot both run in one pass (below). It would fail as a Maestro timeout on a
missing element, which is the failure mode the rest of this doc exists to avoid.
The asymmetry with `npm run test` is the honest one — e2e has prerequisites a
unit test does not.

The mobile and contract targets additionally need a **bracemark-expo dev build
already installed on a booted simulator or emulator**. Nothing here builds the
app — see [expo-build.md](./expo-build.md).

#### one platform at a time, and it is forced

`runner/lib.ts`'s `MaestroOptions` is `{ env, outputDir }` — there is **no
`--device` plumbing**, so `maestro test` is spawned bare and binds to whatever
single device it finds. With an iOS simulator and an Android emulator both
booted, Maestro either drops an interactive picker — which hangs, because the
child inherits stdio — or picks one non-deterministically. Either way the run no
longer says which platform it proved. Boot one, finish its leg, shut it down.

Web e2e is platform-independent; run it once, not once per leg.

```sh
npm run dev                          # terminal 1, stays up for everything below

# iOS leg
npm run expo:ios                     # boots the sim, builds + installs the dev build
npm run e2e:web
npm run e2e:mobile
npm run e2e:contract

# Android leg — shut the iOS simulator down first
npm run expo:android                 # leave Metro running; new terminal for the rest
npm run expo:android:reverse         # adb reverse 8081 + 8787 + 8788, per emulator boot
npm run e2e:mobile
npm run e2e:contract
```

`expo:ios` / `expo:android` are **not** e2e — they are the prerequisite, and the
only step that produces the dev build the two native targets assume. Both hold the
foreground running Metro once the app is installed, so the commands under them
want a second terminal; `expo:android:reverse` is deliberately not chained onto the build
for that exact reason ([expo-build.md](./expo-build.md), _the npm scripts_). Note
that `apps/bracemark-expo/ios/` and `android/` being present on disk proves
nothing: they are generated and gitignored, so the folders can exist with no build
installed on any device.

Failures leave a trace: `npx nx e2e-web:report @stxapps/e2e`, or
`npx playwright show-trace e2e/.artifacts/test-results/<test>/trace.zip`. A run
also writes its throwaway credentials to `e2e/.artifacts/*.json`, so the account a
failed run left behind can be signed into and looked at.

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
npm run seed           # all four accounts
npm run seed -- free-full        # or just one
npm run seed:fixtures            # the archives only — no browser, no api
```

Credentials land in `e2e/credentials/accounts.json` (gitignored, and **not**
under `.artifacts`: they outlive the run that made them, so clearing run output
must not take them with it). The catalog:

| key          | username          | plan | library                                      |
| ------------ | ----------------- | ---- | -------------------------------------------- |
| `free-empty` | `seed_free_empty` | Free | nothing — the first-run screens              |
| `plus-empty` | `seed_plus_empty` | Plus | nothing — paid, and still empty              |
| `free-full`  | `seed_free_full`  | Free | 190 links, 8 flat lists, 14 flat tags        |
| `plus-full`  | `seed_plus_full`  | Plus | 1,000 links, 24 nested lists, 40 nested tags |

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
  Delete all data first, then re-seed. (Re-running with no edits is a genuine
  no-op, which is what makes a half-finished run safe to repeat.)
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
- **The free trees are flat.** A backup restores `parentId` verbatim on any plan,
  so nesting a free account would hand you a state `nestedLists` means the
  product cannot produce.

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

### state today

| surface  | status                                                                   |
| -------- | ------------------------------------------------------------------------ |
| web      | **5 specs, passing** — account (reload, sign-out), links, lists          |
| native   | 4 flows written, YAML validated, **not yet executed** — no dev build yet |
| contract | both runners written, **not yet executed** — same reason                 |

The honest reading of that table: the web half is real, and the native and
contract halves are scaffolding whose first real run will find things. The
contract runs are the highest-value part of this doc and the least proven part of
the code — that gap is the next thing to close, and it needs an installed dev
build before anything else.

Nothing here runs automatically. There is still no CI ([testing.md](./testing.md)),
and the only git hook guards `internal/`.
