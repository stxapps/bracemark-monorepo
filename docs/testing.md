## testing

What is tested, by which runner, and how each app is driven when a change needs
to be seen working rather than asserted on. Three layers, and they are not
interchangeable — most of this doc is about which one a given question belongs
to.

| layer                | what it covers                                       | how it runs                         |
| -------------------- | ---------------------------------------------------- | ----------------------------------- |
| **unit / component** | pure logic, hooks, a rendered component's behaviour  | `npm run test` — jest or vitest     |
| **native unit**      | Swift/Kotlin the JS suites cannot reach              | `swift test`, `gradlew … test`      |
| **driving the app**  | a real build, a real browser or device, a whole flow | `e2e/`, by hand / by agent          |
| **typecheck + lint** | boundaries, types, the module-boundary tags          | `npm run typecheck`, `npm run lint` |

The second layer now has a home: **`e2e/`, one Nx project, its own targets, never
part of `npm run test`.** This doc stays the record of _which layer a question
belongs to_; [e2e.md](./e2e.md) is the record of how that layer is built — the
three surfaces it drives, why the standard Playwright auth fixture can't work
against a non-extractable `CryptoKey`, and what e2e is forbidden to assert.

The **native unit** row is small and easy to miss, and it is not part of
`npm run test` — nothing in npm can run it. Today it is one suite per platform,
both covering the `BracemarkFileCrypto` blob framer in `@stxapps/expo-crypto`:
`swift test` from `packages/expo-crypto`, and
`./gradlew :stxapps-expo-crypto:test` from `apps/bracemark-expo/android`. Neither
needs a simulator, because the framing was deliberately split out of the expo
`Module` class into `BlobFrame.{swift,kt}` — inside it, reaching the code meant
booting an app, which is why it went untested for as long as it did. Both read
`packages/shared/src/crypto/contract-vectors.json`, the generated twin of the
golden vector, so they cannot drift from what the JS suites assert.

The rule that generalizes: **if native code holds a value that a frozen contract
also defines, the copy needs a test, because nothing else will ever compare
them.** A Swift `let` and a TypeScript `const` holding the same byte have no
relationship a compiler, a linter or a type can see.

The typecheck+lint layer is easy to forget in a testing doc, but it is the one
that catches the largest class of mistake here: `@nx/enforce-module-boundaries` turns
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

### what earns a spec

**Meaningful coverage, not a percentage.** The specs here are written as design
records — each `it` names the silent failure it prevents, in the voice of `docs/`
— so a spec that restates data or re-tests a dependency dilutes the suite and
breaks on every legitimate edit. _coverage today_ below is that argument worked
through project by project, including the files that have **no spec on purpose**;
this is the rule it generalizes to. A declarative zod-schema file does not
normally earn one — say so rather than writing it — unless the schema encodes a
cross-file coupling nothing else pins (the IAP checkout contract enumerating
`AVAILABLE_PAID_PLANS` rather than `PAID_PLANS` is the case that does). Derive a
test table from the constants under test, so a catalog change moves the spec with
it, and prefer relations — monotonic, subset, round-trip — over restating values.

**Prove both halves by mutating the source.** A gap is only real if the suite
stays green without the new assertion, and the assertion only earns its place if
it then fails: flip a boundary (`<` → `<=`), delete a guard, swap an enum, re-run,
put it back. One thing in this repo makes that check lie — **the doc-comment
decoy.** Sources restate their load-bearing SQL and guards verbatim in the comment
above them, so a mutation applied as "replace the first occurrence" patches the
COMMENT and leaves the code intact: the suite stays green and a correct assertion
looks worthless. `apps/bracemark-api/src/db/repositories/purchases.ts` is the
specimen — the upsert's `WHERE excluded.event_occurred_at >= event_occurred_at`
appears in its doc comment ~45 lines above the real SQL. Include the surrounding
whitespace or backticks so the match can only hit code, and `grep -n` the mutated
file to confirm which line moved before trusting a green run.

#### tripwire: one dynamic import bans every static one

