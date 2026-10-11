# @stxapps/e2e

Whole-flow tests: a real build, a real browser or device, a whole flow.

**The design record is [`docs/e2e.md`](../docs/e2e.md)** — what belongs at this
layer, why the standard Playwright auth fixture cannot work in this app, and the
constraints that shape everything here. This file is the operational half; read
that one before changing anything.

## staging Release runs

`npm run e2e:web:staging`, `e2e:mobile:staging`, and `e2e:contract:staging`
test deployed dryrunbase.com services. Mobile needs an installed Release artifact
and its build receipt, produced by `npm run e2e:build:staging -- --platform
android|ios`. No local stack or Metro is used. Commands, admitted cases, CSP
requirements, and coverage limits: [STAGING.md](./STAGING.md).

## running locally

The local targets need the dev stack first — with one exception, the vectors leg,
which talks to no server and needs no account:

```sh
npm run dev        # api :8787, web :3000, extractor :8788
```

No wrapper starts it: each fails at once, naming the leg, when one it needs has
no listener, and rejects a listener owned by another checkout before it creates
test data. Native runners need Metro as well.

```sh
npx nx e2e-web @stxapps/e2e
npx nx e2e-web @stxapps/e2e --headed
npx nx e2e-web:report @stxapps/e2e
npx nx e2e-extension @stxapps/e2e
npx nx e2e-pwa @stxapps/e2e

# Use exact ids from `xcrun simctl list devices booted` or `adb devices`.
npx nx e2e-mobile @stxapps/e2e -- --platform ios --device <udid> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform ios --device <udid>
npx nx e2e-mobile @stxapps/e2e -- --platform android --device <serial> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform android --device <serial>

# Visual checkpoints: capture, compare with this machine's baseline, report.
npx nx e2e-visual @stxapps/e2e -- --platform web
npx nx e2e-visual @stxapps/e2e -- --platform ios --device <udid>
npx nx e2e-visual @stxapps/e2e -- --platform android --device <serial> --accept
```

The vectors leg runs FIRST in that chain on purpose: it is the cheapest and the
most fundamental. If the frozen crypto table no longer holds on the device the
two round trips are going to fail too, and they would fail as a link that did not
appear — a much longer walk back to the same answer. Run it alone with the
contract target plus `--case CONTRACT-VECTORS-001`; it needs the dev build and
Metro, and nothing else.

The browser extension target needs Playwright's bundled Chromium; install it once
with `npx playwright install chromium` if the runner reports it missing. It builds
and stages the unpacked development extension itself. The staged popup path does
not prove Chrome's real toolbar-created `activeTab` grant; release checks live in
[`extension/RELEASE.md`](./extension/RELEASE.md).

`--suite smoke` selects only smoke cases; `full` includes smoke and full (never
release qualification). Narrow any
runner with repeatable/comma-separated `--case`, `--include-trait`, and
`--exclude-trait`. The registry is [`cases.json`](./cases.json); its ids and tags
are checked against the specs and flows by `npm run check:registry -w
@stxapps/e2e`.

Every invocation writes to a unique `.artifacts/runs/<run-id>/`. Web keeps its
HTML report, failure screenshots, and traces there. Native keeps a redacted run
manifest, per-case JUnit, Maestro command/log/screenshot output, named stable
checkpoints, and a hierarchy dump on failure. A pass that needed Playwright's
retry exits non-zero.

The six run-it targets also have root scripts: `npm run e2e:web`,
`e2e:extension`, `e2e:pwa`, `e2e:mobile`, `e2e:contract`, `e2e:visual`. There is no bare `npm run e2e` —
see `docs/e2e.md`, _running_.

## seeding a dev account

Not a test — `init` for looking at the app by hand. Four accounts on the local
stack, two with a full library, so paging, the list/tag tree, filtering,
drag-and-drop and the search editor have something to work on.

