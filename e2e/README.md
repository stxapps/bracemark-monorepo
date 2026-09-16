# @stxapps/e2e

Whole-flow tests: a real build, a real browser or device, a whole flow.

**The design record is [`docs/e2e.md`](../docs/e2e.md)** — what belongs at this
layer, why the standard Playwright auth fixture cannot work in this app, and the
constraints that shape everything here. This file is the operational half; read
that one before changing anything.

## running

Everything needs the dev stack first — with one exception, the vectors leg,
which talks to no server and needs no account:

```sh
npm run dev        # api :8787, web :3000, extractor :8788
```

The web wrapper boots and waits for it itself when the ports are free. Every
wrapper rejects a listener owned by another checkout before it creates test
data. Native runners require an already-running stack and Metro.

```sh
npx nx e2e-web @stxapps/e2e
npx nx e2e-web:headed @stxapps/e2e
npx nx e2e-web:report @stxapps/e2e
npx nx e2e-extension @stxapps/e2e

# Use exact ids from `xcrun simctl list devices booted` or `adb devices`.
npx nx e2e-mobile @stxapps/e2e -- --platform ios --device <udid> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform ios --device <udid>
npx nx e2e-mobile @stxapps/e2e -- --platform android --device <serial> --suite full
npx nx e2e-contract @stxapps/e2e -- --platform android --device <serial>
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

The four run-it targets also have root scripts: `npm run e2e:web`,
`e2e:extension`, `e2e:mobile`, `e2e:contract`. There is no bare `npm run e2e` —
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
belongs to this checkout, and Android has completed boot with all three reverse
mappings. Web e2e is platform-independent — run it once.

```sh
npm run expo:ios                    # or: npm run expo:android
npm run expo:android:reverse        # Android only, once per emulator boot
npm run e2e:mobile -- --platform ios --device <udid>
npm run e2e:contract -- --platform ios --device <udid>
```

Both build commands hold the foreground running Metro, so the rest wants a second
terminal.

## layout

| path               | what                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `cases.json`       | case ids, tiers, traits, fixtures, paths, artifact expectations       |
| `fixtures.json`    | empty/small/scale and deterministic/online URL fixture contracts      |
| `paths.ts`         | where a run writes — the only source of `.artifacts` paths            |
| `web/`             | Playwright specs (`*.e2e.ts`) and their fixtures                      |
| `extension/`       | unpacked MV3 specs, shared driver, and release qualification          |
| `mobile/flows/`    | Maestro flows that run standalone                                     |
| `mobile/shots/`    | Maestro flows for native store-listing captures                       |
| `mobile/contract/` | Maestro legs of a contract run — driven by a `runner/`, never by hand |
| `runner/`          | web/native orchestrators, filters, preflights, manifests              |
| `seed/`            | the four dev accounts and their archives — not a test (above)         |
| `shot/`            | the published screenshots: the fixture, the producer, the four legs   |
| `.artifacts/`      | gitignored — traces, reports, run manifests, browser profiles         |
| `credentials/`     | gitignored — the accounts `npm run seed:accounts` created             |

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

## what a spec may depend on

**No spec depends on a seeded account, and none should.** Every web spec creates
its own throwaway account per worker (`web/fixtures/app.ts`), and the mobile and
contract runners provision one through `provisionAccount`. The four seeded
accounts are a HUMAN's fixture: you sign into them, edit them, and leave them in
whatever state you left them in, so a spec asserting on one would be asserting on
something a person changes by hand.

The **archives** are the other half of that rule and the useful half: they are
pure functions of `seed/library.ts`, so a spec that genuinely needs a library at
scale — paging, virtual scrolling, search over a thousand links — should build one
with `generateArchives()` into its own fresh account rather than clicking a
thousand links into being or reaching for `seed_plus_full`. Nothing does this
today; it is where to start if something needs to.

## four things that will surprise you

1. **Never add a jest config here.** `@nx/jest/plugin` infers a `test` target from
   its presence, and this project would silently join `npm run test`.
2. **Tests in a worker share one account.** Namespace with `unique()`
   (`web/fixtures/data.ts`), never assert on a global count, never sign out (see
   `account.e2e.ts`).
3. **Assert on what the user typed, not what was extracted.** The extractor's SSRF
   guard makes a local fixture server unreachable by design, so specs use
   unresolvable `.invalid` URLs — `unresolvableUrl()`, same module.
4. **The `testID`s the flows bind to are an interface.** They live in
   bracemark-expo, and renaming one fails a flow as a bare timeout on a missing
   element — never as anything that names the rename. The list is in
   `docs/e2e.md`, _the testID contract_ — which now also lists three
   `contract-vectors` ids that exist only in a dev build, because the screen
   carrying them redirects away in production.