`@nx/enforce-module-boundaries` classifies a workspace package as **lazy-loaded**
the moment anything `import()`s it — a spec included — and then forbids every
STATIC import of it across that project. One
`await import('@stxapps/shared')` in
`packages/web-react/src/lib/auth-api-client.spec.ts` made
`npx nx lint @stxapps/web-react` fail with 51 errors reading _"Static imports of
lazy-loaded libraries are forbidden"_, pointing at ~30 ordinary SOURCE files
(`extraction-provider.tsx`, `lock-provider.tsx`, …) and never at the spec, which
appears once, unlabelled, in the summary list at the bottom of the output. The
error text names the victims and never the cause, and `--fix` cannot fix it. So
**import workspace packages statically in a spec**; if a dynamic import is
genuinely needed, expect this and read the summary list rather than the error
lines. Baseline lint on a clean tree is green, so `git stash -u` + re-lint is what
actually localizes it.

### which runner, and why

Two runners, split by **the runtime the code has to execute in** — not by
preference, and not by drift.

| runner       | projects                                            | why                                                                       |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| **jest 30**  | all 7 packages + `web`, `site`, `extension`, `expo` | jsdom for web, `jest-expo` for React Native. Pinned in the root manifest. |
| **vitest 4** | `bracemark-api`, `bracemark-extractor`              | `@cloudflare/vitest-pool-workers` runs specs **inside workerd**.          |

The two Workers apps are the exception that explains itself: their tests run in
the real runtime via miniflare, so `bracemark-api` gets real local D1, a real
SQLite-backed Durable Object and real R2, and `bracemark-extractor` gets the
real `HTMLRewriter` and stream primitives. A Node runner could only mock those,
which would encode our assumptions back at us. That pool exists for vitest and
has no jest equivalent, so the choice was made by the runtime. Both
`vitest.config.ts` files carry the full reasoning at their top — read those, not
a paraphrase here. Vitest is declared in the two app manifests; jest is pinned
at the root.

`npm run test` is `nx run-many -t test` and covers **all 13 projects with a test
target**. A second run prints almost nothing and finishes in ~150ms — that is
Nx cache reporting `13/13 hit`, not projects being skipped. To force real
execution, `npx nx reset` or scope to one project with
`npx nx test @stxapps/<project>`.

### the one thing outside the two runners