```sh
npm run seed:accounts              # all four (needs `npm run dev` up)
npm run seed:accounts -- free-full # or just one
npm run seed:fixtures              # the backup archives only — no browser, no api
```

`seed:accounts` regenerates the archives itself — `seed:fixtures` is for looking
at one, or importing it by hand, not for feeding the other. There is no bare
`npm run seed`: the two things it could have meant are these two.

| key          | username          | plan | library                                    |
| ------------ | ----------------- | ---- | ------------------------------------------ |
| `free-empty` | `seed_free_empty` | Free | nothing                                    |
| `plus-empty` | `seed_plus_empty` | Plus | nothing                                    |
| `free-full`  | `seed_free_full`  | Free | 190 links, 8 flat lists, 14 flat tags      |
| `plus-full`  | `seed_plus_full`  | Plus | 1,000 links, 24 nested lists, 40 flat tags |

Passwords land in `credentials/accounts.json` (gitignored). The whole design —
why the library is imported through the app while the plan is written straight to
D1, and the four things that will surprise you — is `docs/e2e.md`, _seeding a dev
account_. The one to know before you edit `seed/library.ts`: **re-seeding does
not update an account that already exists** (a backup merge is skip-existing by
path), so delete all data in Settings → Data first.

A single case: `npm run e2e-web -- --case WEB-LINK-001`. A spec file can still be
added as a trailing Playwright argument.

The mobile and contract targets also need a **bracemark-expo dev build installed
on a booted simulator or emulator**. Nothing here builds the app —
`npx nx ios @stxapps/bracemark-expo` (or `android`) does, and it is a
prerequisite, not an e2e step.

Platform and device are mandatory and are passed to Maestro explicitly. The
preflight proves that exact device is booted, the dev build is installed, Metro
belongs to this checkout and serves a bundle whose api is the local one, and
Android has completed boot with all three reverse mappings. Web e2e is platform-independent — run it once.

```sh
npm run expo:ios                    # or: npm run expo:android
npm run expo:android:reverse        # Android only, once per emulator boot
npm run e2e:mobile -- --platform ios --device <udid>
npm run e2e:contract -- --platform ios --device <udid>
```

Both build commands hold the foreground running Metro, so the rest wants a second
terminal.

## layout

| path                  | what                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `cases.json`          | case ids, tiers, traits, fixtures, paths, artifact expectations       |
| `fixtures.json`       | empty/small/scale and deterministic/online URL fixture contracts      |
| `visual.json`         | the named visual checkpoints, their masks and gates                   |
| `paths.ts`            | where a run writes — the only source of `.artifacts` paths            |
| `web/`                | Playwright specs (`*.e2e.ts`) and their fixtures                      |
| `extension/`          | unpacked MV3 specs, shared driver, and release qualification          |
| `pwa/`                | installed-production-build specs and the static origin they own       |
| `visual/`             | web visual checkpoint specs and their capture helper                  |
| `mobile/flows/`       | Maestro flows that run standalone                                     |
| `mobile/flows/parts/` | the later steps of a runner-driven case — never run alone             |
| `mobile/RELEASE.md`   | real-device biometric lock checks (release qualification)             |
| `mobile/shots/`       | Maestro flows for native store-listing captures                       |
| `mobile/contract/`    | Maestro legs of a contract run — driven by a `runner/`, never by hand |
| `runner/`             | web/native orchestrators, filters, preflights, manifests              |
| `seed/`               | the four dev accounts and their archives — not a test (above)         |
| `shot/`               | the published screenshots: the fixture, the producer, the four legs   |
| `.artifacts/`         | gitignored — traces, reports, run manifests, browser profiles         |
| `credentials/`        | gitignored — the accounts `npm run seed:accounts` created             |

Native share cases are ordinary `e2e-mobile` cases. Their first registered flow
prepares the main-app state; `runner/share.ts` then performs the real Safari or
Android `ACTION_SEND` handoff between committed part flows. Run Phase 6 alone by
passing its comma-separated case ids to `--case`, once per platform.

