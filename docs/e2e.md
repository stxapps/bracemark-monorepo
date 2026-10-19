## e2e

Whole-flow tests: a real build, a real browser or device, a whole flow. This is
layer two of the three in [testing.md](./testing.md) — read that first, because
most of the value here comes from knowing what does **not** belong at this layer.
Everything below assumes the push-work-down rule and only argues about what
survives it.

`e2e/` is one Nx project, `@stxapps/e2e`. It is deliberately **not** part of
`npm run test`.

### four client surfaces, plus the stitched contracts

| surface       | driver             | what only it can prove                                                           |
| ------------- | ------------------ | -------------------------------------------------------------------------------- |
| **web**       | `@playwright/test` | Dexie survives a reload, cross-origin sign-out, real Argon2id in a real browser  |
| **extension** | `@playwright/test` | unpacked MV3 profile/session, popup writes, worker restart, web cross-read       |
| **pwa**       | `@playwright/test` | the production export's service worker: offline launches, updates between builds |
| **native**    | Maestro            | real expo-sqlite, secure-store, cold-start session, per-platform navigation      |
| **contract**  | both, stitched     | one password → the same keys → the same blobs, **web ⇄ mobile**                  |
| **vectors**   | Maestro, no stack  | the FROZEN table against real quick-crypto, on device                            |

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
  playwright.config.ts    extension.playwright.config.ts    pwa.playwright.config.ts
  global-setup.ts
  cases.json              case ids, tiers, traits, fixtures and artifact contract
  fixtures.json           fixture sizes and deterministic/online URL contract
  visual.json             the named visual checkpoints (_visual checkpoints_)
  visual.playwright.config.ts
  paths.ts                the one answer to where a run writes
  web/                    playwright specs + fixtures
  extension/              unpacked-extension specs, shared driver, release checks
  pwa/                    installed-production-build specs + the origin they own
  visual/                 web visual checkpoint specs + their capture helper
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
- Targets are `e2e-web`, `e2e-extension`, `e2e-pwa`, `e2e-mobile`,
  `e2e-contract`, `e2e-visual`. No target is called `test`.

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

**The first sanctioned reason to fetch it deliberately is `bracemark-extension`.**
Google Chrome will not load an unpacked extension from the command line and says
nothing when it declines, so driving the popup needs Playwright's own Chromium
(`npx playwright install chromium`) — see `docs/app-drivers.md`, _driving
bracemark-web_, and the extension section of `.claude/skills/verify/SKILL.md`.

Exactly two entrypoints use it: the `e2e-extension` functional target and
`shot/extension.ts`, the store-screenshot leg (_the published screenshots_,
below). Every web-app spec still goes through `CHROME_PATH` on a Chrome run (the
second download, Playwright's Firefox, is _firefox_ below). The browser
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

#### firefox

**The second sanctioned download is Playwright's Firefox**
(`npx playwright install firefox`), for `e2e-web:firefox` and
`e2e-web:firefox:staging`. It cannot be the system Firefox: Playwright drives
Firefox through its own patched build (the Juggler protocol), and a stock
Firefox from `/Applications` does not speak it. So the version under test is the
one this Playwright release pins (`firefox-1538`, Firefox 153 at 1.62.1), and it
moves when Playwright does — not when the user's Firefox updates.

`E2E_BROWSER` picks the engine once per process (`runner/browser.ts`), the way
`E2E_ENVIRONMENT` picks the tier, and the two compose: `e2e-web:firefox:staging`
is Firefox against dryrunbase.com. Two places read it — `launchApp` for every
signed-in context, and `playwright.config.ts` for the default `page` the
anonymous staging checks use — so a spec never names a browser.

**Firefox runs a subset, by registry admission.** A web case's `browsers` field
(_cases, suites and fixtures_, below) lists the engines it runs on; omitted means
Chrome only, and every Firefox case also runs on Chrome but one:
`DATA-ROUNDTRIP-WEB-002`, the backup round trip, whose subject Chrome's native
save dialog puts out of a driver's reach. Running all of `web/`
twice would roughly double the longest run to re-prove React and Dexie logic that
does not depend on the engine. What is admitted is what Gecko does its own way:

- **Crypto and the session** — Argon2id's wasm in a `blob:`-started worker, and
  a non-extractable `CryptoKey` kept in IndexedDB across a reload
  (`WEB-ACCOUNT-001`, `LOCK-APP-001`).
- **IndexedDB lifecycle** — the sign-out and delete-account wipes, a second
  account's database on one profile, and the `versionchange`/`blocked`
  handshake between an old tab and a newer build (`WEB-ACCOUNT-002`,
  `ACCOUNT-DELETE-001`, `WEB-ACCOUNT-004`, `VERSION-SKEW-WEB-001`/`-002`).
- **Cross-tab coordination** — two tabs' syncs serialized (`SYNC-TABS-001`).
- **The read edge** — Dexie writes under `liveQuery`, and virtual scrolling,
  paging and range selection on Gecko's scroll metrics (`WEB-LINK-001`,
  `SCALE-WEB-001`, `BULK-001`).
- **Pointer drag** — the list tree's reorder and reparent (`TAXONOMY-DND-001`).
- **Files** — import through the file input, zip reading and image blobs
  (`DATA-IMPORT-WEB-001`), export through the download fallback Firefox always
  takes, since it has no `showSaveFilePicker` (`OFFLINE-EXPORT-WEB-001`), and the
  export round trip in every format (`DATA-ROUNDTRIP-WEB-001`/`-002`, _what e2e
  may not assert_, below).
- **Offline** — `navigator.onLine` and a failed cycle (`OFFLINE-WEB-001`).
- **The deployed CSP, on staging** — Firefox enforces `worker-src`, `blob:` and
  `'wasm-unsafe-eval'` by its own rules, so a policy that passes Chrome can still
  refuse Argon2 or the converter's worker in Firefox. The refusal cases
  (`STAGING-CSP-001`/`-002`/`-003`/`-005`) and every staging-admitted journey
  above run under it, with the violation guard on.

Left on Chrome by necessity: `BULK-COPY-001` (Playwright cannot grant Firefox
`clipboard-read`), `STAGING-CSP-004` (it asks Chrome's DevTools protocol for the
manifest) and every other CDP-driven path, the PWA target (Playwright supports
service workers in Chromium only), and the browser extension, whose Firefox build
remains `EXT-RELEASE-002`'s manual check. Admit another case by adding `firefox`
to its `browsers` and running it on both engines; the rule is the one above —
something Gecko does differently has to be on the path.

#### the browser extension functional target

`e2e-extension` builds the development Chrome MV3 bundle (`e2e-extension:staging`
builds the staging one — _deployed staging and mobile Release builds_, below),
refuses it unless its manifest grant and scripts name the run's own api and web
origins and no other tier's (`runner/extension-bundle.ts`), copies it under the
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

`EXT-SIGN-OUT-001` signs out through the options page and checks both an
already-open popup and a popup opened after a browser-profile restart. The
options dialog must disappear and the session must remain absent across that
restart.

Popup and background remain real extension contexts. The worker-restart case
stops the installed MV3 service-worker version through CDP, observes its stopped
state, then uses the popup's public Sync request to wake it back to running and
observes the pulled link through the live popup. There is no app source import,
storage-state shortcut, or test-only message.

#### the PWA target

`e2e-pwa` runs a controlled local bracemark-web **production** build. The
staging web target also runs production output, but this target owns its origin
and can replace builds or take the server away: the serwist service worker (`src/sw.ts` — the
precache, a network-only rule for cross-origin requests, then `@serwist/next`'s
`defaultCache`) is built by `serwist build`
after `next build` and is disabled outright in development
(`SerwistProvider disable`), so local `e2e-web` cases never meet it. Staging cases do run with the deployed
worker, but do not own the CDN or its update schedule. What the
worker must and must not do, and the cases it still needs, is
[offline-mode.md](./offline-mode.md).

`runner/pwa.ts` builds `nx build @stxapps/bracemark-web -c development` — a
production-mode build of `.env.development`'s origins, through the same
`envFile` mechanism `staging` uses ([env-files.md](./env-files.md)) — copies
`out/` into the run directory at once, and refuses the copy unless it has a
`sw.js` and a bundle that names the local api and neither deployed one. The
spec then serves that copy ITSELF (`pwa/fixtures/origin.ts`, the same file
mapping `nx start` does), because "the origin is unavailable" has to be a
refused connection the case can cause and undo between two steps. The origin is
`localhost:3001`: `:3000` is the dev server's during every other run, and
`:3001` is the other origin the development api's `CORS_ORIGINS` allows. The
preflight requires the port free — the marketing site's dev server also wants it.

⚠ **That build runs beside a live `next dev`, and its Nx outputs must not
include `.next/dev`.** Next 16 keeps the dev server's whole state there —
`.next/dev/cache/turbopack` included — apart from what `next build` writes,
which is what lets the two share a checkout. The `build` target's outputs are
therefore `.next/!(cache|dev)` in both Next apps' `package.json`. They were
`.next/!(cache)`, which swept the dev directory into every cache entry (507 MB
of it) and, on a cache **hit**, had Nx restore that stale copy over the one the
running server was using. Nothing failed in the run that did it: `e2e-pwa`
passed, and afterwards the dev server answered every route with a bare 500 and
logged `Failed to restore task data (corrupted database or bug)` /
`Unable to open static sorted file`. A cache miss does no harm, so the first
run after a source change was fine and the next one was not. Recovery is to
stop the server and remove `apps/bracemark-web/.next/dev`.

⚠ **Chrome installs the app under automation but never opens its standalone
window, and nothing fails when it doesn't.** CDP `PWA.install` is real — it
applies Chrome's installability checks and refuses a wrong manifest id — but a
`PWA.launch`-ed app still reports `display-mode: browser` (measured, Chrome 153),
and Chrome ignores `display-mode` in media emulation. That no longer matters to
registration — bracemark-web registers its worker after sign-in in any display
mode (`inner-layout.tsx`; `PWA-004` proves it in a plain tab) — so the installed
cases' own registration only makes them wait for activation before going
offline. The run manifest records `standaloneWindowProven: false`;
`PWA-RELEASE-001` (`web/RELEASE.md`) owns the real install surfaces. Emulating
the display mode would not be installation proof even if it worked.

⚠ **`offline: true` does not take the network away from the service worker,
and nothing fails when it doesn't.** Chromium's offline emulation covers the
page, not fetches the worker makes itself, and the worker re-fetches every
cross-origin request (its network-only rule). Measured: an "offline" page's
`GET /v1/auth/session` reached the local api through its worker. So
`pwa/fixtures/pwa.ts`'s `openProfile({ offline: true })` also aborts every
request leaving the app's origin — context routing does reach worker requests —
and `restoreNetwork()` undoes both. Before that, "the api is gone" in
`PWA-002`/`003` was not actually true. Keep it in any new offline case.

What the cases prove, on a profile that is closed and reopened (a cold
launch — `pwa/fixtures/pwa.ts` keeps the profile where `launch.ts` deletes it):
`PWA-001`, that with the origin stopped and the browser offline the document
comes from the worker (`response.fromServiceWorker()`), the library comes back
from IndexedDB, and an in-app view change still works; `PWA-002`, that a link
and an edit made there are queued, reported as a failed cycle, and reach an
independent profile once origin and network return; `PWA-003`, that with both
still gone the menu's Settings link and the section list's Data link — client
route changes whose payloads only the worker can supply — reach Export, and a
plain-text export carries the synced link and one written offline, with the
device clock two years ahead (no client clock may end a session,
[sessions.md](./sessions.md)); `PWA-004`, that a plain tab registers the worker
at sign-in and, offline, reaches a Settings section it never opened online —
from the precache, since the case asserts no runtime entry for it; `PWA-005`,
that no cache the origin owns holds a cross-origin key after a full session, that
no runtime cache holds a query-keyed one before sign-out or after, and that
sign-out keeps the worker; `PWA-006`, that
a never-visited query URL loads cold and offline; `PWA-007`, that a new worker
(the staged export with a changed `sw.js`, served from a copy) takes over two
open tabs, both show the "updated, reload" pill, the untouched one keeps working,
and Reload lands on the new worker; `PWA-008`–`011`, the same handover between
builds that **differ** (below); `PWA-012`, that a launch against an origin which
accepts connections and never answers opens from the precache within seconds;
`PWA-013`, that an origin answering 500 opens from the precache too, while an
unknown path still gets the origin's 404. Cut the worker's caching
(`precacheEntries` AND `runtimeCaching` emptied) and `PWA-001` fails at the
worker assertion. Emptying the precache alone does NOT fail it — the online
launch the case makes first leaves `defaultCache` holding the document and its
chunks — so the claim is "the worker brings it back", not "the precache does".

**The update cases deploy derived builds, and read the worker with the origin
stopped.** The run stages one real export, so `pwa/fixtures/build.ts` makes a
later build out of it by changing what a deploy changes: a page (`/links`,
marked, with a new revision), a new content-addressed asset, the build stamp
(`/build.json` and that page's `<html data-build>`, which the update pill
compares), and the worker script naming them. Every build is derived from the pristine export, never from
the last one deployed. `PWA-008` proves the new worker replaces the changed page
and deletes the old copy; `PWA-009`, that a cold launch after a deploy takes the
new worker with nothing asking; `PWA-010`, that a build whose precache names a
missing file never takes over, leaves the old build working, and is followed by
the fix; `PWA-011`, that a build whose page has no script at all is installed
and then replaced on the browser's own check. Five things about writing one:

- ⚠ **A document says which build the WORKER holds only when the origin is
  stopped, and nothing fails when you forget.** The worker hands a navigation
  the network's copy whenever the origin answers ([offline-mode.md](./offline-mode.md),
  _what answers a navigation_), so with the origin up a marker in the page proves
  the deploy happened and nothing about the worker. The first draft of `PWA-009`
  asserted the launch after a deploy was still the old build and failed on
  exactly that. Stop the origin first, or read the precache
  (`precachedRevisions`).
- ⚠ **Do not wait for a worker event.** Chrome checks for an update by itself
  about a second after a navigation, and a check the case asks for is merged
  with one already in flight — so an `updatefound` listener attached by the case
  can miss its event and hang until the timeout. `requestUpdateCheck` returns
  nothing on purpose; read the outcome from state: `precachedRevisions` for a
  worker that activated, `StaticOrigin.answered(path)` — the origin's own log of
  what it served — for an install that met a 404.
- **A failed install is followed by a relaunch.** It hangs rather than fails
  ([offline-mode.md](./offline-mode.md), _a failed install hangs_): the stuck
  worker stays `installing` for five minutes, and a check made meanwhile
  installs nothing. `PWA-010` closes the profile and reopens it to meet the
  fixed build.

- ⚠ **The explicit registration has to match the app's, type included.** The
  installed cases register the worker themselves to wait for activation
  (`installAndRegister`). The app registers `/sw.js` as a **module** worker; a
  bare `register('/sw.js')` asks for a classic one, which the browser treats as
  a different worker and installs a second time, replacing the app's a moment
  after it activated. Every installed case ran a worker type production never
  runs, and a page load issued in that moment never completed — handed to the
  first worker just as it was discarded (measured: no fetch event reached either
  worker, 40 seconds on). Nothing failed on either count; the cases escaped the
  hang only because each saves a link and syncs before its first page load.
- ⚠ **"The origin is unavailable" has three shapes, and `stop()` is only one.**
  `StaticOrigin.stop()` refuses connections, which fails at once — so a case
  built on it opens instantly whether or not the worker has a navigation
  timeout, and cannot tell. `respond('stall')` accepts every connection and
  never answers (`PWA-012`), which is the shape that leaves a browser waiting;
  `respond(500)` answers every request with that status (`PWA-013`). Pick the
  shape the claim is about.

These are not two `next build`s: the chunk graph is the staged export's
throughout. The pair that matters most — the previously **released** build
against the candidate — is not exercised yet. It could not exist before the
first release, and it can now (`PWA-UPGRADE-001`, `e2e/NEXT.md`).

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
`EXTRACT-*` cases (Phase 7) do assert an extracted title — and so does the
`SHARE-EXTRACT-*` pair, whose subject is the page fetch a share is owed — and
they get it from
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

**The export round trip — what may not be asserted about it.** Three things
kept export ⇄ import out of this layer, and two of them still hold.

- **A whole-library comparison.** `e2e` may depend on `type:shared` alone and
  drives the apps over the wire, so it cannot call the orchestrators, and
  comparing two libraries entity-by-entity through the DOM is the worst
  available oracle.
- **A golden file, or any assertion of what a format drops.** The interop
  formats are lossy BY DESIGN ([data-lifecycle.md](./data-lifecycle.md)), so a
  file-to-file comparison — or a check that the app's HTML has no note, or that
  no pin crosses — would encode today's lossiness as the contract.
- **A stubbed save dialog.** `exportAllData` claims the backup's destination
  through `window.showSaveFilePicker`, which system Chrome implements — a
  **native dialog Playwright has no API for**. Stubbing it with `addInitScript`
  would leave the browser proving nothing about the save path, the only part the
  browser could prove. This one no longer blocks the case: **Firefox has no
  `showSaveFilePicker`**, so its backup takes the real `downloadBlob` path every
  Firefox user takes — a product path, not a stub (_firefox_, above).