`tools/cloudfront/rewrite-url.js` is the CloudFront function that gives both static
sites their clean URLs ([hosting.md](./hosting.md#clean-urls--the-cloudfront-function)).
It is the only thing in `tools/` that nothing in this repo executes — the eslint rule
runs under `npm run lint`, `check-private.mjs` under the pre-commit hook,
`deploy-static.sh` under a deploy script, but that file is an artifact you upload to
AWS. So it gets `rewrite-url.test.mjs` beside it, run by **node's own test runner**:

```bash
npm run test:cloudfront
```

Not an Nx project, so **not part of `npm run test`** — a package.json and a jest config
for one dependency-free file would put a thing in the project graph that is not a
package. The tradeoff is that it only runs when someone runs it, which is the same
deal as every other test here.

Node is not the runtime it will execute in, and this is the rare case where that gap
is not fixable from inside the repo: `cloudfront-js-2.0` is ES 5.1 plus a subset of
ES 6-12, and only `aws cloudfront test-function` runs the real thing. The node suite
pins the RULES — the redirect table, the query-string handling, the 10 KB size
ceiling — and says so at the top of the file, including what it cannot catch.

### the portability suites

The runner table above splits by the runtime code executes in, which leaves one
thing uncovered: `shared` and `react` are `platform:agnostic` — compiled once and
run on browsers, on workerd and on Hermes — yet their own specs run on node under
jest, which has every global all three engines lack. That is exactly how
`crypto.getRandomValues` in `crypto/passphrase.ts` reached production: it
typechecked, it passed lint, it passed 37 jest specs, and it threw
`ReferenceError: Property 'crypto' doesn't exist` when `bracemark-expo`'s
create-account screen mounted. A missing global is a fact about an engine, and
node is not one of our engines.

Two static guards now bound what agnostic code may assume — the `webworker`
ambient surface in `packages/shared/tsconfig.lib.json` and the deny list in
`tools/eslint/agnostic-globals.mjs` (docs/architecture.md, _the globals a
`platform:agnostic` package may assume_). Both reason about what the source
_says_. These two check what an engine actually _does_:

- **workerd** — `apps/bracemark-api/src/shared-portability.spec.ts`. It lives in
  that app only because the Workers pool is the workspace's one non-node test
  runtime; it tests the dependency, not the api. Importing the `@stxapps/shared`
  barrel is itself half the test — every module evaluates, which is what catches
  a module-scope global reach (`@noble/hashes` reads `globalThis.crypto` once at
  init and captures the result, so that failure lands at import, not at call).
  The rest calls the functions that reach a global at call time, so an engine
  that has the name but not the behaviour still fails.
- **Hermes** — no equivalent exists and none can cheaply: `jest-expo` runs on
  node, not Hermes, and there is no in-engine runner for React Native. It's
  enforced at runtime instead, by the `__DEV__` audit in
  `apps/bracemark-expo/src/polyfills.ts` that throws at launch naming any missing
  global — so every dev launch and every Maestro run checks it for free
  (docs/expo-native-deps.md, _runtime polyfills_).

Keep the two global lists in step; together they're one contract checked on the
two engines that can't be taken for granted. Neither sees import **order**, which
is why `polyfills.ts` is the first import of both native entries.

### the ported pair: two sync engines

`web-react/src/sync/engine.ts` and `expo-react/src/sync/engine.ts` are the same
design written twice — one protocol, two platforms
([local-first-sync.md](./local-first-sync.md)). That shape asks a question no
other pair in the workspace does: how much of a spec should be written twice?

The split settled on is **cover the protocol once, cover the divergence
always**, plus a thin drift guard:

- **web's `engine.spec.ts` is canonical for the cycle.** The mid-cycle write
  hazards, the commit phase order, the first-sync counter, the quota gate — all
  of it is asserted there, in the app that has the most surfaces riding on it.
- **expo's `engine.spec.ts` covers the half web has no equivalent of**: `files/`
  content lives DECRYPTED ON DISK there, not as bytes in the row, so every
  content flow is a two-store write and the two stores can disagree silently.
  The load-bearing case is the asymmetry — a pull tears down the plaintext only
  for the rows it actually re-stored, because a path the local-wins guard spared
  still has a queued op whose upload reads that file.
- **the drift guards are the exception to "once".** The engines are duplicated
  _source_, so a spec that passes on web's copy proves nothing about expo's:
  edit expo's phase order or its self-heal and nothing in the workspace fails.
  One case each, not the full web matrix.

The store layer splits the same way: `expo-react`'s `data/item-store.spec.ts`
pins the guarded writes' SQL rather than restating what they mean.

Both expo suites run the real modules over shimmed native seams, which is what
makes that possible — `src/testing/node-sqlite.ts` puts the real DDL and the
real drizzle driver on `node:sqlite`, and `src/testing/memory-file-system.ts`
puts the real `data/file-store.ts` on an in-memory filesystem. Two
strictnesses in that shim are deliberate, because both catch real bugs: a
`delete()` of something absent throws, as the native API does, and so does a
write into a directory nobody created.

### the shared jest plumbing

Four config families, because `preset` takes exactly one value:

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
- **`bracemark-extension`'s own `jest.config.cts`** — preset-based like the six
  packages, but restating web-ui's transform pair rather than taking the
  preset's: `@nx/jest/preset`'s transform key covers `.ts` and **not `.tsx`**,
  and every component spec there is `.tsx`. Two things about it are specific to
  WXT and are written at the top of the file. First, `browser` and
  `defineBackground` are **auto-imports** — the source uses them as bare globals
  and WXT's vite plugin rewrites them at build time — so `testing/setup.ts`
  installs both as real globals, `browser` as a fresh
  `testing/fake-browser.ts` per test (its `storage.local` is a real in-memory
  store that fires `onChanged`, since that mirror IS the contract between the
  worker and the popup). Second, `utils/web-app-url.ts` branches on
  `import.meta.env.MODE`, which has no CommonJS spelling at all, so
  `moduleNameMapper` swaps that one module for `testing/web-app-url.ts` — the
  value the development build resolves to. Note the `@/` alias there is the
  PROJECT root, not `src/` (WXT's convention, see `.wxt/tsconfig.json`).

  **A spec directly under `entrypoints/` breaks the BUILD, not the test run.**
  WXT reads every file at that level as an entrypoint and names it by the
  basename up to the first dot, so `background.spec.ts` becomes a second
  entrypoint called "background" and `wxt build` fails with "Multiple
  entrypoints with the same name" — with `npm run test` perfectly green, since
  jest neither knows nor cares. An `entrypoints:found` hook in `wxt.config.ts`
  drops `*.spec.*`/`*.test.*` from that scan. Specs inside a directory
  entrypoint (`popup/`, `options/`) were never affected; only a bare file like
  `background.ts` has its spec land at the scanned level.

- **`next/jest`** — `bracemark-web` and `bracemark-site`. These **layer on top of
  `jest.preset.js`** rather than replacing it: the config handed to
  `nextJest()` still sets `preset: '../../jest.preset.js'`, and both files then
  patch the _resolved_ `transformIgnorePatterns` by hand, because `next/jest`
  only appends to it and can't relax the base `/node_modules/` ignore.
  `bracemark-web` also maps its own `@/…` alias by hand
  (`moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' }`), which is not
  belt-and-braces: `next/jest` derives its path mapping from a **resolved
  `baseUrl`**, and nothing in this workspace sets one — the `paths` entries are
  resolved relative to their own tsconfig by TS 5, and by its own resolver by
  Next. Without the mapping every `@/…` import is unresolvable under jest, and
  the failure surfaces on the first spec to render a component that uses the
  alias, naming a module that plainly exists.

**`jest.esm-packages.cjs` is the single source of truth** for node_modules that
ship raw ESM and must be transpiled rather than ignored. Every family that
reaches the preset reads it. Adding an ESM-only dependency that any spec touches means adding it there,
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

The honest state, so nobody reads a green `npm run test` as coverage. Exact
counts are left out on purpose — they go stale the week they are written and
they invite reading a number as a verdict.

`shared` is the best-covered project by a wide margin, and it is where most of
this workspace's real logic lives, so that is the right shape. `bracemark-api`
is next, exercising real D1/DO/R2 through the Workers pool (one of its specs is
the workerd portability suite). The two expo projects carry a working middle
layer.

`bracemark-extractor`'s suite is shaped by what that app is: the one component
that fetches arbitrary user-supplied URLs. So it sits on the **caps and the
guard** rather than on the happy path. The load-bearing half is per-hop SSRF
re-validation — `lib/safe-fetch.spec.ts` drives a public URL that 30x's into
private space, a relative `Location` after a cross-host hop, and the redirect
ceiling, none of which `ssrf.spec.ts` can reach because it only ever sees the
initial URL. Alongside it: each byte ceiling asserted at its own edge
(truncate for HTML, throw for an inline image, abort mid-stream for the proxy —
three different right answers), the CORS allow-list denying when its binding is
absent, the `/v1/image` exemption from the baseline rate-limit tier, and the
limiter's per-IP-per-path key, which is a **published** fact rather than an
internal (`/privacy` and `/extractor` both name `cf-connecting-ip`). What the
suite cannot check is the thing `wrangler.jsonc` decides — that no URL reaches a
log.

`bracemark-web` was the gap worth naming and no longer is. Its suite is shaped
by what only this app can lose, so most of the file tree has no spec on purpose —
the panes, the layouts and the section components are composition over hooks and
copy that other projects already pin. What it does cover:

- **The URL grammar, in both directions.** `links/_contexts/page-provider.spec.tsx`
  is the largest of them, because the view IS the URL (docs/search.md) and the
  parser and the serializer are two private functions in one file that nothing
  types against each other. The round-trip cases feed the serializer's output
  back through the parser, which is the property neither half can hold alone;
  the rest sit on the bare-name sugar, `?list=all` expressing NO list filter,
  the read-only `?sort` override, and the stale-selection bounce's
  positive-evidence guard.
- **The two exits nothing else can see.** `components/auth-guard.spec.tsx` pins
  the `?next=` composition, the installed-vs-browser-tab split (a standalone
  window that leaves manifest scope is gone for good), and 'ending' as a state
  to hold still in. `components/guest-guard.spec.tsx` pins the other half of the
  same param — the open-redirect rejection, which is the one value in this app a
  stranger can put into a navigation. Both mock `redirect()` as the throw it
  really is, so "protected content never paints" is asserted rather than assumed.
  Neither can stub `location`: it is `[LegacyUnforgeable]`, so the cross-origin
  exit is asserted as "a document navigation was attempted", not as its
  destination — the spec says so at its head.
- **The read edge's two silent jobs.** `links/_hooks/use-links.spec.tsx` asserts
  lock/trash suppression at the WIRE (what `readLinks` was handed, with the real
  `excludeLists`) rather than on the expression, and drives the staged repaint
  against a stand-in `useLiveQuery`. It keeps two render logs — attempts and
  COMMITS — because the promote-during-render rule is precisely the difference
  between them: promoting in an effect commits one frame that still reports
  `hasPending`, and that frame is the pill flashing on the user's own edit.
- **The state that sticks.** `links/_contexts/view-state-provider.spec.tsx` and
  `links/_layouts/shared/hooks.spec.tsx` cover the two ways `engaged` gets
  wedged — a count driven negative by a stray close, and an overlay that unmounts
  while open and never releases its increment. Both wedge the list closed for the
  life of the page with nothing on screen to point at.
- **`initial-sync-gate.spec.tsx`**, for the accessibility tripwire in both
  directions on one screen: the error MOUNTS so it announces (and the carrier is
  the wrapper, so the reassurance is announced too), while the count must NOT —
  it rides `aria-valuetext` and its visible copy is `aria-hidden`. Plus the
  no-flash pair, which is two one-frame bugs nobody catches by looking.
- **`app/robots.spec.ts` and `lib/links-return.spec.ts`**, the two small ones,
  both guards rather than getters: `ALLOW_INDEXING` required in BOTH directions
  (a truthiness check reads `"false"` as allow), and a sessionStorage value that
  goes straight into a `<Link href>` and so is validated on the way out.

`bracemark-site` is copy, and copy is not what a spec is for — most of that tree
has none on purpose. The two that exist sit on the same rule from opposite sides:
a string that CLAIMS something another file decides. `lib/plans.spec.ts` holds the
pricing copy to the entitlement table, and
`app/security/reporting-terms.spec.tsx` holds the disclosure windows — a
commitment made to a security researcher on four surfaces in three voices — to
`SECURITY_ACK_WINDOW` / `SECURITY_TRIAGE_WINDOW` in `lib/site.ts`. Two of those
four surfaces import the constants and cannot drift; the spec is there for
`SECURITY.md`, which is markdown and imports nothing, and it reads the two pages
as RENDERED text rather than as source so a prettier rewrap is not a failure.
Beside it, `app/.well-known/security.txt/route.spec.ts` pins the `Contact` and
`Policy` fields that decide where a report lands — the one spec in the site under
`@jest-environment node`, because a route handler returns a `Response` and jsdom
does not define one. Both are the derive-the-table-from-the-constants rule in
_what earns a spec_, applied to a file that cannot import them
([hosting.md](./hosting.md#wellknownsecuritytxt)).

`web-ui` was that gap too and no longer is. Its suite is shaped by the same rule
as `react`/`web-react` below rather than by a percentage — it covers the hooks
whose contract is a RE-RENDER rather than a value (the window-metrics store's
per-slice reference stability, `useMediaQuery`'s deliberately-blind `false`
seed, `useElementWidth` keying on the element and not a ref), the announced-error
carrier (`FieldError`'s `role="alert"`, the tripwire in
[accessibility.md](./accessibility.md)), the auth ceremony's gate
(`useNewPassword.ok` in both modes, including the username penalty term whose
absence let the same password pass at signup and fail at rotation), and the
picker rules no single call site can see (`ListCommand`'s six surfaces, each
opting in and out of a different row). Its `src/testing/jsdom-stubs.ts` supplies
only the APIs jsdom omits and cmdk/Radix reach for at mount — a spec that cares
about a MEASUREMENT installs its own controllable observer instead, because a
shared one that silently reports nothing is exactly what makes such a spec pass
while measuring nothing.

What `react` and `web-react` do have is deliberately shaped, and it is the model
to follow rather than a coverage percentage to chase. Both packages are mostly
seams — providers, query options, copy tables — and a spec that renders a
context and asserts `useContext` gives it back is testing React. So the specs
that exist there sit on the three things that fail SILENTLY:

- **A ladder's ordering.** `react`'s `lib/field-messages.spec.ts` pins the
  credential-field message ladders, whose interesting rungs live in windows a
  person cannot hold still — the ~400ms after a keystroke where the availability
  answer still describes the previous name, an aborted request, a zxcvbn chunk
  that never arrives. Every rung is reachable by hand; the ORDER between them is
  not. It also holds the one-line width budget, which is invisible on the
  desktop viewport those strings get written on and wraps on every phone.
- **A claim about another package.** `lib/paywall-copy.spec.ts` checks each
  upgrade gate against `@stxapps/shared`'s entitlement table: the plan a dialog
  sells must actually grant the feature, and the feature must actually be
  withheld from free. The two files typecheck independently, so the failure is a
  sale — the user pays and comes back to a locked feature.
- **A gate whose closed side nothing else exercises.** `web-react`'s
  `contexts/server-extraction-gate.spec.tsx` pins the one rule
  `ExtractionProvider` and `FaviconProvider` hold in duplicate: no URL leaves the
  browser unless the `serverExtraction` opt-in is on AND an extractor origin is
  configured. It asserts at the wire (did anything ask the extractor), not on the
  `enabled` expression, which would just restate the code. The null-extractor
  half has no other cover anywhere — every `bracemark-web` env file sets
  `NEXT_PUBLIC_EXTRACTOR_URL`, so no dev run, e2e run or deployed tier reaches
  it.

The corollary, and it is the more useful half: several files in those packages
have **no spec on purpose**. The two client-context providers are `createContext`
plus a guard; `use-auth-forms` is `useForm` with a zod resolver;
`use-sign-out-others` is one `api.call`; the copy modules other than the paywall
one are strings a `Record<Union, …>` already pins. Before adding a spec in this
layer, mutate the source and re-run — a gap is only real if the suite stays
green, and an assertion only earns its place if it then fails.

`bracemark-web`'s subscription spec is worth reading as a model of _which_ web
behaviour is worth this layer. It pins a two-line contradiction — a subscription
notice that outlives the status it described — by mocking the whole IAP edge and
driving the activation poll on fake timers, in about a second. The same
behaviour on the browser layer would need a real Paddle overlay and a real
webhook. Its native peer (`bracemark-expo`'s `subscription-section.spec.tsx`)
reaches the same state by the path that section actually offers, a restore
verdict rather than a poll — two specs, one rule, neither a port of the other.

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

#### the AVD

One emulator, `bracemark-pixel8` — a **Pixel 8** (1080×2400, 420 dpi) on the
`android-36.1` `google_apis_playstore` arm64-v8a image. Phone only; there is no
tablet AVD until something needs one.

The image choice is **disk, not preference**: that one was already downloaded
(2.3 GB), and any other API level or variant is a fresh 1.5–2.5 GB. `minSdkVersion`
is 33, so 36.1 is comfortably in range.

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

Six edits to `~/.android/avd/bracemark-pixel8.avd/config.ini` after creating it,
four for disk and two the defaults get wrong for e2e:

| key                         | default → set    | why                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------- |
| `disk.dataPartition.size`   | `10G` → `4G`     | the qcow2 grows into this cap                              |
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
toward 4 GB as the app writes and never past it. The cold-boot settings do hold
— the shutdown log says `Snapshots have been disabled by the user, save request
is ignored`, which is the ~2 GB that is _not_ on disk.

**A real iPhone is possible and is the highest-friction path.** It needs a dev
build signed with a profile carrying the device UDID, and WebDriverAgent
installed on the phone for tap and query — which needs its own signing.
Screenshots come through WDA, not simctl. Reserve it for what a simulator cannot
do honestly: the real iOS share sheet from another app, StoreKit sandbox, push,
real performance. See [share-sheet.md](./share-sheet.md) and
[expo-build.md](./expo-build.md).

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