The extraction cases (Phase 7: `EXTRACT-*`, and Phase 6's `SHARE-EXTRACT-*` pair)
are the only ones that reach the
public internet — example.com, from `fixtures.json` — and carry the `internet`
trait for it. They need the extractor on 8788, which `npm run dev` starts with
the api and web. `--exclude-trait internet` gives
a run with no third-party network dependency; `online` does not, because every
stack-backed case carries it.

The PWA target (`PWA-001`–`013`) builds bracemark-web's production export
against the local stack itself (`nx build @stxapps/bracemark-web -c
development`), stages a copy in the run directory, and serves it on
`localhost:3001` from inside the spec, stopping it to make the origin
unavailable — or stalling it, or making it answer 500 (`PWA-012`/`013`). The
update cases (`PWA-007`–`011`) "deploy" later builds over a
copy of that export (`pwa/fixtures/build.ts`). It needs only the api up —
`npm run dev` is fine — and `:3001`
free, so stop the marketing site's dev server first. The real install surfaces,
Safari and Firefox, and an update from the real host are `PWA-RELEASE-001` in
[`web/RELEASE.md`](./web/RELEASE.md).

Phase 8's native cases (`SCALE-*`, `SKELETON-NATIVE-001`, `VIEWPORT-*`,
`OFFLINE-*`) run in the ordinary `e2e-mobile` target. Two of them —
`SKELETON-NATIVE-001` and `OFFLINE-IOS-001` — freeze the local api process for
a stretch (`runner/api-pause.ts`), which stalls every client of it: never run a
second native leg, or anything else against the stack, beside them. If a run was
killed with SIGKILL and the api stops answering, `kill -CONT` the process on 8787. The `SCALE-*` and `SKELETON-NATIVE-001` accounts import and upload a
thousand links first (about a minute), and the device's first pull follows.

Phase 9's subscription cases (`IAP-*`) buy nothing. `IAP-WEB-001` needs the
api started by `npm run dev`, which hands it the Paddle sandbox key from the
keychain, and reaches Paddle's sandbox (`internet`); each run leaves one unpaid
`ready` transaction there. `IAP-NATIVE-001` is iOS-only and needs the
simulator's App Store sandbox account **signed out**; a run that stops with
StoreKit's sign-in prompt up leaves it over the next case, so press its Cancel
first. `IAP-ENTITLEMENT-001` runs on web, the browser extension, iOS and
Android — the same id on each surface, so run it once per target. The provider
purchases and restores are `web/RELEASE.md` and `mobile/RELEASE.md`
(docs/e2e.md, _subscriptions_).

## visual checkpoints

`e2e-visual` photographs every named checkpoint in `visual.json` — light and
dark; wide and narrow on the web; a large text size on a device — masks what
moves, and compares each capture with this machine's accepted baseline. It is
**review-only**: a changed capture is listed in `visual/report.html` beside its
baseline and a diff, and fails nothing unless its checkpoint is gated. The run
does fail on a missing capture, or a dark capture that is not darker than its
light twin. `--accept` makes a complete run the baseline, under
`.artifacts/visual/baselines/<profile>/` (local and gitignored — clearing
`.artifacts` clears them). The device legs restore the appearance, text size and
status bar they found. Design: `docs/e2e.md`, _visual checkpoints_.

## the published screenshots

Also not a test, and its own folder rather than a corner of `seed/`: `e2e/shot/`
holds the 26-URL fixture, the producer and the four legs. One account, built once,
photographed by three of them — the design record is `docs/e2e.md`, _the published
screenshots_.

```sh
npm run shot:preflight           # check the URL list — seconds, no browser
npm run shot:account             # build the account: import → extract → previews
npm run shot:account -- --fresh  # …wiping its data first, after editing the list
npm run shot:web                 # the site figure + the PWA install-dialog scenes
npm run shot:ext                 # the browser extension's popup
npm run shot:mobile -- ios       # the native store captures (one platform at a time)
```