So the round trip runs (`web/export-round-trip.e2e.ts`), narrowly. One seeded
row carries every field some format promises — nested list, two tags, custom
title, note, image, pin — beside a plain row and a trashed one. Each format is
exported through the real download, its file name and receipt checked, and the
file imported into a **fresh account**: a restore onto a new device, and the
only shape that tests what the file carries, since importing back into the
source dedupes everything. Then that format's promises are read off the one
row, and nothing it drops is asserted. Trash is the exception, because leaving
it out of the interop formats IS the promise, printed beside the options.
`DATA-ROUNDTRIP-WEB-001` takes HTML, CSV and plain text on both engines, since
they download everywhere; `DATA-ROUNDTRIP-WEB-002` takes the backup on Firefox
only — every field back, the trashed link in Trash — and re-imports it into its
source, where skip-existing-by-path must write nothing. Both were checked
against a deliberately broken app: a backup that dropped Trash failed `-002` on
its restore receipt, and a CSV with the note column blanked failed `-001` on the
note. Chrome's native dialog is the one export path left to a person
(`DATA-EXPORT-WEB-RELEASE-001`, `e2e/web/RELEASE.md`).

The archive's internals stay at the unit layer, with a real zip container in
both packages' `data/export-import.spec.ts` and golden cross-platform archives
in `shared` ([testing.md](./testing.md), _the ported pair_). The plain-text
export is also driven for a narrower claim — that the local library leaves the
device with the server gone (_scale, loading and offline_, below) — and asserts
only the URLs it must contain and the receipt's this-device's-copy warning.

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
release check ([iap.md](./iap.md), _exercising Paddle locally_,
`IAP-PADDLE-RELEASE-001`). `IAP-WEB-001` goes exactly as far as a payment
does not: it creates the real sandbox transaction, opens the real overlay, and
closes it (_subscriptions_, below).

**The iOS share extension's memory cap.** The failure is real and silent — iOS
kills an app extension at a per-process cap and the sheet is simply gone
([share-sheet.md](./share-sheet.md), _almost no memory to spare_) — and no case
here can hold it, for three reasons that do not reduce to one. **The simulator
enforces no cap**, so nothing a flow does there can be killed. **A footprint
budget on the build these flows drive is noise**: the dev build's first picker
adds anywhere from 3 to 10 MiB from run to run and a second lap through both adds
another 4, against the ~14 MiB the one known regression cost (`footprint` on the
simulator's process, iOS 26.5). **And the build whose numbers hold still is one
this target cannot launch** — a release build repeats to within 0.2 MiB with a
picker up, but every flow starts through the dev-client link. So it is a
measurement and a release check, not a case: the numbers and how to take them are
in share-sheet.md, and the cap itself is `SHARE-IOS-MEMORY-RELEASE-001`
(`e2e/mobile/RELEASE.md`), on a phone, where it exists. A case that asserted
"under N MiB" on the simulator would go red on a Metro change and stay green
through the regression it was written for.

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
So the flows that use it prove nothing about the app's own dismissal paths
(return/done, tap-outside, scroll-to-dismiss). One case does:
`VIEWPORT-KEYBOARD-001` measures three representative surfaces against the
keyboard's real frame and dismisses each by the app's own gesture (_scale,
loading and offline_, below). Everything else stays a **manual** check — the
mechanisms are RN defaults that jest doesn't render, one case cannot visit every
field, and iOS's share sheet cannot be driven with its keyboard up — and
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

The repo-specific gotchas:

- **Android's document picker keeps the current folder breadcrumb behind its
  navigation drawer.** If it reopens Downloads, an unscoped `Downloads` text
  selector can match that breadcrumb and tap the Recent row covering it. The
  import flow scopes both its wait and tap to DocumentsUI's `roots_list`, then
  asserts the staged filename and the app's import receipt.

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
  `npm run expo:android:open`. Its cost is that local mobile legs assume a
  **dev** build with Metro up. Staging Release uses plain `launchApp` instead
  (see _deployed staging and mobile Release builds_). The published-captures leg
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
- **⚠ The runner refuses a bundle that names another api — and it reads the
  value, it does not search for it.** `EXPO_PUBLIC_API_URL` is fixed when Metro
  starts, and an active pair in the gitignored `apps/bracemark-expo/.env.local` —
  the physical-device switch ([device-testing.md](./device-testing.md), _one
  bundle, one set of origins_) — outranks the committed file. The app still
  launches and Metro is still healthy; every online flow then fails at sign-in
  with nothing in the api log, which reads as stale dev servers. So when a run
  selects an `online` case, the native preflight fetches the bundle the device is
  about to load and compares its api origin with the one the runner provisions
  against. The error prints the repair that leaves the file alone: the pair in
  Metro's own environment, which outranks every env file. What it reads is the
  `process.env` preamble Expo's serializer writes into a development bundle,
  which is where the app's `expo/virtual/env` gets the value. A plain search for
  `http://localhost:8787` would always pass — a development bundle also carries
  the committed `.env.development` as a module of its own, whatever the app is
  using (measured on Expo SDK 54 with Metro started on another origin: both
  strings present, once each). For the same reason an unreadable preamble fails
  the run instead of passing it (`runner/native-run.ts`, `assertBundleNamesApi`).
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
  row. A press there lands on the prompt, and a row scrolled toward it is parked
  at the list's top edge with its neighbour above gone from the tree. Every flow
  that selects or scrolls rows dismisses it first (`flows/bulk-actions.yaml`,
  `flows/bulk-select.yaml`, …).
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
- ⚠ **A tap into a surface the keyboard moves lands where the target WAS.**
  `tapOn` aims from a hierarchy snapshot and presses up to a second later, and
  the keyboard moves most of the surfaces a flow types into: the lock dialog's
  KeyboardAvoidingView slides it up, the add panel rides the keyboard, and the
  auth screens and the lock pane are KeyboardAwareScrollViews that scroll the
  field clear as it rises, falls or resizes. A snapshot from before the move
  sends the tap to chrome that drops the keyboard
  ([soft-keyboard.md](./soft-keyboard.md), _dismissal_), to the keyboard itself,
  or to the neighbouring field, and `inputText` then types into nothing or into
  the wrong field and still reports COMPLETED. Measured on iOS 26.5: a lock-dialog
  tap aimed at y 360 with the field settled at 259–277, from a snapshot 0.1s
  before the keyboard's `didShow` (the submit read "Please enter a password");
  a sign-in whose keyboard collapsed 26ms after the password tap's snapshot, the
  device briefly reporting a hardware keyboard, so the password went into
  Username; and 4 of 71 add-panel taps aimed at the URL field's pre-rise y 681,
  settled at 407, which passed only by beating the keyboard by ~0.2s. Three rules:
  - A field that **focused itself on arrival** is typed into with no tap:
    `flows/subflows/type-autofocused.yaml` (the add panel's URL, the search box,
    the recovery username, the lock dialog through `subflows/lock-dialog.yaml`).
    On Android such a field already reads `focused=true`, and relying on the
    autofocus also asserts it.
  - Any **other** tap into such a surface waits for `waitForAnimationToEnd`
    first — the sign-in fields (`subflows/sign-in-fields.yaml`), the recovery
    code, and the lock pane, whose autofocus a rejected attempt's submit undoes
    (`subflows/unlock-pane.yaml`).
  - What can be **read back** is: the sign-in flows assert the username after
    the password, so a misplaced keystroke fails there rather than five minutes
    on as a links screen that never came. A wait cannot stop a move that starts
    after the snapshot (the sign-in's), and a pass after a retry counts as red
    here (_artifacts and retries_), so the read-back is what makes it legible.

  (`parts/visual-app-lock-gate.yaml` still taps the lock dialog's field, into a
  dialog `parts/visual-app-lock-dialog.yaml` has already waited out.)

- ⚠ **On Android the tap that focuses a field also sets its caret, and
  `eraseText` only deletes backwards from it.** A tap lands on the field's centre,
  which in the lock pane is 16 characters in (Pixel 8 AVD): a refused
  28-character password kept its last 12, the real one was typed in front of
  them, and the retry read as a lock refusing its own password — no count fixes
  it. `subflows/unlock-pane.yaml` carries the answer and the measurements: erase,
  send the caret to the end with Dpad Down, erase again, re-tap. ⚠ Dpad Down on a
  caret already at the end moves the FOCUS to the next control instead, which is
  why that order, and why it runs only where a refusal is showing. iOS puts a
  secure field's caret at the end on tap. `recovery-sign-in.yaml` meets the same
  `eraseText` from the other side (a caret at index 0) and remounts the form
  instead.

- **A Maestro tap on the Pixel 8 AVD returns about six seconds after it presses.**
  Feedback shorter than that — bulk Copy's 1.5s "Copied" — has reverted before any
  assertion can run, so `flows/bulk-copy.yaml` asserts it on iOS only and proves
  the clipboard write on both through the system Paste.
- **Maestro's `PATH` entry is in `.zshenv`, not `.zshrc`.** `runner/lib.ts` falls
  back to `~/.maestro/bin/maestro` anyway, so a shell that lost it gets a working
  run instead of `ENOENT`.
- ⚠ **Android reports a node's bounds CLIPPED to its scroller; iOS reports the
  real frame.** A row half under the list's top edge reads, on the Pixel 8 AVD,
  as a short box starting exactly on the edge — `[0,279][1080,306]`, 27px of a
  ~200px row, holding nothing but its border — so "inside the list" is true of a
  sliver and a paint check on it reads blank. `runner/mobile.ts`'s
  `paintedRows` counts only rows at (near) full height, and `VIEWPORT-BULK-001`
  compares the anchor row's offset on iOS only, its identity on both.
- **The iOS hierarchy's root reports `[0,0][0,0]`**; the window is among its
  direct children. Scale a box onto a screenshot by `screenBox` in
  `runner/hierarchy.ts`, never by the root — and never by the union of every
  node, since a scroller's content runs far past the screen.
- **A row at the very bottom of a scrolled drawer is never "100% visible" on the
  AVD.** Show All under a 24-list, 40-tag library sat painted whole at
  `[21,2111][912,2206]` of 2400 while `scrollUntilVisible` kept scrolling and
  timed out; `flows/scale.yaml` passes `visibilityPercentage: 50`.
- **Maestro's directional `swipe` does not start where you think.** With the
  keyboard up on iOS, `swipe: direction: UP` moved the links list not at all —
  the gesture began on the keys. A drag whose start point matters is generated
  from measured bounds (`writeDragFlow` with a short `duration`,
  `VIEWPORT-KEYBOARD-001`).
- ⚠ **`rightOf:` is not "on the same row".** Every settings row's ⋯ is named
  "List actions", and `tapOn: 'List actions'` with `rightOf: Private` pressed
  **My List's** — the first ⋯ right of the name, rows above included. The
  COMPLETED tap opened a real menu, the flow then locked the wrong list, and it
  failed two steps later on a lock pane that never appeared (`VISUAL-LOCK-001`,
  iOS 26.5). A control on a named row is pressed as a point from `sameRow` in
  `runner/hierarchy.ts`, the way the drag-and-drop grips are. Other flows still
  use `rightOf` on lists they have just created; the row order is what spares
  them, so check it before copying one.
- ⚠ **A system string can carry a NO-BREAK SPACE, and then no selector typed
  with a space matches it.** StoreKit's prompt reads "Sign in to Apple Account"
  in the hierarchy and is `Apple\u00A0Account` in the bytes (iOS 26.5), so
  `visible: 'Sign in to Apple Account'` and even `'.*Apple Account.*'` time out
  with the words on screen, and a host-side `===` misses it too. `xxd` the dump
  before concluding a node is unreachable; `flows/subscription-store.yaml` matches
  that one character with `.`. (The share sheet's "label is in
  `accessibilityText`, not `text`" note — [share-sheet.md](./share-sheet.md) —
  presented identically and was never byte-checked.)
- ⚠ **A StoreKit prompt outlives the app.** It belongs to the store, not to
  Bracemark, so a run that stops with it up leaves it over the NEXT case's cold
  launch — measured: the following `sign-in.yaml` timed out on "Sign in" behind a
  "Sign in to Apple Account" sheet the relaunch never touched. Press its Cancel
  (a plain `tapOn: Cancel` resolves) before re-running anything on that device.

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
  there is no per-device equivalent — see the next item for what iOS gets instead.
- **A frozen or a slow server** (`OFFLINE-IOS-001`, `SKELETON-NATIVE-001`).
  `runner/api-pause.ts` signals the api's own `workerd` process: `SIGSTOP`
  freezes it, `SIGCONT` thaws it, and `throttle` alternates the two (stopped
  900ms of every 1000). The fault is a HANG, not Android's refusal — the kernel
  still accepts the connection and the request waits — and nothing is lost: on
  thaw every held request is served. It stalls every client of the local api at
  once, so it is a serial-runner tool only, and the thaw is registered on exit,
  SIGINT and SIGTERM as well as in the case's cleanup: a frozen api outliving a
  run wedges every later one with nothing to say why. If a run was killed hard
  (SIGKILL) and the stack stopped answering, `kill -CONT` the 8787 listener.
- **Pixels** (`VIEWPORT-BULK-001`, `SKELETON-NATIVE-001`). A cell that drew
  nothing is still in the tree with bounds, so the painted half of a viewport
  claim reads a device screenshot (`simctl io … screenshot`, `screencap -p`)
  through `runner/pixels.ts` — a minimal PNG decoder, the twin of
  `seed/png.ts` — and requires ink (luma off the box's dominant colour) inside
  each row's box. Painted rows measured ~0.08–0.15 on both devices; a blank cell
  is ~0; the floor is 0.02.
- **The keyboard's frame** (`VIEWPORT-KEYBOARD-001`). `runner/keyboard.ts`: on
  iOS the keyboard is in Maestro's tree as its `inputView` host, whose frame
  includes the suggestion strip; on Android the IME is its own window and not in
  the app's tree at all, so the frame is the touchable region `dumpsys window
InputMethod` reports while the window is visible. Every "reachable" claim is a
  control's bounds wholly above that frame's top.
- **Whether a keyboard is up at all** (`LOCK-APP-002`). The same reader, asked
  twice between the case's flows: UP on the gate a cold start lands on, DOWN on
  the gate "Lock app" raises, and then a part that unlocks it anyway. It is a
  host step because no flow can say it — the Android IME is in no tree, and
  `subflows/unlock-pane.yaml` taps the field before it types, so a flow that only
  unlocked would pass over an autofocus that had stopped working, or one that had
  come back where it must not. The browser's half of the same rule is focus, not
  a keyboard, and is asserted in `web/locks.e2e.ts` (`LOCK-APP-001`,
  `LOCK-FOCUS-WEB-001`); what each case pins is in
  [locks.md](./locks.md), _a hand relock does not ask to be undone_.
- **A tap on a region, not a control** (`VIEWPORT-KEYBOARD-001`).
  `writeTapFlow` taps a coordinate read off the controls around it — the add
  panel's header level with its ✕, the empty links pane above the keyboard, the
  share sheet's gap under its field — because what is being tapped is the surface's own dismiss layer
  ([soft-keyboard.md](./soft-keyboard.md), _dismissal_), which has no name.
- **Across a real share boundary** (`SHARE-*`). A host step opens Safari with
  `simctl openurl` or launches Android's exported `ShareActivity` with a real
  `ACTION_SEND`; committed Maestro parts make every assertion on the system
  sheet, the share tree, or the foregrounded app. On iOS the system row still
  needs the measured coordinate tap described in [share-sheet.md](./share-sheet.md),
  immediately followed by a `share-*` testID that only the extension renders.
  On Android the helper quotes each `adb shell` word before passing a multi-word
  subject, and the already-running case records the app PID on both sides of the
  share. That case also changes the system appearance and puts it back
  (`cycleAppearance`, `runner/device-look.ts`) between choosing the list and tag
  and pressing Save — which is why the sheet is driven by two parts,
  `share-pick.yaml` and `share-save.yaml`, where one would read better. A
  configuration change `ShareActivity` does not declare recreates it and the
  sheet comes back on the default list; the second part opens by asserting the
  two rows again. Appearance and not rotation, because the sheet is opened over
  the launcher, which does not rotate on a phone — a rotation step there would
  pass without the display ever turning. So `orientation` and `screenSize` in
  that list are held by a hand check only ([share-sheet.md](./share-sheet.md),
  _the shape_). The killed-app case removes only the API reverse while saving so the
  next launch has a real pending op to drain; cleanup restores it even after a
  failure. Cross-client proof signs a separate persistent web profile into the
  account and requires exactly one row after an explicit native sync.
  `SHARE-CREATE-001` is Android-only: after the first text edit in an iOS share
  extension, XCTest exposes Safari's tree and routes later taps there even while
  the extension remains painted. iOS still proves the real system handoff,
  existing taxonomy pickers, save, outbox drain and cross-client upload; the
  shared create state machine stays at component level. Do not replace the
  missing iOS gesture with screen coordinates and call it a pass.
  The `SHARE-EXTRACT-*` pair is the killed-app shape with the one thing every
  other share case avoids: a page the device can fetch (example.com, so
  `internet`). Its subject is the page fetch a share is owed at the default
  `saves` mode, which only the main app can make and only if it is told which
  link arrived ([share-sheet.md](./share-sheet.md), _the main app's half_). The
  two platforms need different oracles, because the two shells are handed
  different titles. Android's `EXTRA_SUBJECT` is the run-scoped title, which the
  page does not have, so the row has something to change FROM and the part
  waits for the page's own. Safari gives the iOS share extension the document's
  real title, so there the provisional title and the extracted one are the same
  string and no row can tell a fetched page from an unfetched one. The iOS part
  reads the "links without a preview" prompt instead: it arms two seconds after
  a link is seen pending with nothing fetching it, so it comes up for a draft
  drained into a dead `extractNow` and never for one a live `extractNow` took.
  ⚠ That oracle is an ABSENCE, so the part first waits — optionally, and
  expecting to time out — for the prompt's `Dismiss`, and only then asserts it
  is not there. Asserted straight after the row appears it would pass on a
  prompt that had not armed yet.
- **One flick, opposite outcomes** (`SHARE-IOS-003`). The host's own sheet
  answers a downward drag on the iOS share extension, and the two pickers ask
  native to hold that off while they are up
  ([share-sheet.md](./share-sheet.md), _the pickers hold the system's swipe
  off_). Nothing in the tree says whether the hold is on, so the claim is made
  with a gesture: a host step reads the screen and writes a 50ms flick to the
  bottom edge (`writeDragFlow`), from inside each picker's scroller and from its
  header, and a committed part asserts the picker is still up; then the SAME
  header flick on the compose screen must take the sheet away. Both halves are
  needed. A flick too weak to dismiss anything passes on the pickers alone, and
  a guard that never lets go passes there too — it is the compose flick that
  fails for either. ⚠ The speed is the gesture, and a slower one is not a safer
  one: with the hold removed, the ~175pt pull from a picker's scroller dismisses
  the sheet at 50ms and at 100ms only starts the dismissal and settles back
  (iOS 26.5, iPhone 17 Pro) — so at 100ms those steps stayed green with no
  guard at all, which is how the first draft of this case was written. No text
  is entered, for
  `SHARE-CREATE-001`'s reason. ⚠ **A swiped-away extension lands on the system
  share sheet, not on Safari** — a swipe cancels the request where the sheet's
  own Close completes it — so the far-side assertion is that sheet's Bracemark
  row, and the flow then taps outside the popover to hand the next case a bare
  Safari.

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

⚠ **`wrangler d1 execute --json` reports a failed statement on stdout**, as
`{"error": {"text": …}}`, with stderr empty — and a child-process error's message
is the command line plus stderr. So the reason is in neither the message nor the
trace unless `d1Once` (`e2e/seed/d1.ts`) puts it there, and a check written
against the message matches nothing. That is how the busy retry came to retry
nothing: a grant that lost the race failed its case on the first attempt with a
bare `Command failed`, and Playwright's own retry passed it, so the suite reported
a flake rather than a broken guard. Holding a write lock on the local directory
database while a statement runs is the whole reproduction.

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

| testID                        | where                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `sign-in-username`            | `src/features/auth/sign-in-form.tsx`                                                            |
| `sign-in-password`            | `src/features/auth/sign-in-form.tsx`                                                            |
| `sign-in-submit`              | `src/features/auth/sign-in-form.tsx`                                                            |
| `sign-in-error`               | ” — the submit-level `root` error                                                               |
| `sign-in-use-recovery`        | ” — the toggle into the recovery door                                                           |
| `sign-in-recovery-username`   | ” — `RecoverySignIn`                                                                            |
| `sign-in-recovery-code`       | ” — `RecoverySignIn`                                                                            |
| `sign-in-recovery-submit`     | ” — `RecoverySignIn`                                                                            |
| `sign-in-recovery-error`      | ” — `RecoverySignIn`                                                                            |
| `sign-in-use-password`        | ” — the toggle back out                                                                         |
| `links-screen`                | `src/app/(app)/links/index.tsx` (a root marker)                                                 |
| `links-open-navigation`       | `src/features/links/topbar.tsx`                                                                 |
| `links-nav-list-<id>`         | `src/features/links/sidebar.tsx` — a drawer row                                                 |
| `links-nav-tag-<id>`          | ” — the tag rows                                                                                |
| `links-nav-all`               | ” — Show All                                                                                    |
| `links-more-options`          | `src/features/links/more-options-menu.tsx`                                                      |
| `links-sync`                  | ” — the Sync menu item (`syncNow`)                                                              |
| `links-open-settings`         | ” — the Settings menu item                                                                      |
| `links-list`                  | `src/features/links/main.tsx` — the FlashList, the viewport bounds are read against             |
| `links-refresh-pill`          | `src/features/links/shared.tsx` — the "New updates" pill                                        |
| `links-empty`                 | ” — the settled empty state, never the loading bones; a scroller, its bounds are the empty pane |
| `add-link-url`                | `src/features/links/link-add-panel.tsx`                                                         |
| `add-link-save`               | ” — the submit, whose label flips Save→Confirm                                                  |
| `add-link-optional`           | ” — the "List, tags & note" disclosure                                                          |
| `add-link-list`               | ” — the optional fields, each named like its label                                              |
| `add-link-tags`               | ”                                                                                               |
| `add-link-note`               | ”                                                                                               |
| `add-link-cancel`             | ” — the explicit discard                                                                        |
| `edit-link-title`             | `src/features/links/link-edit-screen.tsx`                                                       |
| `edit-link-list`              | ”                                                                                               |
| `edit-link-tags`              | ”                                                                                               |
| `edit-link-note`              | ”                                                                                               |
| `edit-link-save`              | ”                                                                                               |
| `edit-link-cancel`            | ” — the explicit discard                                                                        |
| `list-picker-search`          | `src/components/links/list-command.tsx`                                                         |
| `list-picker-create`          | ” — the Create row                                                                              |
| `tag-picker-search`           | `src/components/links/tags-command.tsx`                                                         |
| `tag-picker-create`           | ” — the Create row                                                                              |
| `tag-picker-rows`             | ” — the rows' scroller, for `childOf`                                                           |
| `tag-picker-done`             | `src/components/links/tags-field.tsx`                                                           |
| `link-options`                | `src/features/links/link-row-menu.tsx` — a row's ⋯                                              |
| `link-menu-<action>`          | ” — `edit` `pin` `unpin` `archive` `unarchive` `remove` `restore` `delete`                      |
| `link-destroy-submit`         | `src/features/links/link-destroy-confirm.tsx`                                                   |
| `links-title`                 | `src/features/links/topbar.tsx` — the view the route projects                                   |
| `links-search-toggle`         | ” — summons the search row                                                                      |
| `links-search-input`          | `src/features/links/search-bar.tsx`                                                             |
| `links-search-clear`          | ”                                                                                               |
| `links-search-advanced`       | ” — opens the advanced sheet                                                                    |
| `advanced-search-<field>`     | ” — `text-all` `text-any` `text-none` `url` `title` `note`                                      |
| `advanced-search-submit`      | ” — also `-clear`, `-close`                                                                     |
| `links-select-links`          | `src/features/links/more-options-menu.tsx` — enters bulk edit                                   |
| `links-lock-app`              | ” — relocks the app                                                                             |
| `bulk-count`                  | `src/features/links/bulk-edit-bar.tsx`                                                          |
| `bulk-<action>`               | ” — `exit` `select-all` `copy` `move` `more` `remove` `restore` `delete`                        |
| `bulk-menu-<action>`          | ” — `edit-tags` `pin` `unpin` `archive` `unarchive`                                             |
| `bulk-tags-save`              | `src/features/links/bulk-tags-dialog.tsx`                                                       |
| `list-picker-rows`            | `src/components/links/list-command.tsx` — the rows' scroller, for `childOf`                     |
| `list-menu-<action>`          | `src/features/settings/lists-section.tsx` — `move-to` `lock` `unlock` `remove-lock`             |
| `app-lock-set`                | `src/features/settings/misc-section.tsx` — also `app-lock-remove`                               |
| `lock-dialog-<part>`          | `src/components/lock-password-dialog.tsx` — `password` `checkbox` `submit` `error`              |
| `app-lock-pane`               | `src/components/app-lock-gate.tsx` — the gate is up                                             |
| `list-lock-pane`              | `src/features/links/main.tsx` — a locked list's pane is up                                      |
| `lock-pane-<part>`            | `src/components/lock-pane.tsx` — `password` `unlock` `error`                                    |
| `settings-open-navigation`    | `src/features/settings/topbar.tsx`                                                              |
| `settings-close`              | ” — returns to the links route                                                                  |
| `settings-nav-<section>`      | `src/features/settings/sidebar.tsx`                                                             |
| `settings-back`               | `src/features/settings/settings-kit.tsx` — a sub-view's back link (its label repeats the title) |
| `measure-stall-reading`       | `src/features/settings/data-section.tsx` — measurement bundles only (`measure:native`)          |
| `export-data-format-<format>` | ” — `bracemark` `netscape` `csv` `text` export radio rows                                       |
| `extraction-mode-<mode>`      | `src/features/settings/extraction-section.tsx` — `off` `saves` `all` radio rows                 |
| `extraction-count-<bucket>`   | ” — the number in `done` `pending` `will-retry` `wont-retry`                                    |
| `extraction-progress`         | ” — "N of M links previewed."                                                                   |
| `extraction-generate-all`     | ” — also `extraction-pause`, which replaces it while the job runs                               |
| `delete-all-open`             | `src/features/settings/data-section.tsx`                                                        |
| `delete-all-confirm`          | ” — the confirmation checkbox row                                                               |
| `delete-all-submit`           | ” — the destructive action                                                                      |
| `delete-all-complete`         | ” — renders only after a successful wipe                                                        |
| `delete-account-open`         | `src/features/settings/account-section.tsx`                                                     |
| `delete-account-password`     | ” — the fresh-proof password re-entry                                                           |
| `delete-account-confirm`      | ” — the confirmation checkbox row                                                               |
| `delete-account-submit`       | ” — the destructive action                                                                      |
| `share-title`                 | `src/features/share/share-specimen.tsx` — the payload title                                     |
| `share-url`                   | ” — the normalized address                                                                      |
| `share-add`                   | `src/features/share/share-screen.tsx` — the Save action                                         |
| `share-list-row`              | ” — the current destination disclosure                                                          |
| `share-tags-row`              | ” — the current tag-set disclosure                                                              |
| `share-saved`                 | ” — the durable-save confirmation                                                               |
| `share-signed-out`            | ” — the no-session terminal state                                                               |
| `share-no-url`                | ” — the no-HTTP-URL terminal state                                                              |
| `share-quota`                 | ” — the at-cap terminal state                                                                   |
| `share-list-input`            | `src/features/share/share-list-picker.tsx`                                                      |
| `share-list-create`           | ” — the new-list action                                                                         |
| `share-tag-input`             | `src/features/share/share-tags-picker.tsx`                                                      |
| `share-tag-create`            | ” — the new-tag action                                                                          |
| `share-close`                 | `src/features/share/share-kit.tsx` — the process/surface exit                                   |
| `share-back`                  | ” — a picker's header control, back to the compose screen                                       |
| `share-backdrop`              | ” — the dismiss layer behind the panel; a flow asserts its ABSENCE, never taps it               |
| `subscription-plan`           | `src/features/settings/subscription-section.tsx` — the current plan's name                      |
| `subscription-refresh`        | ” — re-reads `GET /v1/iap/status`                                                               |
| `subscription-price-<plan>`   | ” — the upgrade card's price: the store's, or the planning placeholder                          |
| `subscription-upgrade-<plan>` | ” — the upgrade card's button; enabled only once the store returned the product                 |
| `subscription-restore`        | ” — Restore purchases                                                                           |
| `subscription-notice`         | ” — the result notice; also `subscription-error`                                                |
| `paywall`                     | `src/contexts/paywall-provider.tsx` — the upgrade dialog is up                                  |
| `paywall-<action>`            | ” — `upgrade` `dismiss`                                                                         |
| `contract-vectors-pass`       | `src/app/contract-vectors.tsx` (dev-only)                                                       |
| `contract-vectors-fail`       | ” — carries the failing check names in its text                                                 |
| `vector-<check>`              | ” — one per vector, `PASS`/`FAIL`/`RUNNING`                                                     |

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
| `SYNC-CURSOR-001`                            | two web profiles saving at once, one commit held           |
| `SYNC-LISTING-001`                           | a web profile signing in while another one saves           |
| `SYNC-RETRY-001`                             | a first sync cut short, a delete elsewhere, then the retry |
| `SYNC-TABS-001`                              | two tabs of one profile → an independent web profile       |

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

**The last four are the cases where two clients are busy at the same moment**,
which every row above them avoids: there one client writes and another reads
afterwards, in turn. Each used to end with the two sides disagreeing in silence
— the cycle complete, the queue drained, the indicator idle
([local-first-sync.md](./local-first-sync.md), _the cursor is a claim_ and _two
tabs, one queue_). The engine's specs hold the decisions, against a server model
and two copies of the module; what only this layer has is the real things those
stand in for — the Durable Object's clamp and keyset pull, R2's paged listing,
two profiles with a store each, two tabs with ONE store and a Web Lock between
them, and the gate's own Try again.

They are built on one instrument, `web/fixtures/hold.ts`: **hold one request of
one page, and release it on command.** A uniform delay cannot produce these
races — every client slows down together and the order of arrivals never
changes. They need one transfer of one client to stay out while another client
gets a whole cycle in, and holding a single request is exactly that: the held
request is the app's own and goes on unmodified, and every other page's traffic
is untouched, so whatever the other client then does it does unaided. Three
things about using it:

- **A device's first sync starts inside `launchApp`**, the moment its sign-in
  lands, so a route added after `launchApp` returns is already too late for it.
  `LaunchOptions.prepare` runs on the fresh context before the account ceremony
  for that reason (`SYNC-LISTING-001`, `SYNC-RETRY-001`).
- **Only two things are ever changed on the wire, and each case names its own.**
  `SYNC-LISTING-001` rewrites the listing's `limit`, so that six links page the
  way six thousand do — a legal answer, since the api may return fewer than it
  was asked for. `SYNC-RETRY-001` fails blob downloads, which is the dropped
  connection it is about. No clock is mocked and no response body is edited.
- **The library is built through the app, never from the paged-library
  fixture.** That fixture's ids all sort after any random id, so a link saved
  during a listing could never land BEHIND it and the case would pass on the
  engine that lost links.
- **The behind link is looked for by scrolling, not by its absence.** The case
  saves until one link lands ahead of the listing, which can take a couple of
  dozen saves; the behind link is the oldest of them, and past ~18 rows the
  virtualizer has not mounted it. Read as `toHaveCount(0)`, that was a flake
  that looked exactly like the bug the case guards — the reader had downloaded
  the link, and it was in the store, one screen down.

`SYNC-TABS-001` reads the server the only honest way — through a device that
has nothing but what the server gives it — because the failure it guards left
the local store correct and the server wrong.

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

### scale, loading and offline

The Phase 8 cases, and the one decision in each that a reader would otherwise
have to rediscover.

**Paging a real library** (`SCALE-WEB-001`, `SCALE-IOS-001`/`-ANDROID-001`). The
generated library pins every 37th link, so most pins sit pages deep in the date
order — exactly where the pinned overlay's "excluded from the rest"
([client-queries.md](./client-queries.md), _the pinned overlay_) either holds or
shows the link twice. The fixture computes Show All's expected order from the
entities it hands the importer. On web every rendered row carries the
virtualizer's `data-index`, so the case requires each deep pin's two date
neighbours to be CONSECUTIVE indices and the known last row to sit at exactly
`pins + rest − 1` — one extra row anywhere above it and that index is off by
one. Native has no index, and its rows print a title the generator repeats
every 24 links, so a flow can only scroll to a row that prints its (unique)
address: the runner picks deep pins whose upper neighbour is such a row, and
reads the two neighbours' bounds back to back (`assertClosedOver`). Breaking the
exclusion (`readRest` handed no pinned paths) fails the web case on its first
pin, counted twice.

**The web first read, held** (`SKELETON-WEB-001`). The skeleton exists only
until the links page's first `readLinks` answers — tens of milliseconds — so a
second tab of the same origin (`web/fixtures/store-hold.ts`) holds a read-write
transaction on the `items` store, and IndexedDB queues the app's own read-only
one behind it. It is contention, not a stub: nothing in the app is replaced,
nothing is written, and it is the wait a long import in another tab really
causes. The session, `syncMeta` and `localSettings` stay readable, so the shell
comes up; the card variant is reached through the DEVICE layout setting for
that reason — the synced one lives in `items` too and would read as the default
while held. The case checks the bones are painted inside the viewport (a grid,
for cards), the status region's polite announcement, and the rows arriving on
release without a reload. Observed while held and not chased: the sidebar says
"No tags yet" and lists no system lists — a read that has not answered is drawn
as an empty one.

**The native loading state** (`SKELETON-NATIVE-001`). The native bones are not
reachable honestly: expo-sqlite answers on the device in a frame, and nothing
outside the app can hold that read without replacing the data hook — which is
the one thing the case may not do. What a person with a real library does wait
through on a new phone is the first pull, "Decrypting your links…", and the
network is something a runner can hold. So the case signs in to a 1,000-link
account with the api throttled (unthrottled, the whole pull finished inside the
seconds it took to get iOS's "Save Password?" sheet off it), freezes the api
once the first-pull progressbar is on screen, reads it held — its bounds, and
ink in the band around it — and thaws: the SAME pull finishes into the links
screen with no retry or relaunch. The list bones stay covered at component
level. They DO show on the Pixel 8 AVD straight after that pull — photographed
once, with the topbar's title still blank — because the first read of a
thousand links lands in frames busy enough that a single Maestro wait for the
rows failed in under a second on a hierarchy read; `parts/loading-released.yaml`
paces that wait. A slow frame is not a lever, so nothing asserts on it. Android
also folds the progressbar's value into its name ("Decrypting your links, 440 of
2,073 items"), where iOS names it by the label alone; the parts match both.

**Bulk mode at an offset** (`VIEWPORT-BULK-001`). The claim is the scroll
position, and the position is the row crossing the list's top edge: FlashList
anchors that one. Rows BELOW it may legitimately move — bulk mode hides each
row's ⋯, so a title that wrapped around it re-measures a line shorter (measured
on iOS: the first fully visible row rose 20pt while the anchor held). Every
full-height row in the list must also carry ink in every state.

**The keyboard** (`VIEWPORT-KEYBOARD-001`). Three surfaces: the add panel (URL
on arrival, then the multiline Note, which return cannot dismiss), the links
search box, and — Android only — the share sheet's tag picker, whose field
submits instead of blurring. Each is measured against the keyboard's real
frame, then dismissed by the app's own path: a tap on the panel's chrome, a drag
on the results, a tap on the sheet's gap — never `hideKeyboard`. Each dismissal
must leave the surface and its draft in place. The search box is visited twice,
because its pane is two different things: over results the exit is the drag, and
over a search that matched nothing the list is not mounted at all — the empty
state stands in for it, and has to be a scroller to answer anything
([soft-keyboard.md](./soft-keyboard.md), _dismissal_, 2). There the runner taps
the bare pane above the keyboard and then, with the box refocused, drags it;
after each the search must still be committed, the box still holding its word.
Both gestures are made on both platforms, and they are not one check twice: the
drag is `on-drag`'s on iOS and `"handled"`'s on Android. iOS's share sheet is left out
because its panel leaves the accessibility tree while the keyboard is up
([soft-keyboard.md](./soft-keyboard.md), _verifying any of this_); a pass there
would be a coordinate tap with nothing to confirm against.

⚠ **On Android the drag is explicit touch events, because `input swipe` can
arrive as a tap.** The case was intermittently red there (4 of 8 runs): the drag
on the search results opened the link under the finger. That was the driver,
not the app. `input swipe` waits for the app to finish each injected event and
spends only what is left of its duration on moves. A touch-down the dev build
was slow to finish, which happened right after Maestro had typed and read the
hierarchy, left no time for any move, so the app got a DOWN on a row and an UP
far above it. No view saw a move, so the list never took the gesture and the
row's `Pressable` fired on release. A finger cannot produce that, because the
platform delivers a busy app its batched moves before the UP. The runner now
drags with one `input motionevent` per step (`androidDrag`,
`runner/mobile.ts`), and `keyboardGone` still requires the search box on screen
afterwards, so a regression to a tap is still caught by name. Measurements and
the AOSP mechanism: [app-drivers.md](./app-drivers.md), _`input swipe` can
arrive as a tap_.

⚠ **An iOS simulator can hide its software keyboard with Simulator's setting
correctly off.** The simulated device remembers a hardware keyboard
(`HardwareKeyboardLastSeen` in its `com.apple.keyboard.preferences`) and then
minimizes the software one to nothing — measured on iOS 26.5: a caret and an
edit menu, no keys. Every earlier keyboard-shaped flow would have passed on it.
The iOS preflight now refuses such a device and prints the `simctl` commands
that clear it — a device REBOOT, not a SpringBoard restart, which left
SpringBoard segfaulting mid-run for hours afterwards
([app-drivers.md](./app-drivers.md), _the software keyboard_).

**Offline** (`OFFLINE-WEB-001`, `OFFLINE-IOS-001`/`-ANDROID-001`, `PWA-*`). Web
cuts the browser with `context.setOffline` on a page that stays open; the dev
server has no worker, so a reload is the PWA target's. Android removes its api
route (a refusal); iOS freezes the api (a hang) — the two platforms meet the two
fault shapes a phone does. The native part starts with a cold start while cut
off, which is secure-store and SQLite with no server to ask. Every case ends
with an independent web profile reading the drained queue, pulled until it
does, since a device given the api back may still be pushing.

`OFFLINE-WEB-001` found an app bug on its first run: offline, one sidebar click
took the open links page to Chrome's error page — `router.push` fetches the
route's RSC payload and falls back to a full document load when it cannot. The
links page's view changes now go through the History API
([search.md](./search.md), _two writers, not a mirror_); the same click
before the fix fails the case at its first view change.

**The server gone** (`OFFLINE-EXPORT-WEB-001`, `OFFLINE-API-ERROR-WEB-001`,
`SESSION-INVALID-WEB-001`, `PWA-003`, and the native four below). The question
they answer together: a
signed-in, synced user whose server disappears keeps a working library and can
take it away. Each fault shape gets its own case, because the app must answer
them differently:

- **No network.** `OFFLINE-EXPORT-WEB-001` exports as plain text (an ordinary
  download; the backup's save dialog is out of reach — _what e2e may not
  assert_) with the browser offline, and the file carries a link written offline
  and never pushed. The receipt must say the file is this device's copy.
- **The api answers, wrongly.** `OFFLINE-API-ERROR-WEB-001` fulfils every api
  request with 500, then 404 — WITH CORS headers, or the browser would refuse
  the response and the app would see the offline case again (a probe during
  authoring counted real 500s and 404s arriving). Only the api is gone, so the
  page can reload, and that is the sharp half: a boot that read either status as
  "signed out" would wipe a library it could no longer re-download. It then
  exports, and drains the queue to a second profile once the api returns.
- **The api says the session is dead.** `SESSION-INVALID-WEB-001` revokes the
  session the way a user does — Sign out other devices, from a second profile —
  so the next request earns a real 401. That, and only that, ends in the
  teardown: the local store is counted empty by table name (as `store-hold.ts`
  addresses it) and the page lands on `/sign-in?next=`. Signing back in brings
  the library back from the server — and the sign-in screen says this device
  was signed out from another. Which 401s may wipe is
  [sessions.md](./sessions.md)'s rule.
- **The api says the session is over, but not to forget.** Every other ending
  keeps the library. `SESSION-EXPIRED-WEB-001` expires the session the way a
  user does — a password change on a second profile (`session_expired`); the
  page pauses sync in both its tabs, keeps its library and an edit queued while
  paused through a reload, resumes in the other tab with the new password, and
  the queued edit reaches a fresh reader. `SESSION-UNKNOWN-WEB-001` replaces the
  stored token with one the server never issued — what a purged row looks like
  from the device (`session_unknown`) — and resumes the same way.
  `SESSION-UNKNOWN-NATIVE-001` is its twin on a device, where the stored token
  is out of reach: the runner deletes the account's session rows from local D1
  instead (`seed/sessions.ts`, beside the plan grant in `seed/plan.ts`; both go
  through `seed/d1.ts`).
  `SESSION-RACE-WEB-001` holds a menu sign-out request while another tab resumes,
  requires the sign-out dialog to close after the superseded request settles,
  then delivers a revoked response for the old token. The replacement session
  and a link queued after resume must survive that response and a reload.
  `WEB-ACCOUNT-003` reloads with the device clock two years ahead: still signed
  in, library intact.
- **Two accounts take turns on one profile.** `WEB-ACCOUNT-004` signs out, creates
  a second account on the same profile, writes and syncs as it, signs out, and
  signs the first back in. The second account starts empty and its first write
  lands; the first finds its own library and nothing of the second's. It pins
  `setSession`'s order — wipe, then claim or seed the store's ownership, then
  persist — which a single-account case never exercises: a seed that lands
  before the wipe fails the second account's first write, and a sign-in that
  leaves the claim to a sync cycle fails the first account's pull.
- **No username in an address or a header.** `WEB-ACCOUNT-005` takes the same
  three journeys — Settings → Account's recovery-door check, a second account's
  creation, the first one signing back in — and records every request the
  profile sends the api. Neither username may appear in a URL or a header value
  of any of them, and each lookup's body must have named one, which is the
  positive control: a client that stopped asking would otherwise pass with
  nothing to have leaked. It is the browser's half of a published sentence
  ([api-contracts.md](./api-contracts.md), _a GET's query string reaches the
  request log_) — a `fetch` built beside the contract client, or a header a
  wrapper adds, passes every unit spec. Admitted to staging, where it is also
  the deploy gate for that sentence: a tier still running the GET lookups never
  sends the POSTs the positive controls wait for.
- **A newer build takes the database.** `VERSION-SKEW-WEB-001`/`002` open each
  local database one version up from a second tab, under an open editor with a
  typed title: the upgrade must not block, the old tab shows the update-required
  banner, and the draft is still on screen ([offline-mode.md](./offline-mode.md),
  _version skew_). The data case then opens a fresh tab, which must show the
  banner while still signed in, not `/sign-in`. The session-schema case also
  attempts Save: the obsolete tab must refuse the write and keep the draft
  available to copy. Isolated profiles: the upgrade is permanent for the profile.

⚠ **An offline DEV-SERVER tab cannot reach Settings.** Found writing
`OFFLINE-EXPORT-WEB-001`: offline, the menu's Settings link took the open page to
Chrome's error page — the same `router.push`-falls-back-to-a-document-load as the
sidebar bug above, on a route the History API fix does not cover. The dev server
runs no service worker (`SerwistProvider disable` in development), so nothing
can supply the route's payload. The web case therefore opens `/settings/data`
in a second tab before the network goes. In the production build a plain tab
registers the worker at sign-in, and the precache carries every route's RSC
payload, so the in-app route works offline there: `PWA-004` proves it in a tab,
`PWA-003` in the installed app.

**The server gone, on a device** (`OFFLINE-EXPORT-IOS-001`/`-ANDROID-001`,
`OFFLINE-API-ERROR-ANDROID-001`, `SESSION-INVALID-NATIVE-001`,
`SESSION-EXPIRED-NATIVE-001`, `SESSION-UNKNOWN-NATIVE-001`). The same three
questions, each answered from outside the app. Export reaches Settings in-app —
native navigation needs no network, so the tab's gap has no native twin — and
the runner reads the plain-text file out of the export's own directory in the
app's cache, `bracemark-exports/<run>/` (`runner/device-files.ts`: the simulator's
data container, or `run-as` on Android's debuggable build), since Maestro sees
the share sheet and not the file. ⚠ That directory's name is written twice, in
`@stxapps/expo-react`'s `data/cache-files.ts` and in the runner, because the
runner asks the app nothing: when the export moved there from the cache root
the reader kept looking in the root, and nothing said so until these cases were
next run on a device. The revoked session is counted the same way: `bracemark-data.db` and its
WAL copied off the device and read with `sqlite3`, non-empty before the revoke
and empty after.

The 500/404 case is **Android only**, and not for want of a lever on iOS: the
emulator reaches the api through its `adb reverse` mapping, so pointing that
mapping at a stand-in (`runner/api-fault.ts`) is a per-device fault that leaves
the real api serving everyone else. The simulator shares this Mac's loopback,
so its `:8787` IS the real api's listener — the only fault it can be given is
the freeze, a hang. The stand-in's body is plain text, not the api's error
shape: a server that has gone does not speak the contract. Its cold start under
404 is the native reload, and must restore the session.

The receipt's wording is not the subflow's to assert: the cases above export
with the api out of reach and follow it with
`subflows/assert-export-local-copy.yaml`, which finds the sentence that calls
the file this device's copy; `SIGN-OUT-RESIDUE-NATIVE-001` exports online, where
there is no such sentence.

Two things the export flow waits on deliberately (`subflows/export-plain-text.yaml`):

- **The share sheet, not the receipt.** A finished export presents the sheet
  over its own receipt, and the receipt paints a beat FIRST — so the shape
  "poll for the receipt, dismiss a sheet if one is up" ends on the bare receipt
  and the sheet lands on it afterwards (both orders measured on the Pixel 8
  AVD). The flow waits for the sheet, which the run always presents, and puts
  it away before reading the receipt. The measurement leg
  (`measure/flows/dismiss-share-sheet.yaml`) does the same.
- **⚠ Android 16's chooser is titled "Sharing 1 file"**, not "Share": a match on
  `'Share'` does not find it on that image, so both flows match
  `'Sharing \d+ files?'`.

**What a sign-out leaves on a device** (`SIGN-OUT-RESIDUE-NATIVE-001`). The
unit specs under the teardown each guard a place the code knows it writes — the
tables, the freed pages, the cache directories it names
([data-lifecycle.md](./data-lifecycle.md), _what an empty table does not mean_).
This case asks the device instead, and asks about all of it: the runner reads
**every file in the app's sandbox** (`runner/device-files.ts`, `scanAppSandbox`)
and reports which hold a string the case seeded. The account arrives with one
link and one list written on the web; the device signs in, shows both, and
exports the library as plain text, the largest plaintext the app writes outside
its store. The markers are the link's host, its path and the list's name — host
and path apart, so a writer that escapes the slash between them still matches
both — and, on Android, the account's username. Each must be in at least one
file **before** the sign-out, or finding none after would prove nothing; none
may be in any file after it.

Android's sandbox comes across as one `tar` stream through `run-as` and is
scanned on this Mac; iOS is read in place, the data container plus the App
Group container the share extension reads (`simctl get_app_container … groups`),
since the taxonomy's mirror there is plaintext too
([share-sheet.md](./share-sheet.md)). A scan that finds no `bracemark-data.db`
fails rather than passes: the store outlives a sign-out as an empty file, so its
absence means the wrong place was read.

Both scans are written beside the case's artifacts (`N-sandbox-before.json`,
`N-sandbox-after.json`) with **every file they read**, and the second list is the
other half of the case: an inventory of what a signed-out device still holds,
which is where a writer nobody listed shows up. Reading it is a person's job —
no assertion can say whether a file it did not expect is harmless.

Measured 2026-10-08 on the Pixel 8 AVD (Android 16) and the iPhone 17 Pro
simulator (iOS 26.5), green on both. Before the sign-out the markers were in the
export and in the store's WAL, and on iOS the list's name was also in the App
Group's `share/taxonomy.json`; after it, in nothing. The sign-out removed the
export and that mirror and emptied the store.

**The username is a marker because the second list is where it was found.** On
its first run the case was green and the inventory was not: Android's list still
held React Native's OkHttp cache, `cache/http-cache/`, sixteen files of this
app's own api GETs — `password-door?username=…` among the request URLs. Nothing
in the teardown reaches that directory, so the fix went to the source:
bracemark-api now marks every response `no-store`
([api-contracts.md](./api-contracts.md), _no response is cacheable_), and the
same list then held that directory's `journal` and nothing else. With the
username a marker, the header's removal turns this case red on Android.

⚠ **Not on iOS, and the reason is the harness.** These runs are dev builds, and
the dev client's network inspector stores every response in the simulator's
URL cache whatever the api says (same section of api-contracts.md): the
username is in `Library/Caches/com.bracemark.app/Cache.db-wal` after a
sign-out, with `no-store` in place, on a correct app. A marker that can never
be absent proves nothing, so iOS keeps the three content markers, and **what a
release build's URL cache keeps is not measured by any run here**.

⚠ What it cannot see, none of which fails it:

- **Plaintext that is not text.** The markers are searched as UTF-8 and UTF-16
  bytes, so a zip export, a decoded preview image and the OS's app-switcher
  snapshot hold them invisibly.
- **Anything fetched from a saved site.** The link is `.invalid`, so no page,
  preview or favicon was ever downloaded for it and there is nothing of that
  kind on the device to leave behind (_what e2e may not assert_).
- **A process killed mid-write.** What a kill leaves in the scratch directory is
  pinned in `@stxapps/expo-react`'s `lib/device-extraction.spec.ts`; a flow
  cannot time a kill.
- **Anything it did not seed**, and on iOS the username (above).

⚠ **`OFFLINE-EXPORT-IOS-001` is red, and the product is why.** With the api
frozen — connections accepted, never answered — the export sat on "Refreshing
from the server…" for the flow's whole six-minute budget (measured on the
iPhone 17 Pro simulator, iOS 26.5). The export's opening sync refresh has no
timeout of its own, and neither does any api call under it, so a hung server
blocks the export for as long as the platform's networking waits. A refusal
(Android's removed route) or a 500/404 fails fast, which is why every other
export case is green. The case is left as it is: it asserts exactly what a user
needs, and goes green when the refresh is bounded.

### subscriptions

The Phase 9 cases, and the line each draws between what a run may do to a
store and what it may not. Nothing here buys anything. A paid state is the
existing `manual` purchase row (`web/fixtures/plan.ts` over `seed/plan.ts`) —
a production state, and the one the api's fold already treats as a comp — and
its end is the same row **canceled with a past expiry** (`lapsePlan`), which
is how a comp ends: a deleted row is a state no account reaches. Provider
truth — a card, a webhook, a store receipt, a restore — is release
qualification (`web/RELEASE.md`, `mobile/RELEASE.md`), because it needs a
sandbox account and leaves a live sandbox subscription behind.

| case                  | surface                              | what it proves                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAP-WEB-001`         | web                                  | a free account's card prices from Paddle's preview; Upgrade creates a real sandbox transaction and opens the overlay; closing it returns the card live, with no error and still free; a second press re-uses the transaction; the `?_ptxn=` payment link opens the checkout and strips itself |
| `IAP-NATIVE-001`      | iOS                                  | the App Store sandbox returns the Plus product (the button enables, the price is the store's); Upgrade raises StoreKit's own prompt; Cancel returns the card live, with no error and still free                                                                                               |
| `IAP-ENTITLEMENT-001` | web, browser extension, iOS, Android | a grant written while the client is running reaches it through that client's own refresh — the Subscription section's Refresh, or the popup's next open — and the same press that opened the paywall now opens the feature                                                                    |
| `IAP-DOWNGRADE-001`   | web                                  | after a lapse, nested lists and their links stay readable on this client and on one that signs in only now; nesting and the app lock route to the paywall again                                                                                                                               |

**Every case owns its account, `IAP-WEB-001` included.** A checkout parks a
`paddle_checkouts` row on the account, and until the abandonment reaper takes it
(~12h, [iap.md](./iap.md), _reconciliation_) every free status read of that
account pays a Paddle round trip. On the worker-shared account that would be
every later case's status read.

**`IAP-WEB-001` also runs against staging**, as the one journey that puts
Paddle's script, frame, styles, images and connections under the deployed CSP
(_deployed staging and mobile Release builds_, below). It needs nothing local —
a free account and the staging api's own sandbox key — and leaves the same trace.

**What `IAP-WEB-001` leaves in the Paddle sandbox:** one `ready` transaction per
run, never paid — the second press inside `CHECKOUT_REUSE_MS` re-uses it. That is
the same trace `npm run check:paddle` makes (which cancels its own); an
unpaid `ready` transaction has no documented expiry and charges nothing. It
needs the network (Paddle.js from Paddle's CDN, the api's call to the sandbox)
and the api's `bracemark-paddle-key-development` keychain item, so it carries
`internet`. The overlay's close control has no accessible name; the case
presses it by Paddle's own `data-testid` (`wideOverlayCloseIcon`) — the one
selector another company can break, and it would go red there rather than
closing the overlay some other way no person could.

**`IAP-NATIVE-001` is iOS only, and the reason is the store.** The iPhone
simulator answers the App Store sandbox catalog with no account signed in, so
the product and the purchase request are real; with its sandbox account signed
OUT — how a simulator comes — the request stops at StoreKit's "Sign in to Apple
Account" prompt, a sheet with nothing behind it that can charge, and that prompt
is the case's far-side proof. The Pixel 8 AVD has Google Play but no Google
account: Play Billing answers nothing, and the card correctly keeps its
`$48/year` placeholder with the button off. Signing a Google account into an
emulator is a human's credential decision, and a sideloaded build is not the
build Play bills anyway, so Play's half is `IAP-PLAY-RELEASE-001`. For the same
reason **`IAP-RESTORE-001` is release qualification**: a restore that proves
anything needs a store account that already holds a purchase.

It found an app bug on its first run, fixed in the same change: **backing out of
the store sheet printed "User cancelled the purchase flow" as an error under
the card.** expo-iap 4.x rejects `requestPurchase` with the sheet's outcome as
well as emitting it to the error listener, and `lib/iap.ts` recognised a cancel
only in the listener, so the rejection reached the section's catch. The jest
suite mocked `requestPurchase` as resolving, which is exactly the assumption
the library broke.

**The browser extension's plan gate is the link cap**, the only one it has: the
case imports the 200-link paged library on the web, and the popup at the cap
shows the full-library wall and hands "Upgrade to Plus" to the web app's
Subscription page. The popup is a fresh document on every open, so reopening it
is its whole refresh. ⚠ Read it only once BOTH inputs to the gate have settled —
the synced pill for the count, and the popup's persisted last-known plan for the
entitlement (`awaitPlus`'s signal on web). The editor is on screen for the frame
before the count loads whatever the plan, and a first version of the case
passed that way against a popup whose cap ignored the plan.

**Refresh is the subject, so nothing reloads.** `subscriptionStatusQueryOptions`
holds a 5-minute `staleTime` (_granting Plus is two steps_, above), so a
running client learns of a grant only by asking; the web case moves between
Settings sections by the rail's links and the native one by the settings drawer,
so the gate's answer is the Refresh's rather than a fresh document's.

### visual checkpoints

Functional cases stay authoritative. A visual checkpoint is a **named
screenshot**, taken the same way every run, so a paint-only defect — a token
that went wrong in dark mode, a sheet that clips at a large text size, a row
that renders blank — shows up in a review instead of in a user's report. It is
its own target, `e2e-visual`, because what it produces is a comparison, not a
pass:

```sh
npm run e2e:visual:web
npm run e2e:visual:ios                           # the one booted simulator
npm run e2e:visual:android -- --device <serial>  # or name the device
npm run e2e:visual:web -- --accept               # this run becomes the baseline
```

**The catalog is [`e2e/visual.json`](../e2e/visual.json)**, the visual twin of
`cases.json`: every checkpoint by name, the case that captures it, its platforms
and appearances, its masks, and whether it is gated. `npm run check:registry`
holds the two together — every checkpoint names a case that runs on each of its
platforms, every checkpoint case owns at least one checkpoint, a gate needs an
owner — and the capture helpers look each name up and throw on one the catalog
does not define. What a checkpoint must LOOK like is never written anywhere but
the accepted baseline.

| case               | surfaces                 | what it photographs                                                                                                 |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `VISUAL-APP-001`   | web, iOS, Android        | signed out, empty, list and card layouts, search, add, edit, bulk mode, seven settings sections, the delete receipt |
| `VISUAL-LOCK-001`  | web, iOS, Android (Plus) | a locked list's pane, the Set app lock dialog, the app gate                                                         |
| `VISUAL-SHARE-001` | iOS, Android             | the share surface's editor and its no-link state                                                                    |
| `VISUAL-FONT-001`  | iOS, Android             | at a large text size: sign-in, add, edit, the upgrade dialog, advanced search, all seven settings sections, share   |

**The matrix.** Every checkpoint is taken in light and dark. The web takes each
at two layouts — `wide` (1280×900) and `narrow` (390×844) — and they are two
Playwright **projects**, not a resize: the add surface is a popover wide and a
sheet narrow, so resizing with it open would photograph something nobody sees.
Each project drives its own account from scratch. The devices are the canonical
phones, the iPhone 17 Pro simulator and the Pixel 8 AVD, upright. The app now
runs on tablets and in every orientation ([expo-build.md](./expo-build.md),
_devices_), and **the matrix has no tablet or landscape profile yet** — the docked
rails ([safe-area.md](./safe-area.md), _wide windows on native_) are photographed
nowhere. The natural pair is web's: an iPad simulator and a tablet AVD as the
native `wide`. The large-text case sets iOS's content size to
`extra-extra-extra-large` and Android's `font_scale` to 1.3 — both at or past the
app's 1.3 cap ([accessibility.md](./accessibility.md), _font scaling_), so the
capture is the largest text the app will ever lay out. The iOS share sheet is in
it too, and shows the exemption that section records: it does not scale. After
the upgrade dialog it imports the fixed library and photographs advanced search and
every settings section — the surfaces with the most fixed-height controls, tab
strips and table rows. Sign-in, add, edit and the upgrade dialog
never see the library; the share sheet, taken last, now opens over the About
section rather than the links page. **This case is the second line, not the first.** Whether a pinned box
holds its text at the cap is arithmetic, and bracemark-expo's
`components/ui/line-budget.spec.tsx` does it on every run; a baseline diff only
reports a CHANGE, so a box that already clipped when its baseline was accepted
passes here forever. Review a new large-text baseline for clipping before
accepting it — that review is the only thing this case adds for a clip.

**The appearance is the SYSTEM's, and the account's theme is left alone.** A
fresh account's theme is `system` (`DEFAULT_THEME`, [theme.md](./theme.md)), so
the web leg emulates `prefers-color-scheme` and waits for the `.dark` class, and
a device leg flips `simctl ui … appearance` or `cmd uimode night` and the app
follows through Uniwind's `Appearance` listener — exactly as it follows a
person's Control Centre toggle. The flip is live on both platforms: Android's
MainActivity declares `uiMode` in its `configChanges`, so the screen under test
is re-themed rather than recreated. ⚠ **`fontScale` is not declared**, so a text
size change recreates the activity: the large-text case sets it before its cold
launch and puts it back after (`runner/device-look.ts`). ⚠ **And every Android
`font_scale` write is a configuration change, which leaks a second wifi icon
into a frozen status bar** (_the published screenshots_, below) — the freeze is
re-entered after each one. That freeze now lives in `runner/status-bar.ts`,
shared by this target and the store captures.

**A dark capture that is not darker than its light twin fails the run.** It is
the one thing a flip can get wrong silently: the screen holds perfectly still
in the OLD appearance for a frame or two after the switch, and a stability
check alone would photograph it as the new one. The device leg therefore also
skips frames that still match the previous appearance before it waits for two
agreeing frames. Measured against a helper whose flip was a no-op: all six dark
captures of the lock case flagged at a luma ratio of 1.00, and the run red.

**Determinism is built, not hoped for.** The cases import one fixed library
(`web/fixtures/visual-library.ts`) — the one fixture in `e2e/` whose values are
constants rather than `unique()`, because a screenshot compared with yesterday's
must show the same words. Its links are `.invalid`, carry settled `done`
extractions with generated previews, hang off a fixed timestamp, and pin
`deviceExtractionMode: 'off'`, so nothing on screen waits on the network. What
still moves is **masked**, never frozen by stubbing the app: the web's relative
date column, the run's username, the Data section's "Last synced …", and the
soft keyboard's frame, whose suggestion strip is not the app's. Masks paint
Playwright's magenta on the web and the same colour over hierarchy bounds on a
device (`runner/visual-native.ts`). The device status bar is frozen for the
whole run. A capture is taken once two consecutive frames agree —
`animations: 'disabled'` and a hidden caret on the web, a tolerance on a device,
where a blinking caret is a few hundred pixels. (The frozen status bar is
frozen in the PIXELS only: iOS's hierarchy still reports the real time — `7:06
PM` in a dump taken beside a `9:41` capture — so do not read the clock off a
dump to check the freeze.)

⚠ **The freeze does not cover iOS's back-link breadcrumb.** An app opened
while Safari is in front gets "◀ Safari" beside the clock — so the share
cases, which end in Safari, left it on the cold launch after them: every run on
`large-font-sign-in` (baked into the first accepted iOS baseline; gone again by
the add panel), and the next run's `signed-out`, which came back `changed` at
0.12% against a baseline taken from a fresh boot.
Which captures carried it depended on case order and on what the device was
doing before the run, not on the app. The runner now terminates Safari before
every iOS case, so each cold launch comes from SpringBoard and the breadcrumb is
never drawn.

**Review-only, until a checkpoint is promoted.** `runner/visual-compare.ts`
diffs each capture against the baseline for its **device profile** —
`web-chrome`, or `<platform>-<model>-<os>` — with a per-channel tolerance and a
changed-pixel ratio from the catalog, and writes `visual/report.html` with the
baseline, the capture and a diff side by side. A `changed` capture fails
nothing. It fails the run only when its checkpoint is `gate: true`, which the
catalog allows only with an `owner`; none is gated yet. Every compare also
extends a per-capture **streak** of consecutive same-as-baseline runs (in the
profile's `history.json`), and the report stars the captures past the catalog's
`promotionStreak` — that is the evidence a promotion is argued from. What fails
every run regardless is the harness breaking its own contract: a capture the
catalog owes that was never taken, or the dark check above.

⚠ **Baselines are machine-local, and that is deliberate for now.** They live in
`e2e/.artifacts/visual/baselines/<profile>/`, gitignored, written only by
`--accept`, and only after a run that captured everything. A raster is a fact
about a machine's browser build, simulator runtime and fonts as much as about
the app, so a baseline committed from one machine would read as `changed` on
the next; and a public repo of app screenshots is a publishing decision
([brand-assets.md](./brand-assets.md)). Clearing `.artifacts` clears them, and
the next run reports every capture `new`. Where a shared baseline lives is the
first question CI has to answer before any checkpoint is gated.

Not photographed, on purpose: the **Subscription** section, whose price is the
store's or Paddle's live answer (the `IAP-*` cases own it); the share sheet's
**saved** state, which dismisses itself after 1.2s and cannot be held for two
appearances; and the store captures' fixture — `shot/` depends on live public
pages and serves a different purpose.

The device legs make one app change to be drivable: `links-empty`, the settled
empty state's testID (_the testID contract_, above), so the flow waits for the
empty screen rather than for body copy or the loading bones.

### deployed staging and mobile Release builds

Environment and compilation are independent: staging chooses deployed services;
Release chooses optimized native code and bundled JS. `e2e-web:staging`,
`e2e-extension:staging`, `e2e-mobile:staging`, and `e2e-contract:staging` use
the exact dryrunbase.com origins, start no servers, and select only cases whose
registry entry admits `staging`. Default runs stay local. Origin overrides
cannot silently send a local run to staging or a staging run to production.

The operational commands and coverage exclusions are in
[e2e/STAGING.md](../e2e/STAGING.md). `runner/environment.ts` resolves the four
roles once; `cases.json` makes admission explicit per case, with local-only as
the default. A requested unsupported case fails before account provisioning.
Staging uses fresh Free accounts and serial browser execution, preserving the
real Cloudflare limits. Direct session edits, process/network fault injection,
and Android `run-as` sandbox reads remain local, and the D1 helper refuses
staging so an accidental call cannot mutate unrelated local state.

**The plan grant is the one direct write that follows a case to staging.** A web
or browser-extension case that declares `"stagingGrants": ["plan"]` puts its own
disposable account on Plus by writing the `manual` purchase row to staging's
**remote** D1 — the same row, for the same reason, as the local seed (_the split
down the encryption boundary_, below): a plan is plaintext server state no
client can author, and a grant with no provider behind it is a product state the
deployed api already folds. The alternatives were each worse. A Paddle sandbox
checkout is not automated and leaves a live subscription (_what e2e may not
assert_). An endpoint that grants a plan is a test hook on a public host. A
standing paid account is shared state between runs and between machines, and
seeded the way local ones are its password would be a hash of a public constant
— so `seed:accounts` refuses staging outright.

⚠ **The write is deliberately narrow, and nothing but its own guards keeps it
so.** `planD1` (`e2e/seed/d1.ts`) is the only path, and it carries directory
statements for `seed/plan.ts` alone; `d1`, which takes any binding, still refuses
staging. The credential is its own keychain item with D1 Edit on the staging
account — not the deploy token, and with no fallback to it or to
`wrangler login`. The web and browser-extension runners prove it before
Playwright creates an account, the registry admits the declaration on those two
surfaces only (`PLAN_GRANT_SURFACES`, `runner/registry.ts`), and the write
refuses any run that did not declare a grant, so importing `plan.ts` from
another entrypoint reaches nothing. `--env staging` pins the `database_id`, so
no token and no exported account id can turn it into a production write.
Widening any of these — a second binding, a third runner, the deploy token
"just for now" — passes every check there is. The second runner was admitted
deliberately: the browser extension's link-cap case (`IAP-ENTITLEMENT-001`)
needs a paid account and has no other way to get one, and `runner/extension.ts`
carries the web runner's preflight and mark line for line. Setup and the
operational detail: [e2e/STAGING.md](../e2e/STAGING.md).

The shared persistent browser profiles remain required for non-extractable
IndexedDB keys. Staging uses the deployed app and marketing site, preserves TLS
validation and browser CSP enforcement, and starts no Next/Wrangler server. The
image import/cross-profile case exercises real presigned R2 uploads and reads.
Dedicated hosting/CORS cases cover deployed HTML/build identity and both Workers.
CSP cases require an enforcing response header and actual browser refusal of an
unapproved script and connection, on the app and on the marketing site — two
distributions, two policies. Report-only produces a red enforcement gate;
transport failures cannot count as a CSP block. The external sentinel has a
successful intercepted response if mistakenly allowed. This policy deliberately
allows inline Next bootstrap scripts; these cases do not claim inline-script
refusal or a complete security audit.

A refusal proves one thing is blocked. Two more checks cover the two ways a
policy goes wrong with every refusal still green. **The hosting case pins the
whole header** against `staging/policy.ts`, source by source, on both origins'
documents and their 404 pages: a policy that _allows_ too much — `'unsafe-eval'`,
a wildcard R2 host, the other tier's api — changes no journey. **The app fixture
fails any test whose journey raised a `securitypolicyviolation`**
(`web/fixtures/csp.ts`, the `cspGuard` auto fixture), in every context the test
opened: a policy that is _missing_ a host breaks a path the journey walks through
but may not assert on, and with no `report-uri` the browser's console is the only
other record. Local runs are under no CSP and never trip it. It does not see a
violation raised inside a worker's own scope, only the refusal to start one, and
it ignores third-party documents — Paddle's checkout reports against Paddle's
policy, not ours.

Two cases exist because the browser, not the app, fetches the resource:
`STAGING-CSP-004` waits for the signed-in app's service worker to activate and
asks Chrome for the manifest the way its installability check does
(`worker-src`, `manifest-src`). `STAGING-CSP-005` is the marketing site's
counterpart to the guard, which only signed-in journeys carry: it walks the
site's pages under the same watcher and converts a file in the bookmark
converter, whose `blob:`-started worker is the one allowance that policy makes
beyond `'self'`. And `IAP-WEB-001` is admitted to staging, where
the real Paddle overlay opens under the deployed policy — `script-src`,
`frame-src`, `style-src`, `img-src` and `connect-src` in one journey.
`EXTRACT-WEB-001` and `EXTRACT-WEB-ALL-001` are admitted for the extractor's
sake: with the plan granted as above, they send a real extraction from the
shipped bundle to the deployed Worker under the policy. The pinned header and
the CORS case's fetch from the page hold the extractor origin too, but neither
uses the origin the bundle was built with, and neither asks the Worker to fetch
anything.

`check:headers` runs the header comparison and the refusals outside the runner,
against either tier. It is the only thing here that may name production: it
reads headers and makes two requests the browser must refuse, so it creates
nothing — the reason journeys are barred from production does not apply to it.

`build-release:staging` regenerates native output, pins staging API/site values
above dotenv precedence (with `BRACEMARK_NONPROD_RELEASE=1`, the opt-in past
`metro.config.js`'s production guard — [env-files.md](./env-files.md),
_bracemark-expo_), and builds an Android release APK or iOS Release
simulator app with ad hoc signing enabled for Keychain access. It records source
revision, SHA-256 and Android's R8 mapping.
Before testing, native preflight verifies the installed binary against that
receipt, refuses debuggable Android apps, and verifies iOS nested code signatures.
Android's ADB queries and installed APK copy have finite time limits so a stalled
transport fails preflight. The cold-launch subflow selects
plain `launchApp: clearState: true` for Release and the dev-client link for local
debug. Release needs no Metro or reverse mappings. iOS simulator Release is not
a store IPA or real-iPhone qualification. Frozen vectors stay local because the
screen redirects away in Release; both encrypted cross-client round trips run
against staging.

A staging native run takes the same two defaults a local one does, and both are
safe for the same reason — the preflight, not the argument, is what admits the
build. With no `--release-receipt` it uses the newest receipt of that platform
under `.artifacts/releases/` and prints its path; with no `--device`, the one
device that platform has up. A stale receipt or the wrong device cannot pass on
a default: the installed app is still hashed against whichever receipt was
chosen before an account exists. So `npm run e2e:ios:staging` and its
three siblings run with nothing after them, once `e2e:build:<platform>:staging`
has built and the artifact it printed is installed.

Run manifests record environment, origins, exclusions and, for mobile, the
Release receipt independently of the runner checkout. A receipt establishes build
configuration and identity, while flow results establish runtime behavior. A
subset pass never replaces the complete security gate or the real-device/store
checklists. Tests leave disposable staging accounts; there is no automatic cloud
cleanup or deployment in a runner.

### running it

Every local target needs the stack already running, and **no runner starts
it**:

```sh
npm run dev # api :8787, web :3000, extractor :8788
```

`e2e-web` and `e2e-visual` require all three legs, `e2e-extension` web and api,
`e2e-pwa` the api alone, and the native and contract runners all three for any
`online` case — frozen vectors are the exception because they have no account or
server. The native targets additionally need Metro and an installed Expo
development build.

Every entrypoint owns a preflight. Each resolves the listeners it needs on 3000,
8787 and 8788 to their process cwd, so a stack belonging to another checkout is
refused rather than used, and a leg with no listener fails at once with the
instruction above. Native resolves Metro in the Expo
dev-client link, requires it to report a running packager from this checkout,
and records the link and all stack origins. It also requires the selected device
to be booted, the development build to be installed, and Android to have
completed boot with the 8081/8787/8788 reverse mappings. With an `online` case
selected it also fetches the bundle Metro serves and requires its api origin to
be the one the run provisions against (_driving the native apps_). A failed
preflight happens before account provisioning.

The listeners are checked **before** anything waits for a leg to answer. The
wait (`waitForHttp`, 90s) is for a wrangler that is still booting — Next is up
well before local D1/R2 are — and in the other order a run begun without
`npm run dev` sat silent for those 90 seconds and then printed the instruction it
could have printed at once.

**Why no runner starts the stack.** The Playwright targets once did, through
`webServer`, and that second definition of "the stack" went wrong three times
where `npm run dev` could not. Keyed to the web origin alone, it reused an
orphaned Next listener while the api was absent and nothing started one. Split
into legs, it was a leg short — no extractor — and the three `EXTRACT-*` web
cases failed on every run started from free ports. And Playwright stops what it
started with SIGKILL to the process group, which took `nx` and left the Next
server it had spawned on :3000 with the other end of its output closed: the next
run got a 200 from it and reused it, the server then spun at full CPU on its
first log write and answered nothing more, and every case timed out setting up
its app fixture with no step named (measured 2026-10-11: `/` 200 in 0.03s,
`/links` 200, then no answer in 10s and the process at ~120% CPU). A started leg
also had its output discarded, so a failed run showed nothing the api had said.
One command in one terminal has none of this, and the native runners, the seed
and the captures needed it regardless. If a run times out in a fixture with the
stack apparently up, look for a `next dev --port 3000` whose parent is pid 1 and
stop it.

```sh
npx nx e2e-web @stxapps/e2e
npx nx e2e-web @stxapps/e2e --headed   # watch it; `npm run e2e:web:headed` adds the pacing
npx nx e2e-web:report @stxapps/e2e
npx nx e2e-extension @stxapps/e2e
npx nx e2e-pwa @stxapps/e2e   # builds the production export itself; needs :3001 free

# The one booted simulator, or the one attached Android device.
npm run e2e:ios
npm run e2e:contract:ios
npm run e2e:android
npm run e2e:contract:android

# With two up, name one: ids come from `xcrun simctl list devices booted` or `adb devices`.
npm run e2e:ios -- --device <udid> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform android --device <serial>
```

The platform is mandatory and the device is passed to every Maestro invocation.
`--device` may be left out locally: the run then takes the **one** device that
platform has up and says which (`runner/device.ts`), and refuses — listing them —
rather than choose between two, so having both platforms booted is not
ambiguous and neither are two simulators. The manifest records the device either
way. The full legs should still be run
serially because they share the local stack and are intentionally expensive.
The vectors case remains first in a full contract run. Run it alone with
`--case CONTRACT-VECTORS-001`.

The six targets also have root scripts. `npm run e2e:web`, `e2e:extension` and
`e2e:pwa` are the target as it stands. The other three need a platform, so their
scripts carry it and there is no bare one — `e2e:ios` and `e2e:android` for
`e2e-mobile`, then `e2e:contract:android`, `e2e:visual:web` and so on — each the
target plus `--platform`, not a target of its own, the way `e2e:web:headed` is.
`e2e:web:firefox` and `e2e:web:firefox:staging` are the Firefox subset, local
and deployed (_firefox_, above). The staging scripts put the mode last:
`e2e:extension:staging`, `e2e:ios:staging`, `e2e:contract:android:staging`,
`e2e:build:ios:staging`. There
is deliberately no bare `npm run e2e`: no honest fan-out
can boot, build, select, and prepare both native platforms. `expo:ios` and
`expo:android` are prerequisites, not tests; see [expo-build.md](./expo-build.md).
On Android, run `npm run expo:android:reverse` after each emulator boot.

To watch a web run, `npm run e2e:web:headed` opens the browser window and paces
it: the root script is `e2e-web` with `--headed --slow-mo 250 --workers 1`, not
a target of its own, so there is one definition of the run and the flags compose
with `--case` after `--`. `--slow-mo <ms>` is the wrapper's flag, not
Playwright's — it holds every browser operation back by that long, and a later
one overrides the script's. It also eats into the same test timeouts, so pace a
selected case rather than the suite. ⚠ **Playwright's `--headed` alone does
nothing here, and says nothing.** It sets `use.headless`, which reaches only a
browser Playwright launches; every web case runs in a persistent context that
`web/fixtures/launch.ts` launches itself (_the fixture constraint_). So
`runner/web.ts` turns the two flags into `E2E_HEADED` and `E2E_SLOW_MO`, and
`launchApp` reads those. A headed run stayed headless before it did, and a bare
`playwright test --headed` that skips the wrapper still does.
`npm run e2e:web:headed:staging` is the same pair of flags on `e2e-web:staging`;
it carries no `--workers 1` because staging already runs one worker.

#### cases, suites and fixtures

The optional `environments` field selects local/staging admission independently
of tier. Missing means local-only; the `release` tier remains manual
qualification, not the optimized build variant. Automated staging cases retain
smoke/full tiers. `stagingGrants` names the server state a staging-admitted web
or browser-extension case writes outside the app — only `["plan"]` exists — and
is what lets the runner ask for the credential before it creates anything
(_deployed staging and mobile Release builds_, above). The optional `browsers`
field, on automated web cases only, is the same kind of admission for the engine:
missing means Chrome only, and `["chrome", "firefox"]` adds the case to
`e2e-web:firefox` (_firefox_, above). The two axes are independent, and a case
runs in every combination its entry lists.

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
npm run e2e:ios -- --device <udid> --exclude-trait destructive
npm run e2e:android -- --from TAXONOMY-DND-002
```

`--from <case-id>` picks a native run back up where one failed: it drops every
selected case ahead of the named one and runs that case and the rest. It is
applied last, to what the other filters left, and refuses an id they dropped
rather than run everything (`runner/registry.ts`). The unit is the **case**, not
the flow: a case the runner drives as a chain — `taxonomy-dnd.yaml`, a host-side
drag, then a part under `mobile/flows/parts/` — restarts at its first flow on a
fresh account, because each part stands on the state the ones before it left.
`e2e-mobile` and `e2e-contract` only: they take the selection one case at a
time, in registry order, so "ahead of" is the order the run had. Playwright
orders and parallelises its own, so the web wrappers pass the flag through and
Playwright refuses it by name; `e2e-visual` refuses it itself.

⚠ **On web the selection is applied per Playwright project, not as `--grep`**
(`runner/web.ts` passes it as `E2E_GREP`; `playwright.config.ts` gives it to both
projects). A command-line filter reaches only the projects it selects directly,
and Playwright runs a DEPENDENCY project whole — and `capacity` depends on `web`
so that it runs last and alone. Under `--grep`, any selection that included
`SYNC-BLOCKED-001` therefore ran every test in `web`: `--exclude-trait internet`
ran the three `internet` cases (which is how it was found, on a stack with no
reachable extractor), and `--case SYNC-BLOCKED-001` ran the whole suite before
its one case. Nothing said so — the run manifest listed only the cases asked
for, and the cases that should not have run passed or failed like any other. A
case added behind a new project dependency needs the same `grep` on its
project.

Two traits are easy to confuse. `visual` marks any case whose claim is in
pixels or bounds — `SKELETON-*` and `VIEWPORT-*` carry it and run in their
ordinary targets. `baseline` marks the visual checkpoint cases, whose output is
a comparison with an accepted baseline: `e2e-visual` selects only those, and
every other runner refuses them by name (`--case VISUAL-APP-001` on `e2e-web`
says to use `e2e-visual`), since run anywhere else they would photograph into a
run nothing reviews.

[`e2e/fixtures.json`](../e2e/fixtures.json) defines the fixture sizes: `empty`
(the normal fresh account), `small` (the minimum multi-entity journey state),
and `scale` (an archive generated from
`e2e/seed/library.ts` and imported into a fresh account). The `SCALE-*` cases
take the generated 1,000-link library itself (`web/fixtures/scale-library.ts`,
the `plus-full` shape, with the Plus grant a thousand links needs); the other
`scale` cases take the 60-link paged library (`web/fixtures/library.ts`), whose
row order is known outright. No test uses the human
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
  provider to ask ([iap.md](./iap.md)). The same row is how a staging journey
  gets a plan, written `--remote` to its own disposable account — but the
  **seed** stays local: these four accounts are never created on staging
  (_deployed staging and mobile Release builds_, above).

Accounts are still created through the real create-account form, Argon2id and
all: the rule in `web/fixtures/account.ts` — there is no seeding shortcut and
there should not be one — holds here too. The only thing the seed adds is
`launchApp`'s `create` option, which chooses the credentials instead of minting
throwaway ones, because these accounts are meant to be signed back into tomorrow.

#### five things that will surprise you

- **Re-seeding does not update an account that already exists.** A backup merge
  is skip-existing **by path**, so an account seeded before you edited
  `seed/library.ts` keeps its old entities. That is the right behaviour for a
  restore and the wrong one for iterating on a fixture: use Settings → Data →
  Delete all data first, then re-run `seed:accounts`. Re-running with no edits is
  a genuine no-op, which is what makes a half-finished run safe to repeat. (The
  shot account answers the same trap with a flag — `shot:account --fresh` —
  because its fixture is a hand-edited URL list that changes more often.)
- **An account synced by a build from before the blob path binding comes back
  empty.** Its blobs fail the tag, and the pull skips them
  ([local-first-sync.md](./local-first-sync.md), _crypto boundary_): signing in
  completes, with none of the old records. Re-seeding does not fill it — a
  backup merge skips existing paths, and the old blobs are still there — and
  usernames are never released, so it cannot be recreated under the same name
  either. Delete all data and then re-seed, or reset the local api's state:
  stop the api, `rm -rf apps/bracemark-api/.wrangler/state`,
  `npm run d1:migrate`, start it again, sign any device or browser profile out
  of the old accounts, then re-run `seed:accounts`. The reset also drops every
  throwaway e2e account, which is fine — nothing reuses them.
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

The root lists rank **ahead of My List**, where the app's own create would have
put them (`editors.md`, _every create lands in the same place_). The root group
is shared with the three system lists, which are code defaults holding the first
keys of the keyspace and are in no backup; a fixture that ranks its roots from an
open start mints those same keys and ties with all three. That is a state the
product reaches only across devices or an import, and the seed used to hand it to
every account by accident — it is how the settings table's "Move up" was found
throwing on a tied pair. An account seeded before that change keeps its tied
ranks (the first surprise above); the app now moves through them, so it only
matters if you want the order to match.

### the published screenshots

`e2e/shot/` is the seed's odd cousin, and sits beside it rather than inside it: a
fifth account whose only job is to be photographed — `npm run shot:account` makes it,
three `shot:*` legs photograph it. Everything this project publishes a picture of
the product for is made here — the marketing site's figures (the links page under "A private
library is still a library" on the landing page, and the ones its `/docs` pages
show), the screenshots `apps/bracemark-web`'s
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
at — likewise for `search-advanced` and its entry in
`apps/bracemark-site/src/content/figures.ts`; the other docs figures are cut the
same way, at the widths their entries there list. The mobile runner freezes the platform status bar, captures three app scenes
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
device pixels. A scene may also declare a `frame` — a locator — and is then
photographed through it: the PNG is that element's box at the same density
(grown by `bleed` CSS px of page on every side, when it sets one), and the
viewport is only the room the element is given. Nothing in `e2e/` knows where a
picture ends up.

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

`search-advanced` answers to a **docs figure** — `advanced-search` in
`apps/bracemark-site/src/content/figures.ts`, shown on `/docs/search` — and it is
the one framed scene: the Advanced search panel, 320 CSS px wide, at DPR 3 so a
figure drawn at the panel's own width has a 960px file for a DPR-3 phone. Its
viewport height is room rather than design. The panel is capped at `70vh` and
scrolls inside that cap, so a viewport too short for it does not fail and does
not look wrong: it photographs with Clear and Search pinned under a checklist
that is cut off. The scene's `settle` measures both scroll boxes and fails the
run instead. The draft in the picture is built through the real controls and
never committed, and the figure's alt text and caption read that draft back —
change one and the other two are describing a different picture
([architecture.md](./architecture.md), _the marketing site's `/docs`_).

Five more scenes are docs figures, each with a way to come out wrong that fails
nothing:

| scene               | the frame                       | what goes wrong silently                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select-links`      | the whole 390x420 viewport      | a tick below the fold is still clickable — Playwright scrolls the row into view — so the capture is of a scrolled list under a count naming rows that have left the picture; and the height is counted off how this library's first three titles wrap                 |
| `sync-status`       | the Sync row                    | its second line is a clock ("just now", then "N min ago"), so it depends on how many scenes ran first; the scene presses Sync now to pin it                                                                                                                           |
| `import-over-limit` | the import's question           | pressing "Import 10 links" instead of leaving the question unanswered fills the account, and every later run photographs a different sentence                                                                                                                         |
| `edit-link`         | the Edit link dialog            | the preview is read from local bytes only, so the dialog can be open and complete-looking over an empty plate; and the picture is of a link with NO title of its own — retitle the library's first link and the figure's caption describes a state it no longer shows |
| `recovery-code`     | the auth card and 16px round it | finishing the ceremony instead of stopping at step 3 makes the code in the picture a working door to an account                                                                                                                                                       |

`import-over-limit` is also the one scene that is **not a picture of the shot
account**: the question is only asked of a free plan, which the shot account's
Plus grant removes. It declares `account: 'free-full'` — the seeded dev account
with 190 of the plan's 200 links (_seeding a dev account_, above) — so
`npm run seed:accounts` is a second prerequisite for it, checked before the
first launch. Like `scale`, the account is fixed per browser context, so
`web.ts` launches once per (DPR, account) pair. The picture prints the plan's
cap, which no page is otherwise allowed to type; the site's `figures.spec.ts`
fails when the plan table stops agreeing with it.

`recovery-code` is the one scene with **nobody signed in** (`account:
SIGNED_OUT`), and what it leans on is where the ceremony commits: the client
mints the recovery code when step 3 mounts, and the server hears of neither the
code nor the username until one of that step's two buttons is pressed. The scene
presses neither, so no account exists afterwards and the string a reader sees
opens nothing — the only kind of recovery code a public page should print.
`launchApp` takes `signedOut` for it and skips the ceremony. It is also the one
scene with a `bleed`: the auth card's top-right corner is the brand's fold rather
than a radius, so the frame is grown by a margin of the page and the card's own
edge is in the picture, where every other framed capture leaves its edge to the
site's `<Figure>`.

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

⚠ **Which pages those are is a fact about `library.ts`, and the leg now checks it
before it does anything else.** The receipt's page has to be a link the library
still holds, in the list the picture names (`In Lisbon`); the editor's has to be
one it does not hold. The library is arranged for other pictures — its first
seven rows are the landing figure's fold — so a row this leg names has twice been
dropped or moved to another list in a change that never opened `extension.ts`.
Neither time did anything fail where the cause was: the run built the extension,
signed in twice, photographed the first scene and died half a minute later on a
locator. `assertFixtureAgrees` reads both URLs back through `shotLinkList` and
refuses to start, naming the list the link is actually in.

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
reading, buying, worrying about, and working on" — and the figure four screens
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

### measuring the data path

`e2e/measure/data.ts` (`npm run measure:data`) reports how long import and
export hold bracemark-web's main thread, at library sizes you pick. It is the
measurement behind [data-lifecycle.md](./data-lifecycle.md), _main-thread
cost_, and it lives here because it needs everything a whole-flow case needs: a
real account, the plan grant, the Settings → Data controls, and Chrome.

**It is not a test, and it is in no suite**, for the same reason `shot/` isn't.
Timing on a dev machine running the whole local stack is noisy, so a pass/fail
threshold either flaps or is set so loose it never fires. It prints a table and
writes `results.json` into `.artifacts/measure/<run>/`. A person reads the
longest task against the bands in the doc and records the reading there.

```sh
npm run dev                                         # the api; the web origin is its own
npm run measure:data                                # 10,000 links, CPU 4x slower
npm run measure:data -- --links 10000,50000 --cpu 6
npm run measure:data -- --trace                     # + a DevTools trace per leg
npm run measure:data -- --dev                       # the dev server on :3000 instead
npm run measure:data -- --skip-build                # stage the existing out/
```

Per size it runs six legs on two fresh Plus accounts: an **HTML bookmarks
import** into an empty library (the interop path), a **backup restore** of a
realistic library (`seed/library.ts` at the `plus-full` shape, scaled, without
its preview images), and **four exports** from that library once it has
synced. The sync wait is unmeasured: straight after a restore the engine is
still pushing everything, and an export's opening refresh would measure the
push.

What each design choice protects against:

- **The production export, by default.** React's development build does several
  times the main-thread work of the production one. The run builds the export
  against the local api with the PWA runner's build (`runner/web-export.ts`,
  split out of `runner/pwa.ts` so importing it doesn't start a PWA run) and serves
  it on :3001 itself, like the PWA target. `--dev` is for readable function
  names only; label a `--dev` reading as such.
- **The CPU slowdown applies inside each leg's window only.** It goes through
  CDP (`Emulation.setCPUThrottlingRate`), so it is Chromium-only. Argon2id at
  account creation runs at full speed, as does everything between legs.
- **The instrument is the browser's own.** `longtask` entries give the headline
  number. Both observers are installed by an init script before the app's code
  runs. A leg that navigates mid-window throws, because the observers and
  `performance.now()` belong to one document.
- **⚠ The init script is a string, not a function.** tsx compiles with
  esbuild's `keepNames`, which wraps named inner functions in a `__name(…)`
  helper that exists in node and not in the page. A function-form init script
  throws in the browser before installing anything. The first run did exactly
  that, and the only symptom was the "no instrument" guard on its first leg.
- **Every run starts with a positive control.** `calibrate` runs a fixed amount
  of work as an ordinary page task at 1× and at the chosen factor. The run stops
  unless both read as long tasks and the slowdown shows. That rule came from a
  specimen: a leg that reports no long task is only good news if the instrument
  would have seen one, and code run synchronously inside a DevTools-protocol
  command (a `page.evaluate` body, the `change` event `setInputFiles` fires) is
  not reported as a long task at all. The 1× reading also records the machine's
  speed for comparing readings.
- **Frame attribution names the entry point, not the owner.**
  `long-animation-frame` entries list the scripts that _started_ a stall.
  Promise continuations run inside the task that resolved them, so an export's
  decode loop shows up as Dexie's `IDBRequest.onsuccess` and a restore's
  classify loop as zip.js's `TextWriter`. What consumed the time is `--trace`
  plus the DevTools Bottom-Up tab. On a production trace the names are
  minified, so run `--dev --trace` for them: the dev build inflates the times,
  but the same code owns the tasks.
- **Export takes the download path.** The init script deletes
  `showSaveFilePicker`, so the backup goes down the Safari/Firefox fallback
  (`downloadBlob`), which Playwright catches as a download. That is a real product
  path doing the same main-thread work. It is not the save-dialog stub rejected
  above under _what e2e may not assert_: that rule is about proving the save, and
  this measures the build-up to it. Each export leg checks the deletion took, so
  a Chrome that moved the method would fail loudly, not hang on an invisible
  dialog.

#### the sync leg — `measure:sync`

`e2e/measure/sync.ts` breaks a bracemark-web sync down by phase, by request and
by server call, so a fix goes where the time actually is. The instruments, what
each reading settles, and the reasons behind them are in
[local-first-sync.md](./local-first-sync.md), _measuring a sync_. This section is
how to run it.

```sh
npm run measure:sync:staging                        # dryrunbase.com, 1,000 links, all four legs
npm run measure:sync:staging -- --links 1000,5000
npm run measure:sync:staging -- --no-sw             # the app's service worker blocked
npm run measure:sync:staging -- --legs push         # push only (pull, incremental, floor)
npm run measure:sync:staging -- --legs bulk-edit --bulk 10,100,500 --links 10000
npm run measure:sync:staging -- --legs bulk-delete --delete 500
npm run measure:sync:staging -- --no-images --cpu 4
npm run dev && npm run measure:sync                 # the local stack, for client-side questions
```

Per size: a fresh Plus account restores a backup of `seed_plus_full`'s shape,
scaled and with its preview images (**push**). A second browser signs in to it
(**pull**, the `initial` cycle). The first imports 100 more links and the second
opens a page whose cycle pulls them (**incremental**). Then the pull's own GET
URLs are fetched again with no engine around them, at 6, 12, 24 and 48 at once
(**floor**). The first browser then bulk-edits the newest 10, 100 and 1,000 links
(`--bulk`): Bulk edit, select, Edit tags, a new tag, Save — one `links/` put per
link — read once on its own push and once on the second browser's pull of it
(**bulk-edit**). Last, it moves 100 links (`--delete`) to Trash, unmeasured, and
deletes them permanently from there: no upload, the commit carries each delete
and removes the object itself, read on both browsers again (**bulk-delete**). A
bulk leg reports the links it actually changed: Select all takes every loaded
row, so it overshoots a size that is not a whole page (60 asked was 114 done on
a 120-link library), and a small library can fall short.
Each leg prints its highlights, the engine's phase table, the network
by request kind and the api's Server-Timing. Each also writes
`<leg>-<links>.spans.json`, `.network.json` and `.waterfall.json` into
`.artifacts/measure/<run>/`, beside `results.json`. The waterfall is a Chrome
trace: open it in ui.perfetto.dev.

- **⚠ A bulk edit is only as sparse as the library is large.** The restored
  library's link ids are scattered over the key space (`measure/library.ts`,
  `scatterIds`), as the app's own random ids are; the seed numbers them in date
  order, and the newest N would be adjacent keys. That matters to the commit's
  existence check, which pages through R2 in key order
  ([local-first-sync.md](./local-first-sync.md), _measuring a sync_, item 8): N
  edits among L links cost about L / 1,000 listing pages. At the default 1,000
  links every bulk commit is one page, so the sparse case needs `--links 10000`
  or more, and a push of that size first.
- **⚠ Staging must be running this checkout.** The spans and the header ship in
  the deployed app and api, and an older deploy has neither. The run refuses on
  the first leg when the page has no trace recorder, and notes a leg whose api
  responses carried no Server-Timing.
- **The local stack can't answer the network question.** Blob bytes go through
  the api's blob route on every tier now ([local-first-sync.md](./local-first-sync.md),
  _the blob route_), but locally that api is `wrangler dev` on loopback over
  miniflare's bucket — no edge, no R2 latency, no HTTP/3 — and the dev server
  registers no service worker. A local reading prices the client: IndexedDB, the
  engine, re-renders. Specimen, 2026-10-19, before the blob route: 1,000 links
  (2,363 files) pushed in 9 s locally, with 2,365 CORS preflights (one per PUT,
  through the dev proxy), against roughly ten minutes against staging. That put
  the missing time on the real path, and the staging reading in
  local-first-sync.md, _measuring a sync_, says where.
- **The window opens at the file pick, not at the receipt.** An import kicks
  cycles while it is still writing, so the push starts before the import ends.
  The report splits the two.
- **Settled is read from IndexedDB and the trace, without navigating.** The
  pending-ops count reads `bracemark-data`/`pendingOps`, and the queue has to be
  empty with a cycle finished since and no new span for 2 s. `waitForSync`
  (`seed/steps.ts`) navigates, and a reload aborts the cycle under measurement
  and drops its spans with the document. A queue that sits still for a minute
  gets the Data card's action pressed, and the press is reported: the engine
  should never need one. That action is "Sync now" after a clean cycle and
  "Retry" after a failed one, and a failed background cycle schedules no retry of
  its own. So a run that pressed only "Sync now" sat at "6 waiting to sync"
  forever after one R2 timeout (specimen, 2026-10-19, `--no-sw` on staging). A
  failed cycle is reported too, and so is a failed `initial` cycle, whose pull
  leg is then a partial pull.
- **A request answered and then aborted is not a failure.** The R2 helpers abort
  their deadline's signal once a transfer settles, so Chrome reports most blob
  requests as canceled after a 200. They are counted as `aborted after the
answer`, because an abort before the body drains can cost the socket. Watch the
  socket count.
- **The floor is GET-only, and its URLs and tokens never touch disk.** A PUT
  floor would overwrite the account's objects with bytes the app didn't write. A
  GET URL — or the blob-route token beside it — is a credential for an hour, so
  `network.ts` keeps only origin + path in every file it writes and records no
  request header at all. It counts the blob route's `/v1/files/blob` as blob
  traffic (`blob PUT`, `blob GET`, `blob OPTIONS`), beside presigned R2's.
- **The plan grant on staging** is `measure/sync.ts`'s own door into staging D1,
  with the same preflight as the web runner ([STAGING.md](../e2e/STAGING.md)).
- **bracemark-expo has the same spans and no runner yet.** Build the bundle with
  `EXPO_PUBLIC_SYNC_TRACE=1` in Metro's environment, and every cycle prints a
  `[sync-trace]` table to Metro or the device log
  ([env-files.md](./env-files.md), _bracemark-expo_). Import through the app and
  read the push's cycles there.

#### the native leg — `measure:native`

`e2e/measure/native.ts` measures the same flows on bracemark-expo through Maestro:
two fresh Plus accounts per size, the HTML import and the backup restore through
the real document picker, the sync wait (polled off the Data card, three settled
readings in a row, like `waitForSync`), then the four exports in the restore's
session. The flows are `e2e/measure/flows/`, outside the case registry.

```sh
npm run dev                                         # api + web; accounts are made on web
npm run measure:native -- --platform ios --device <udid>
npm run measure:native -- --platform android --device <serial> --links 1000,10000
```

- **The instrument is a stall probe in the app**, because React Native has no
  Long Tasks API. `expo-react` `lib/stall-probe.ts` is a 16 ms timer whose
  lateness is the JS thread's blocking. The import and export hooks window it,
  and the Data view renders the reading as `measure-stall-reading` text, which
  the runner reads off the accessibility tree. It exists only in a bundle built
  with `EXPO_PUBLIC_MEASURE_STALLS=1`, which only this runner sets.
- **Every leg carries a calibration.** The probe times a fixed loop 1.5 s after
  launch and must see it as a stall, or the runner stops. That is the same
  positive control as web's `calibrate`, and it is also the number that makes
  a simulator reading comparable to a phone's.
- **⚠ A production bundle on the development client, with the api pinned.**
  A release build against localhost is unsupported ([env-files.md](./env-files.md),
  _bracemark-expo_), so the runner starts its own Metro with
  `--no-dev --minify`, and **that makes Metro load `.env.production`, which
  names the production api**. The origins are exported in Metro's environment
  (a shell variable outranks every env file) along with
  `BRACEMARK_NONPROD_RELEASE=1`, without which `metro.config.js`'s production
  guard refuses a production-mode bundle aimed at localhost
  ([env-files.md](./env-files.md), _bracemark-expo_), and the runner fetches the
  served bundle and refuses to continue unless it names the local api and no
  deployed one. Metro must not already be on :8081. `--no-dev` also turns
  `__DEV__` off, so everything gated on it is live in this run and in staging Release runs,
  but not in local debug Maestro
  run: the app-store review prompt is the one that matters, because the simulator
  shows its sheet on every ask. The flows here only import and export, which the
  prompt ignores — a flow that saved ten links through the add panel would have
  the sheet rise over it ([expo-dependencies.md](./expo-dependencies.md),
  _expo-store-review_).
- **The development client must be built from this checkout.** One built
  earlier loads the new JS and dies on a native module it doesn't have
  (specimen: `Cannot find native module 'ExpoStoreReview'`). The runner only
  checks that the app is installed, so after a native dependency change run
  `npm run expo:prebuild` and `npm run expo:ios` / `expo:android` first.
- **iOS Files hides a known extension.** A staged `measure-bookmarks-300.html`
  is listed as `measure-bookmarks-300`, so the import flow matches the file's
  stem (`IMPORT_FILE_STEM`), not its name.
- **The export flow waits for the share sheet, not the receipt.** Export
  presents the sheet once a run finishes, a beat after the receipt paints, so a
  poll for the receipt ends before the sheet lands on it (_scale, loading and
  offline_). `dismiss-share-sheet.yaml` waits for the sheet under the run's
  budget, then puts it away. The iOS sheet has no Close control: it is a
  popover, and iOS exposes the dimmed area as `PopoverDismissRegion` ("dismiss
  popup") over the whole screen, so the flow taps near the top. Android's
  chooser is titled "Sharing 1 file" on Android 16, not "Share", and a back
  press closes it.
- **The Data sub-views repeat their title in their back link**, so the flows
  bind to `settings-back`, not the text.

A simulator or an Apple-silicon emulator runs at the Mac's speed, with nothing
like Chrome's CPU throttle. For phone numbers, run the same command against a
physical Android phone over USB: `adb reverse` reaches the local stack exactly as
it does from the emulator.

#### finding what owns a native stall

The probe says how long the JS thread was held, not by what. Web's answer is
`--trace`. The native one is a Hermes CPU profile over the Chrome DevTools
Protocol, the same channel React Native DevTools uses, and it needs no DevTools
window:

- **Serve a production bundle unminified**: `npx expo start --no-dev` without
  `--minify`, with the same exported origins, `BRACEMARK_NONPROD_RELEASE=1` and
  `EXPO_PUBLIC_MEASURE_STALLS=1` as the runner (see ⚠ above: `--no-dev` still loads `.env.production`). That
  keeps function names and costs nothing measurable. Its comments do still name
  the deployed api, so check the live `baseUrl`, not a substring.
- **Metro's inspector lists the runtimes** at `http://localhost:8081/json/list`.
  Open the target's `webSocketDebuggerUrl` and send `Profiler.enable`,
  `Profiler.start`, then `Profiler.stop` after the flow. The reply is a
  `.cpuprofile` that Chrome DevTools opens, or that a script can walk: a
  contiguous run of busy samples is one task, and the frames above it name the
  owner. A cold launch replaces the runtime, so attach after it.
- **⚠ Attach to the `React Native` target only, never to `UI`.** The app lists a
  second Hermes runtime for Reanimated's worklets. Attaching the profiler there
  killed the app with `EXC_BAD_ACCESS` inside `CDPHandlerImpl::processPendingFuncs`.
  On the screen the flow simply loses the app, so it looks like a flaky launch.
- **Pure code needs no device.** The Hermes that ships with the app runs on the
  Mac: `apps/bracemark-expo/ios/Pods/hermes-engine/destroot/bin/hermes -O
bundle.js`. Bundle the code under test with esbuild, then lower it with
  `@react-native/babel-preset` (`enableBabelRuntime: false`, so the helpers
  inline), because that CLI rejects `class` and `async` the way the app's
  transform never shows it. Time the step at two or three sizes: a curve that
  quadruples when the input doubles is the finding. This is how the Netscape
  parser's quadratic regex was found (data-lifecycle.md, _readings — expo_).

### measuring the password manager

`e2e/measure/password-manager.ts` (`npm run measure:password-manager`) reports
what Chrome's password manager makes of each form that takes the account's
password: which field it reads as the current password, which as the new one,
and whether it offers to save. It also checks that Chrome offers nothing for a
lock password, which is a secret but not this site's login. It reads `chrome://password-manager-internals`,
open in a second tab of the same profile, which logs exactly that while it is
open.

It exists because the save prompt is browser chrome, outside the page and out of
Playwright's reach, and because every way of getting it wrong is **silent**: the
field a manager saves from is invisible or missing, and every flow passes either
way. The specimen is change password's generated path, where Chrome offered to
save the **old** password ([accessibility.md](./accessibility.md), _what a field
tells the browser_). `WEB-ACCOUNT-006` pins the input that fixed it; this is the
measurement that showed Chrome actually reads that input, and the thing to re-run
when any form that takes a password changes shape. The second specimen runs the
other way. The lock surfaces said `off`, which Chrome ignores on a password
field, so setting a lock or unlocking one made Chrome offer to replace the saved
sign-in password with the lock password. They now say `one-time-code`
([accessibility.md](./accessibility.md), _what a field tells the browser_).

```sh
npm run dev                                         # the api and the web app
npm run measure:password-manager                    # all seven flows, about a minute
npm run measure:password-manager -- --flow change-generated,create-account
npm run measure:password-manager -- --headed
```

Seven flows, each on a fresh account in a fresh profile — change password
(current password + generated, current password + typed, recovery code +
generated), Settings → Recovery code, create-account on its generated path, and
the two lock flows (`lock-app`: set the app lock, close Settings, unlock;
`lock-list`: lock a list, close Settings, unlock it in place) — each against the
submissions it should produce: the fields, Chrome's decision, and how many. A
lock flow's expected count is **zero**. Under `off` the app-lock flow logged two
`ASK the user` lines, one for the set and one for the unlock, and the list flow
logged one. A field Chrome chose that has no id prints as `#<renderer id>`
rather than `—`, so a lock field is not mistaken for no field. The recovery-code view's expected field is the **current
password**, never the code: the code is a second door, and saved as this site's
password it would fill sign-in. Create-account's is **one** submission, at the
end: an exposed passphrase on its setup step made Chrome treat Continue as a
submission (the username check's fetch counts as one) and offer to save before
the account existed. It prints a ✓/✗ line per flow and exits non-zero on a
difference, and writes each flow's raw log to `.artifacts/measure/<run>/`.

**It is not a test, and it is in no suite.** The internals page is a debugging
surface, not a contract, and the system Chrome auto-updates, so a suite gated on
its wording would go red on a Chrome release with nothing wrong in the app. A
log the parser no longer understands prints `?` — read the raw log before
reading anything into it.

Its limits, which it cannot see past:

- **The log names fields, never values.** "The prompt carries the new password"
  is inferred from which field Chrome took as the new one.
- **Every profile is fresh, with no saved login**, so Chrome's offer is always
  to _save_. What it does against a login it already holds — update, or nothing
  for an unchanged one — and the prompt it stops opening on its own after being
  dismissed for a site a few times are a real profile's to show. So is the
  _fill_ side of a lock field: with nothing saved there is nothing to suggest,
  so a lock flow shows the save half only.

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

`LINK-MOVE-001` — "Move to" into a list created from the picker — was measured
2026-10-04 from commit `eb04d46` with its changes present in the working tree:
web 3/3 with no retry (the row submenu, the bulk dialog and the narrow sheet in
one case), iOS 1/1 and Android 1/1 (the one dialog, from the row menu and from
the bulk bar). The web case was run against three deliberately broken clients
and failed at the step that guards each: the picker field's ArrowLeft guard
removed (at the caret read, where Radix had closed the submenu instead), and the
create landing without its move in the submenu and in the page-level surface (at
the row that should have left the list). The native flow needed no staged
break. Its first run opened the dialog onto a render error — the create hook
sat inside the dialog's portaled content, above which `SyncProvider` is not
mounted — with every jest spec green ([editors.md](./editors.md), _bulk edit_;
[testing.md](./testing.md), _coverage today_).

Two things about driving it are recorded where they bite. A submenu that opens
to the LEFT closes under a teleported pointer: Radix reads the direction of the
last pointermove inside the parent menu, and Playwright's one-jump `hover()`
starts from an x of 0, so it always reads "right" (`web/link-move.e2e.ts`,
`openMoveToField`). And an `EXPO_PUBLIC_API_URL` override in
`apps/bracemark-expo/.env.local` naming the Mac's `.local` host — the
real-device setup in [device-testing.md](./device-testing.md) — passes on the
iOS simulator and fails every Android emulator flow at sign-in, with nothing
reaching the api: on that network the emulator did not resolve the name, which
is conditional rather than constant (device-testing.md, _one bundle, one set of
origins_). The native preflight now refuses such a bundle and prints the repair
(_driving the native apps_).

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

The Phase 8 scale, loading, viewport and offline cases were measured 2026-09-23
from commit `783141b` with their changes present in the working tree — system
Chrome 153.0.8010.53, Playwright 1.62.1, the iPhone 17 Pro simulator on iOS 26.5,
`bracemark-pixel8` (`sdk_gphone64_arm64`, Android 16), app 1.0.0 (1), Maestro
2.8.0:

| surface        | measured result                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web            | **33/33 passed** in one invocation — the full suite with `SCALE-WEB-001`, `SKELETON-WEB-001`, `OFFLINE-WEB-001`, no retries, 3.9 min                                                                  |
| pwa            | **2/2 passed** — `PWA-001`, `PWA-002`, against a freshly built and staged production export                                                                                                           |
| iOS native     | **5/5 passed** in one invocation — `SCALE-IOS-001`, `SKELETON-NATIVE-001`, `VIEWPORT-BULK-001`, `VIEWPORT-KEYBOARD-001`, `OFFLINE-IOS-001`; the keyboard case twice more on its final drag            |
| Android native | **4/5** in one invocation — `SCALE-ANDROID-001`, `SKELETON-NATIVE-001`, `VIEWPORT-BULK-001`, `OFFLINE-ANDROID-001`; `VIEWPORT-KEYBOARD-001` **4 of 8 runs**, every red one the open tap-through below |

One app bug, fixed in the same change: **offline, a view change in the open web
app navigated to the browser's error page** (`router.push` → the History API;
_scale, loading and offline_ above, and [search.md](./search.md)). One harness
tripwire, now a preflight: the iOS device's own hardware-keyboard memory
(`HardwareKeyboardLastSeen`) hid the software keyboard with Simulator's setting
correctly off. Three iOS runs were lost to SpringBoard segfaults inside the
simulator (a null dereference in Apple's process, with SafariViewService in the
same second), each sending the app to the Home screen between a flow and the
runner's next hierarchy read. All three followed a `launchctl stop` of
SpringBoard made to clear the keyboard flag; none recurred after a device
reboot, which is now the documented fix.

Each web case was also run against the behaviour it guards and failed:
`SCALE-WEB-001` with `readRest` handed no pinned paths (at the first pin,
counted twice), `SKELETON-WEB-001` with the skeleton rendering nothing (at the
status region), `OFFLINE-WEB-001` against the pre-fix `router.push` (at the
first view change), and `PWA-001` with the worker's precache and runtime caching
both emptied (at the worker assertion). The native cases have **not** had that
check yet — the same open half as the Phase 3 native flows.

The Phase 9 subscription cases were measured 2026-09-23 from commit `ee36b43`
with their changes present in the working tree — system Chrome 153.0.8010.53,
Playwright 1.62.1, bundled Chromium 151.0.7922.34, the iPhone 17 Pro simulator on
iOS 26.5 with its App Store sandbox account signed out, `bracemark-pixel8`
(`sdk_gphone64_arm64`, Android 16, no Google account), app 1.0.0 (1), Maestro
2.8.0, against the Paddle and App Store sandboxes:

| surface        | measured result                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------- |
| web            | **9/9 passed** — `IAP-WEB-001`, `IAP-ENTITLEMENT-001`, `IAP-DOWNGRADE-001`, three repeats, no retry |
| extension      | **3/3 passed** — `IAP-ENTITLEMENT-001`, three repeats, no retry                                     |
| iOS native     | **2/2 passed** twice — `IAP-NATIVE-001`, `IAP-ENTITLEMENT-001`                                      |
| Android native | **1/1 passed** twice — `IAP-ENTITLEMENT-001`; `IAP-NATIVE-001` is iOS-only (_subscriptions_, above) |

One app bug, fixed in the same change: a backed-out store sheet reported as an
error (_subscriptions_). One harness tripwire, now a gotcha: StoreKit's title
carries a no-break space that no typed selector matches.

Every case was also run against the behaviour it guards and failed: `IAP-WEB-001`
with the overlay's `onClosed` a no-op (at the first return to the card),
`IAP-ENTITLEMENT-001` with the web and the expo Refresh not re-reading (at the
refreshed plan, web and iOS) and with the cap ignoring the plan (the browser
extension, at the wall), `IAP-DOWNGRADE-001` with nesting grandfathered for an
account that already had nested lists (at the nesting paywall — a mutation
`IAP-ENTITLEMENT-001` stays green under), and `IAP-NATIVE-001` against the
pre-fix `openStoreCheckout` (at the error notice, iOS).

The visual checkpoints were measured on the web 2026-09-23 from commit
`055b09f` with their changes present in the working tree — system Chrome
153.0.8010.53, Playwright 1.62.1 — and on the devices 2026-09-24 from commit
`84e16cb` with the two harness fixes below in the working tree — the iPhone 17 Pro
simulator on iOS 26.5, `bracemark-pixel8` (`sdk_gphone64_arm64`, Android 16),
app 1.0.0 (1), Maestro 2.8.0. Every native leg ran alone, not beside the other
platform's:

| surface | measured result                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| web     | **76 captured and accepted**, then **76/76 same** on the next full run                                                       |
| iOS     | **4/4 cases, 47 captured and accepted** in one invocation (23.7 min), then **47/47 same** on the next (23.8 min)             |
| Android | **4/4 cases, 47 captured and accepted** in one invocation (37.7 min), then **45/47 same** on the next (21.1 min) — see below |

Two harness faults, both caught by a repeat and fixed in the same change. iOS's
"◀ Safari" breadcrumb (_visual checkpoints_, above): the first iOS repeat read
`signed-out` as `changed` at 0.12%. And the Android repeat's two misses were
`app-lock-dialog`, at ~1%: the dialog identical, the Settings page behind its
scrim some 50px higher, because `scrollUntilVisible` stops wherever the swipe's
fling runs out. The flow now scrolls on to the page's end
(`parts/visual-app-lock-dialog.yaml`); with it the lock case read **6/6 same**
twice on Android and once on iOS, against the baselines already accepted. One
iOS lock run before that failed in `visual-list-lock.yaml` with the lock
password never typed ("Please enter a password"): the tap on the auto-focused
field, aimed mid-slide, landed on the dialog's chrome and dropped the keyboard.
It is a gotcha now (_driving the native apps_), fixed in every flow with that
shape. The device
had been booted without Simulator.app open, which the logs show played no part.
The part's two failures on 2026-09-23 were not this: the password went in both
times, and each failed later, on the wrong-row lock of the `rightOf:` gotcha
(same list). One Android run was lost before all this, with the two
device legs started together: its sign-in typed `ee2e_…` for `e2e_…` and the
account refused it. Every leg since has run alone.

The comparison was run against the two things it exists to catch, on the web
lock case, and flagged both: the locked list's one-line description reworded
(its four captures `changed`, at 0.14–0.49% against the 0.05% threshold), and
the appearance flip made a no-op (all six dark captures, luma ratio 1.00, the
run red). No checkpoint is gated, and none has reached the catalog's
`promotionStreak` of five: the longest same-as-baseline streak is three runs.

`SHARE-IOS-003` was measured 2026-10-01 from commit `d38ace8` with its changes
present in the working tree, on the iPhone 17 Pro simulator, iOS 26.5, app 1.0.0
(1), Maestro 2.8.0: **passed**, twice, in about six minutes a run. It was then run
against both things it exists to catch and failed at the step that guards each:
with `holdSwipe` removed from the pickers, at the first held check — the pull
from the list picker's scroller took the sheet away (`share-back` not visible);
and with the guard's cleanup removed, so the hold is never given back, at the
last one, after all four picker flicks had passed — the compose screen could no
longer be swiped away (`share-add` still visible). Its first draft flicked at
100ms and passed the first of those two with no guard at all; that is recorded
with the case (_gestures and waits the runner performs_).

The `SHARE-EXTRACT-*` pair was measured 2026-10-11 from commit `62ea83c` with
its changes present in the working tree — the iPhone 17 Pro simulator on iOS
26.5, `bracemark-pixel8` (`sdk_gphone64_arm64`, Android 16), app 1.0.0 (1),
Maestro 2.8.0, against live example.com: **passed**, twice on each platform, in
about three minutes a run. Each was then run against the behaviour it guards
and failed at the step that guards it:

- `SHARE-EXTRACT-ANDROID-001` with ShareBridge's pass no longer collecting the
  handoff — at the title wait: after 60s the row was still on its
  `EXTRA_SUBJECT`. That is every Android share before the handoff existed, not
  a race.
- `SHARE-EXTRACT-IOS-001` with the drain no longer held for a ready store — at
  the absence check: the prompt's `Dismiss` was up for the link the cold start
  had just drained. Until this run, that a cold start's first pass hands its
  links to a dead `extractNow` was read from source
  ([share-sheet.md](./share-sheet.md), _the main app's half_).

One harness fault, found by the iOS case's first run and fixed in the same
change: Safari's one-time coachmark came up before example.com had painted, and
while it is up the page is not in the tree, so the wait on the page ran out
under it. `subflows/open-system-share.yaml` now waits for the page OR the
coachmark, dismisses the coachmark, and then waits for the page. The other iOS
share cases never met it — the api's health document paints first. The new
order has only run on a simulator whose coachmark was already dismissed, which
is the state the probe that found it left behind.

The cases those changes could reach were re-run the same day, each leg
alone: Android **11/11** (`NATIVE-ACCOUNT-001`,
`SHARE-ANDROID-001`/`002`, `SHARE-BOUNDARY-001`, `SHARE-CREATE-001`,
`SHARE-CROSS-CLIENT-001`, `EXTRACT-NATIVE-001`, `EXTRACT-NATIVE-ALL-001`,
`SKELETON-NATIVE-001`, `SIGN-OUT-RESIDUE-NATIVE-001`,
`SESSION-EXPIRED-NATIVE-001`) and iOS **9/9** (`NATIVE-ACCOUNT-001`,
`SHARE-IOS-001`–`003`, `SHARE-BOUNDARY-001`, `SHARE-CROSS-CLIENT-001`,
`EXTRACT-NATIVE-001`, `SIGN-OUT-RESIDUE-NATIVE-001`,
`SESSION-EXPIRED-NATIVE-001`).

The PWA update and navigation cases were measured 2026-10-05 from commit
`c6e089e` with their changes present in the working tree — system Chrome
154.0.8037.93, Playwright 1.62.1: **13/13 passed** (`PWA-001`–`013`) in one
invocation, 2.0 min, no retries. Each new case was then run against what it
exists to catch and failed:

- `PWA-008` with the changed page keeping its old revision — at the reload with
  the origin gone: the old page came back;
- `PWA-010` with the "uninstallable" build made installable — at the first
  check that build A was still in the precache;
- `PWA-009` with the pill ignoring builds, as it did before — at the no-pill
  assertion on the launch after a deploy;
- `PWA-009` and `PWA-011` with page loads answered from the precache first — both
  at their first assertion: the launch after a deploy was the old page;
- `PWA-012` and `PWA-013` with the navigation listener removed, so Serwist's
  precache strategy answered — `PWA-013` at the status (the 500 came through),
  and `PWA-012` at the launch itself, which had **not opened after its
  five-minute budget**. That is the measurement behind the timeout
  ([offline-mode.md](./offline-mode.md), _what answers a navigation_).

Four things the first drafts or the fixture got wrong are recorded with the
target (_the PWA target_, above): a document read with the origin up says
nothing about the worker, a wait on a worker event can hang, a stopped origin
cannot show a stall, and a registration of the wrong type installs the worker
twice.

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

### the cases where two clients are busy at once

`SYNC-CURSOR-001`, `SYNC-LISTING-001`, `SYNC-RETRY-001` and `SYNC-TABS-001`
(_cross-client sync_, above) were measured 2026-10-06 from commit `8227000` with
their changes present in the working tree — Playwright 1.62.1, system Chrome
154.0.8037.98, bundled Chromium for the browser extension, the iPhone 17 Pro
simulator on iOS 26.5, app 1.0.0 (1), Maestro 2.8.0:

| surface      | measured result                                                          |
| ------------ | ------------------------------------------------------------------------ |
| web          | **52/52 passed** in one invocation — the full suite, no retries, 4.6 min |
| extension    | **10/10 passed** in one invocation, 1.4 min                              |
| iOS contract | **3/3 passed** — frozen vectors, web→mobile, mobile→web                  |
| iOS native   | **8/8 passed** — the slice that rides the sync engine, one invocation    |

The native slice is not the native suite. The engine change is client-side on
both platforms and has no native case of its own (expo has one runtime per
store, so there is no second tab to race, and its cursor cases are drift guards
at unit level), so what was run is what would notice the engine being wrong:
`NATIVE-ACCOUNT-001`, `NATIVE-LINK-001`, `DATA-DELETE-ALL-NATIVE-001`,
`SYNC-REFRESH-PILL-IOS-001`, `SYNC-LOCAL-TOP-001`, `EXTRACT-NATIVE-001`,
`EXTRACT-NATIVE-ALL-001` and `OFFLINE-IOS-001`. Android, the PWA target and the
rest of the native suite were not run for this change.

**Each of the four was also run against the engine it guards**, which is the
half a green run cannot show. With the source mutated in the running dev server
and the case run alone, no retry: `SYNC-RETRY-001` without the first sync's
local-only drop left the deleted link on the retried profile (`toHaveCount(0)`,
received 1), and `SYNC-TABS-001` without the cycle lock found no cycle queued
behind the other tab's (`queued`, received false). `SYNC-CURSOR-001` and
`SYNC-LISTING-001` had been run against the engine before the cursor change,
where each failed on the link that never arrived.

Two things about the run itself, both harness:

- **The first attempt at a full run failed three cases, none of them these.**
  It was started on spare ports beside another checkout's stack, and the
  `EXTRACT-*` cases need the extractor, whose development CORS allows the
  default web origin only. On `npm run dev`'s own ports all three pass. Run this
  suite on the default ports, or exclude `internet`.
- **Excluding `internet` did not exclude them**, which is what turned a port
  mix-up into a red run: the selection went to Playwright as `--grep`, and a
  dependency project ignores it (_cases, suites and fixtures_, above). Fixed in
  the same change.

Nothing here runs automatically. There is still no CI ([testing.md](./testing.md)),
and the only git hook guards `internal/`.