That is the order to run them in, and it is the order they are listed in
`package.json`. The last three only sign in: each refuses to run against an
account `shot:account` has not built, and says so by name. There is no bare
`npm run shot` for the same reason there is no bare `npm run e2e`.

Every file here is named for its target — `shot/preflight.ts`, `shot/account.ts`,
`shot/web.ts`, `shot/extension.ts` (`shot:ext`, the one abbreviation),
`shot/mobile.ts` — over one shared fixture (`shot/library.ts`, the 26 URLs) and
one scene table (`shot/scenes.ts`, what `web.ts` photographs). The Maestro YAML
`shot/mobile.ts` drives stays in `mobile/shots/`, with the rest of the flows.

## measuring the data path

Also not a test: `e2e/measure/` reports how long import and export hold the web
app's main thread, at library sizes you pick, against a production export it
builds and serves on :3001. It needs the api up (`npm run dev`). Design:
`docs/e2e.md`, _measuring the data path_. What the numbers decide:
`docs/data-lifecycle.md`, _main-thread cost_.

```sh
npm run measure:data                                # 10,000 links, CPU 4x slower
npm run measure:data -- --links 10000,50000 --cpu 6
npm run measure:data -- --trace                     # + a DevTools trace per leg
```

The native leg (`e2e/measure/native.ts`) measures bracemark-expo through Maestro
on a booted simulator or emulator, with a production bundle it serves from its
own Metro (so :8081 must be free):

```sh
npm run measure:native -- --platform ios --device <udid>
npm run measure:native -- --platform android --device <serial> --links 1000,10000
```

## what a spec may depend on

**No spec depends on a seeded account, and none should.** Every web spec creates
its own throwaway account per worker (`web/fixtures/app.ts`), and the mobile and
contract runners provision one through `provisionAccount`. The four seeded
accounts are a HUMAN's fixture: you sign into them, edit them, and leave them in
whatever state you left them in, so a spec asserting on one would be asserting on
something a person changes by hand.

The **archives** are the other half of that rule and the useful half: a spec
that genuinely needs a library past the first page builds one into its own fresh
account rather than clicking links into being or reaching for `seed_plus_full`.
`web/fixtures/library.ts` writes a paged library whose row order is known — every
link in one list, newest first, at `.invalid` URLs — and the scroll, bulk-selection
and native recycling cases import it through Settings → Data. `seed/library.ts`'s
`generateArchives()` is the realistic one, for a case that needs a real spread of
lists, pins and trash.

A case whose subject is a Plus lever (nesting, the search editor, locks) grants
the account the existing `manual` plan through local D1 (`web/fixtures/plan.ts`).
It is the same plaintext row the seed writes, not a test endpoint.

## four things that will surprise you

1. **Never add a jest config here.** `@nx/jest/plugin` infers a `test` target from
   its presence, and this project would silently join `npm run test`.
2. **Tests in a worker share one account.** Namespace with `unique()`
   (`web/fixtures/data.ts`), never assert on a global count, never sign out (see
   `account.e2e.ts`).
3. **Assert on what the user typed, not what was extracted** — unless the case is
   an `internet` extraction case. The extractor's SSRF guard makes a local fixture
   server unreachable by design, so specs use unresolvable `.invalid` URLs —
   `unresolvableUrl()`, same module. The exceptions use `web/fixtures/extraction.ts`
   and nothing else.
4. **The `testID`s the flows bind to are an interface.** They live in
   bracemark-expo, and renaming one fails a flow as a bare timeout on a missing
   element — never as anything that names the rename. The list is in
   `docs/e2e.md`, _the testID contract_ — which now also lists three
   `contract-vectors` ids that exist only in a dev build, because the screen
   carrying them redirects away in production.
