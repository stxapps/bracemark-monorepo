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
belongs to_, and of the spec layer itself — what earns a spec, jest vs vitest, the
shared plumbing, coverage. Two docs carry the rest of that second layer:
[app-drivers.md](./app-drivers.md) is the record of the **instruments** it uses —
which browser binary, the AVD, Maestro and why not Appium, and what each cannot do
— and [e2e.md](./e2e.md) is the record of how the **scripted suite** is built: the
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

**The same rule holds one layer down, where the shared value is a NAME and no
native suite can reach it.** The iOS share sheet's swipe hold is one chain across
JS, a Swift module, and an observer a config plugin writes into
`expo-share-extension`'s controller, and each link is a string: the module's
name, its function, a notification's name, a `userInfo` key, a class listed in
`expo-module.config.json`. A mismatch at any of them is not an error anywhere —
the lookup is optional and the post lands on nobody — so jest holds the strings
to each other instead, by reading the Swift as text and running the plugins for
real against the INSTALLED library's file
(`features/share/share-swipe-hold-wiring.spec.ts`, and the third case of
`share-swipe-guard.spec.tsx`). Running them against the installed file rather
than a fixture is the point: the anchors the plugins rewrite are upstream's
text, so a dependency bump that rewords them fails `npm run test`, not the next
prebuild. What that leaves is whether UIKit honours the flag, which is a device
question and `SHARE-IOS-003`'s ([e2e.md](./e2e.md)).

The typecheck+lint layer is easy to forget in a testing doc, but it is the one
that catches the largest class of mistake here: `@nx/enforce-module-boundaries` turns
an illegal cross-package import into a lint failure rather than a silent
runtime surprise. See [architecture.md](./architecture.md).

**Nothing runs automatically.** There is no CI workflow in this repo yet, and
the only git hook (`tools/git-hooks/pre-commit`) guards `internal/`, not tests.
`npm run test` is a thing you run.

### deployed release qualification

The staging E2E targets exercise AWS/Cloudflare services and optimized client
builds alongside the local suite. Browser CSP/CORS checks require actual deployed
headers and enforcement; native Release tests verify the installed binary against
a build receipt. This is still the whole-flow layer and stays outside
`npm run test`. Runner integrity checks use `npx nx check:runner @stxapps/e2e`
(Node's test runner, no Jest config); `check:headers` reads a tier's deployed
security headers, production included. Design and exclusions:
[e2e.md](./e2e.md#deployed-staging-and-mobile-release-builds); commands:
[e2e/STAGING.md](../e2e/STAGING.md). Store, biometric and real-iPhone checks retain
their manual release qualification.

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

**A mutation that changes nothing is the other half of that check**, and it
usually means the assertion's PATH never ran rather than that the assertion is
worthless. The specimen: jsdom ships no `TextDecoder`, and the SVG half of the
icon sniff decodes text (`@stxapps/shared` image/sniff.ts) — so under
`@jest-environment jsdom` `isRenderableIconBytes` throws, `FaviconProvider`'s
catch records `none` for everything, and a spec asserting `none` for a non-icon
passes through the FAILURE path while asserting nothing about the verdict.
Inverting the verdict in the source left it green, which is how it was found; the
fix is one assignment from `node:util` at the top of the spec.

**A cluster of negative assertions needs one positive control**, which is the
same failure arriving by a different route: `not.toHaveBeenCalled()` is
satisfied just as well by a provider that never reached the call at all.
`expo-react`'s `contexts/favicon-provider.spec.tsx` had three cases asserting
that a dropped host writes no `none` row, and deleting BOTH store writes from
the drain left the file green — a provider that fetched every host correctly
and then stored nothing passed every one of them. A single case pinning the
write that SHOULD happen fails that mutation. Generally: where a spec's subject
is "X does not happen under condition C", something in the file has to pin that
X happens without C, or the whole cluster is measuring an absent path.

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

#### tripwire: an update that lands after `act()` returns

_"An update to X inside a test was not wrapped in act(...)"_ is a `console.error`,
not a failure. The spec stays green, and because it is often a race, a rerun can
come out clean. Two shapes have produced it here:

- **A synchronous `act()` around an event that starts async work.** Web's
  `contexts/auth-provider.spec.tsx`, _asks again on return to the foreground_,
  dispatched `visibilitychange` inside `act(() => …)`. The provider answers that
  event twice: it probes, and it re-reads the session record under the lifecycle
  lock. The re-read's `adopt` lands in microtasks after the synchronous `act`
  has returned, so it warned on every run, even though the spec only asserted
  the probe. If the event under test starts async work, use
  `await act(async () => …)`, even when the assertion does not care about that
  work.
- **A TanStack hook's own state.** `notifyManager` delivers every
  query/mutation observer update on a `setTimeout(0)`. React 19's async `act`
  waits only one `setImmediate` after its callback settles, and node orders those
  two by timing. So `await act(() => result.current.mutateAsync())` can return
  with the hook still reporting `idle`, and the `pending`/`success` renders land
  outside `act` only some of the time. This hit the `use-sign-out` and
  `use-delete-account` specs in both packages. Resolving the promise is not the
  same as the hook settling, so wait for the settled state:
  `await waitFor(() => expect(result.current.isSuccess).toBe(true))` (or
  `isError`). RTL's and RNTL's `waitFor` switch the act environment off while
  they poll, so the late render is expected there. Don't reach for
  `notifyManager.setNotifyFunction(act)` as a global fix: it would call `act`
  inside those same `waitFor`s, where the act environment is off.

**The Nx cache makes a race look permanent.** A warning captured once is
replayed on every `npm run test` until that project's inputs change. So "it
warns every time" says nothing about whether the warning is deterministic, and
one clean `--skip-nx-cache` run does not prove it gone. To find the leak, don't
rely on a single run:

- Pass a scratch `--setupFilesAfterEnv` file that wraps `console.error` and
  prints `expect.getState().currentTestName` whenever the first argument contains
  `not wrapped in act`. Match on the raw argument: React sends a format string
  (`An update to %s …`), so the component's name is in the second argument.
- Run the suspect specs a dozen times concurrently.
- To force the TanStack ordering, run a scratch copy of the spec that calls
  `notifyManager.setScheduler((cb) => setTimeout(cb, 5))`.
- Put the scratch setup file under `node_modules/` rather than `/tmp`.
  `jest-expo`'s babel transform rewrites a file outside the repo into requires of
  `@babel/runtime` that it cannot resolve from there, and `node_modules/` is not
  transformed at all.

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

### the two things outside the two runners

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

`tools/scripts/check-service-worker.mjs` is the second, for a different reason: it IS
executed, by every bracemark-web deploy, but its job is to catch a failure that is
silent everywhere else ([offline-mode.md](./offline-mode.md), _`/sw.js` is
permanent_), so the way it fails silently — reading part of the precache manifest
and passing — needs pinning too. `check-service-worker.test.mjs` beside it, same runner:

```bash
npm run test:check-service-worker
```

Each refusal there has a passing control built from the same fixture, and the
deployed half runs against a node server standing in for the CDN — which is the
one thing it cannot be, and why the real check runs against the real host.

**Lint does reach them, by a script rather than a target.** `tools/` and the
root-level config files (`eslint.config.mjs`, the `jest.*` files) belong to no Nx
project, so no `lint` target covers them and for a long time nothing did: a
restricted import and two straight apostrophes sat in `tools/scripts/` with lint
green. `npm run lint:root` is ESLint over exactly those files, and `npm run lint`
and `npm run lint:fix` run it after the Nx targets. The scoped forms do **not** —
`npx nx lint <project>` and `npx nx affected -t lint` never see a file outside a
project — so after an edit under `tools/`, run `npm run lint:root`.

For the CloudFront function, node is not the runtime it will execute in, and this
is the rare case where that gap is not fixable from inside the repo: `cloudfront-js-2.0` is ES 5.1 plus a subset of
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
  (docs/expo-dependencies.md, _runtime polyfills_).

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
  hazards, the commit phase order, the first-sync counter, the quota gate, what
  the cursor may claim, the upload-time `writeId` test — all of it is asserted
  there, in the app that has the most surfaces riding on it. So is the one thing
  only web has: two tabs over one queue, and the lock between them.
- **expo's `engine.spec.ts` covers the half web has no equivalent of**: `files/`
  content lives DECRYPTED ON DISK there, not as bytes in the row, so every
  content flow is a two-store write and the two stores can disagree silently.
  The load-bearing case is the asymmetry — a pull tears down the plaintext only
  for the rows it actually re-stored, because a path the local-wins guard spared
  still has a queued op whose upload reads that file.
  It also carries the cases where expo has no lock to lean on: web keeps a
  cycle and the first sync apart with `withCycleLock`, expo by declining the
  cycle and by giving the pull a slot of its own, and only expo's own spec can
  see either go ([local-first-sync.md](./local-first-sync.md), _two tabs, one
  queue_).
- **the drift guards are the exception to "once".** The engines are duplicated
  _source_, so a spec that passes on web's copy proves nothing about expo's:
  edit expo's phase order, its self-heal, where it writes its cursor, its
  upload-time check or its first sync's retry and nothing in the workspace
  fails. One case each, not the full web matrix.

The store layer splits the same way: `expo-react`'s `data/item-store.spec.ts`
pins the guarded writes' SQL rather than restating what they mean.

**Two groups of web's cases need more than the file's stub**, and both have an
edge worth knowing before adding to them.

- **The cursor cases run against a server model** (`SyncServer`, in the spec):
  a keyset pull with its retained bounds, the commit clamp, and a listing that
  pages in key order and reads the bucket as it stands at each call. A cursor
  is a statement about the SERVER's ordering, so a stub that answers every pull
  alike cannot show an op being skipped — the engine that lost links between two
  devices passes every such case against one. The rest of the file keeps the
  plain stub on purpose: a mid-cycle write needs one thing injected at one
  moment, not a second implementation of the protocol to keep honest.
- **The two-tab cases load the engine twice** (`jest.isolateModules`) over the
  one fake-indexeddb, with node's real `navigator.locks` between the copies.
  The describe opens by expecting that API to exist, so a node without it fails
  by name instead of passing unlocked. ⚠ What the second registry gives you is
  a second copy of every REAL module — its own single-flight slot, its own
  database connection — and the **same instance of a factory mock**:
  `require('./r2')` inside `isolateModules` returns the very `jest.fn()`s the
  file's top-level import holds. So "tab B's `getBlob`" is tab A's as well, and
  `expect(tabB.r2.getBlob).not.toHaveBeenCalled()` counts both tabs' transfers —
  it failed on a correct engine, which is how this was found; the opposite
  assertion would have passed on a broken one. Tell the tabs apart by what each
  one ASKED for: every tab gets its own api stub, and that stub records its
  calls.

**The export/import orchestrators are the second ported pair**, and they split by
the same rule. `data/export-import.spec.ts` exists in both packages: web's is
canonical for the POLICY matrix (Trash in the backup and out of every interop
file, the locked-list exclusion in all four of its dimensions, the interop
dedupe, the provisional title), and expo's covers only what this platform can
lose on its own — a different zip library, `files/` content living decrypted on
DISK rather than in the row, and the zip32 ceilings fflate range-checks neither —
plus one drift-guard case for the two policies and one for the backup reader's
file-ref gate, because the orchestrators are duplicated source. Both drive a
REAL archive end to end, which is the property
neither `shared`'s serializers nor its parsers can hold: those are tested with
hand-written strings that agree by construction.

The third claim in that pair is one **neither package can make**: that each reads
what the OTHER wrote. The module boundary forbids a spec that imports both, so it
is carried by two checked-in golden archives (one per container) plus a JSON
sidecar under `packages/shared/src/data/__fixtures__`, generated by
`tools/scripts/generate-backup-fixtures.ts`, read by both platforms' specs, and
held to `BRACEMARK_BACKUP_VERSION` by `data/backup-fixtures.spec.ts` — the same
artifact-as-contract shape as `contract-vectors.json` above, one layer up. See
[data-lifecycle.md](./data-lifecycle.md), _the bracemark zip is platform-split_.

Two things about those archives are **silent** if you get them wrong, so they are
written down here rather than left to a reviewer.

**⚠ The zips are committed, and a personal `*.zip` ignore rule hides them.** Their
whole value is that they are bytes written by an OLDER build: regenerate them in
CI instead of committing them and every assertion becomes a tautology — the
generator and the readers move together, `contents.version` equals
`BRACEMARK_BACKUP_VERSION` by construction, and a container quirk introduced by a
zip.js or fflate upgrade can no longer be seen at all. But `*.zip` is a common
line in a personal `core.excludesFile` (`~/.gitignore_global`), and `git add`
skips an ignored file **in silence** — no error, no untracked entry, nothing in
`git status`. The commit then lands with the sidecar and without the archives,
and the first sign of it is two suites failing on someone else's clone. A
`.gitignore` in the repo outranks the global file, so the fix is the anchored
negation at the bottom of ours: `!/packages/shared/src/data/__fixtures__/*.zip`.
Any future committed binary fixture needs the same line, and `git status
--untracked-files=all` on the fixture directory is how you check.

**The specs address them through the package, not through `../..`.**
`@stxapps/shared/testing` (`src/testing/backup-fixtures.ts`) exports the
directory, the two archive names as a union type, a reader and the sidecar's
shape; all three suites go through it. The earlier spelling —
`join(__dirname, '..', '..', '..', 'shared', 'src', 'data', '__fixtures__')` in
each platform spec — crossed a package boundary as a string, where neither
`@nx/enforce-module-boundaries` (it reads imports) nor the typechecker nor the
module graph can see it. That module is **spec-only**, which is a portability
line rather than tidiness: it reads `node:fs` and `__dirname`, and `shared` is
`platform:agnostic`. It stays out of the shipped program on three counts —
excluded from `tsconfig.lib.json`, exempt from the `agnostic-globals` deny list
(the exemption `src/testing/**` earns alongside specs), and reachable only via
the `./testing` subpath export, never from the barrel every app bundles. The same
split `expo-react/src/testing` already draws; put spec-only support there, not in
a `*.ts` beside the source.

Both expo suites run the real modules over shimmed native seams, which is what
makes that possible — `src/testing/node-sqlite.ts` puts the real DDL and the
real drizzle driver on `node:sqlite`, and `src/testing/memory-file-system.ts`
puts the real `data/file-store.ts` on an in-memory filesystem. Two
strictnesses in that shim are deliberate, because both catch real bugs: a
`delete()` of something absent throws, as the native API does, and so does a
write into a directory nobody created. It stores **bytes**, and used to store
strings — the sync plane never looks at a `files/` payload (it moves
path-to-path through native crypto), but the backup reads those bytes into a zip
and writes the zip itself to a cache file, and a lossy text hop would corrupt a
PNG or a deflate stream with every assertion above it still green.
`readFileText`/`writeFileText` are now the UTF-8 views onto the same map.

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

#### specs mount under StrictMode

**Every `@testing-library/react` render in the six web projects mounts under
`<StrictMode>`** — `react`, `web-ui`, `web-react`, `bracemark-web`,
`bracemark-site` and `bracemark-extension` each list
`jest.react-strict-mode.cjs` in `setupFilesAfterEnv`, which sets RTL's
`reactStrictMode`. It is there because the surfaces themselves run that way:
Next's app router turns StrictMode on in `next dev`, and the browser extension's
popup and options roots wrap themselves in it. StrictMode renders twice and runs
every effect mount → cleanup → mount **on the same refs and the same module
state**, so a cleanup that leaves something the second mount can't start from
breaks the page in dev while a single-mount spec stays green. Two specimens, both
found this way:

- `bracemark-web`'s subscription section kept an "unmounted" ref that only its
  cleanup ever wrote. After StrictMode's first cleanup it read true for the
  section's whole life, so the post-checkout poll bailed after one request
  without clearing `busy`: the plan flipped to Plus under a "Finishing your
  upgrade…" that never went away, with every button disabled. Four of that
  spec's cases fail against it now; none did before the switch.
- Both `use-import-all-data` hooks treated the last view's cleanup as the user
  leaving, which StrictMode's simulated unmount also is — so a finished import's
  receipt was dropped before the re-mount could show it. The decision now waits
  a microtask, by which time a StrictMode re-mount has already counted itself.

The switch costs one discipline in specs: **don't count renders, mount effects or
mount-time calls from zero.** Each happens twice in dev by design. Pin the
property instead — counted from after the mount (`const mounted = fn.mock.calls
.length`), as a set rather than a sequence, or every-listener-added-was-removed —
which is what the counts were standing in for anyway. And a mock that fails ONCE
(`mockRejectedValueOnce`) now fails only the first of two hydrations; make it fail
every call, as the real failure would.

The expo projects render through `@testing-library/react-native`, which has no
such switch, and `jest.preset.js` is shared with them — hence per-project
`setupFilesAfterEnv` rather than the preset.

`watchman: false` appears in two places on purpose. Watchman's watch root here
is the whole monorepo, so every run made each project `syncToNow` over the full
tree; once the fsevents queue overflows, that sync never lands and jest burns
its full 60s timeout before falling back to the node crawler anyway. The crawl
is ~1s per package. Do **not** "fix" this by adding `node_modules` to
`.watchmanconfig`'s `ignore_dirs` — Metro needs the symlinked `@stxapps/*`
packages watched for expo HMR.

#### the watch root and `.watchmanconfig`

There is **one** `.watchmanconfig`, at the workspace root, and that is the only
place it can be. Metro asks watchman to `watch-project` its own project root
plus each `watchFolders` entry `withNxMetro` adds, and `watch-project` resolves
every one of those to the **nearest** enclosing directory holding a root file
(`.watchmanconfig`, `.git`, `.hg`, `.svn`) — which is this root, via `.git`,
whichever directory you launched from. `npm run expo:ios` here and `npm run ios`
from `apps/bracemark-expo` therefore produce the same single watch; the shell's
cwd never enters into it.

So the file is not what anchors the root — `.git` already does that. It exists
to carry the ignore list, and that is why a second copy under
`apps/bracemark-expo` would be a regression rather than a no-op: watchman would
resolve the app directory as its own watch root, splitting the watch in two, and
`ignore_dirs` paths are relative to the watch root, so every entry the root file
holds for `apps/bracemark-expo/**` would **silently stop applying**.

What belongs in `ignore_dirs` is anything gitignored that nothing here resolves
through — build output (`.next`, `dist`, `out`, `out-tsc`, `.output`/`.wxt`,
`.wrangler`, `ios/Pods`, `android/build`), the e2e artifacts, and the private
root folder, whose nested `.git` the root's own `ignore_vcs` does not reach.
The point is not the file count, which those barely move:
`node_modules` is the bulk of the map and can never be ignored (above). It is
that a build writing thousands of files while Metro watches is what overflows
the fsevents queue, and that overflow is what produces `MustScanSubDirs
UserDropped` and a full recrawl — a few seconds, and harmless on its own. Add a
project's output directory in the same change that first creates it — nothing
fails if you forget, the watch just gains one more storm source, and the list
had drifted a whole app behind before anyone noticed.

**Never set `fsevents_try_resync`.** It sounds like the cheaper path — on an
overflow, rebuild the fsevents stream from the journal instead of recrawling —
but on this machine the resync has never once succeeded (`Failed to rebuild
fsevent stream (fsevents journal UUID is different) while trying to resync,
falling back to a regular recrawl`), and that fallback leaves the watch with a
dead stream: the recrawl completes, no event is ever delivered again, and every
`syncToNow` times out until the root is re-watched. Nothing reports it except
Metro's 60-second warning. The watchman log (`watchman get-log`) settles it: the
flag was on from the first commit, and every wedged watch it records began
within a minute of that fallback, while more than a hundred plain overflow
recrawls, in repos without the flag, recovered on their own.

**An edit to `.watchmanconfig` does nothing until the root is re-watched.** The
config is read when the watch is established, so a running daemon keeps the old
list indefinitely — and every clone of this repo is a separate watch root that
needs it separately:

```sh
ROOT=$(git rev-parse --show-toplevel)
watchman watch-del "$ROOT" ; watchman watch-project "$ROOT"
```

Those same two lines are the recovery once a watch is already wedged;
`.claude/skills/verify/SKILL.md` carries the symptom as it appears in Metro's
log, and the reason a stale bundle survives `expo start --clear`.

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

`shared`'s import/export suites gained the half a hand-written fixture cannot
give them: `import/brace-export.spec.ts` runs one REAL Brace.to export — 15
entries of a live account's file, trimmed and anonymized, in
`import/__fixtures__` — end to end through `parseImportText`, detection
included. `brace.spec.ts` beside it still covers the rules one at a time, and
that is the right shape for rules; what it cannot cover is the assumption a
hand-written fixture is BUILT from, since the same person wrote the fixture and
the parser. The real file carries shapes nobody would have invented — a settings
filename with a doubled timestamp, a three-level `listNameMap` whose `Trash`
entry has no `children` key, `sslts`/`pins`/`tags` payloads that are `{}` because
the PATH is the data, `cdroot/`-prefixed image keys. Its assertions are
RELATIONS (every parsed URL is one the file declares as a link; no folder segment
is an unresolved id) rather than a table of values, so trimming the fixture
further doesn't invalidate them. Deleting the structural probe in `detect.ts`
takes the whole file down, which is the point: that probe is what stands between
this format and the URL regex mining raw JSON.

#### import specimens

The same argument generalizes, and `import/netscape-exports.spec.ts` is where it
landed for the format most producers write: eight REAL exports —
Chromium, Firefox, IE 11, Safari, Google Bookmarks, Delicious and two Shaarli
files — in `import/__fixtures__/netscape`, vendored from
[shaarli/netscape-bookmark-parser](https://github.com/shaarli/netscape-bookmark-parser)
(MIT; the notice and the per-file provenance are in that directory's README).

**Verbatim is the whole property**, and it is enforced only by convention plus
one line: `.prettierignore` excludes the directory, because a repo-wide format
run would reindent the tag soup that IS the subject — the unclosed `<DT>`s, the
valueless `FOLDED` attribute, the indentation inside a `<DD>` — and leave
specimens that describe OUR html rather than a browser's. Trimming or
anonymizing one has the same effect more quietly: it makes the file agree with
our parser by construction, which is the exact property `netscape.spec.ts`'s
hand-written fragments already have and these exist to escape.

What they were worth, on the day they landed — every item below was invisible to
a suite that had only fragments in it, and two were live bugs:

- Firefox writes an **empty `<DD>` for every bookmark**, so "has a description"
  is not "has a `<DD>`" — a note-per-`<DD>` reading would have put an empty note
  on two rows in three.
- Firefox `place:` rows (its saved queries — Most Visited, Recently Bookmarked)
  are not links; three of them sit in a 24-anchor file.
- Google Bookmarks writes **16-digit microsecond** `ADD_DATE`s. Read as seconds
  they land ~50 million years out, and nothing errors.
- Safari writes **no dates at all**, no root `<DL>`, and `<H3 FOLDED>` — an
  attribute with no value, which is what an attribute scanner runs off the end
  of.
- Chrome buries a base64 favicon in the same tag as the `HREF`, an order of
  magnitude bigger than everything else in the row.
- **A Shaarli `<DD>` can contain an `<a>`** — a thumbnail pointing at the user's
  own local instance. It was being imported as a bookmark: a dead
  `localhost:8083` row per illustrated link.
- **Descriptions are multi-line.** They are markdown lists and paragraphs, so the
  whitespace collapse that is right for a title is wrong here; `descriptionText`
  keeps the line breaks and the relative indent and drops only the export's own.

The standing rule this leaves: **a specimen comes from the producer, or there is
no specimen.** A fixture composed from what we believe a format looks like is a
hand-written fixture wearing a badge that says otherwise — worse than none,
because the next reader trusts it. Pocket's CSV is covered by rule cases in
`csv.spec.ts` (including the `cursor` column variant that
[go-shiori/shiori](https://github.com/go-shiori/shiori)'s testdata pins) and is
still waiting on a real export.

Raindrop's is no longer waiting. `import/raindrop-exports.spec.ts` runs one real
library exported **both** ways — HTML and CSV, from a throwaway account filled
for coverage — kept verbatim in `import/__fixtures__/raindrop` (and
`.prettierignore`d, like the browsers'). A pair buys the one claim no single file
can make: two descriptions of one library must import to the same rows, so
every Raindrop-ism that differs between them — `&quot;` against `""`, `a,b`
against `a, b`, a `<DD>` against a quoted cell — is held by one relation instead
of a case each, and the single place they _can't_ agree (a collection name
containing the CSV's `/` separator) is pinned as the only one. What it taught
that no rule case had:

- **A renamed title is indistinguishable from a fetched one** in both files — so
  every interop title now lands as `customTitle`
  ([data-lifecycle.md](./data-lifecycle.md), _importing from Raindrop.io_).
- **Highlights are extra `<DD>`s**, one `<blockquote>` each, after the note. The
  first `<DD>` used to win: highlights vanished, and on a link with no note the
  first highlight became the note.
- **The CSV's nested-path separator is padded and unescaped** — `a / b`, never
  `a/b` as Raindrop's import docs say — so a collection named `AEO/GEO` was split
  into two lists.
- **Unsorted is a folder in both files**, and **Trash is in neither.**

Replacing it means exporting again and replacing both files, since the pair is
the point.

LinkWarden's IOU is paid. `import/linkwarden-export.spec.ts` runs one real
`backup.json` — a hosted instance, exported 2026-09-13, kept whole at 11
collections / 25 links / 3 pins — against `__fixtures__/linkwarden-export.json`.
Until it landed, `import/linkwarden.spec.ts` opened by saying there was no
specimen and naming what stood in for one: LinkWarden's export controller
(`exportData.ts`, the user's Prisma row minus the password and the user's id)
plus two second-hand readings of it. That footing held the shape and got two
rules wrong, both of which had been written down here and in
[data-lifecycle.md](./data-lifecycle.md) as if settled:

- **`createdAt` is the wrong date.** It is when LinkWarden minted the row, so a
  library that arrived by import carries the minute of the import run — two
  distinct values across all 25 rows — while `importDate` holds when each link
  was actually saved. The wrong reading produces 25 correctly-filed, correctly
  titled, correctly dated-looking links, all from the day the user switched apps.
- **A title arrives HTML-escaped**, because LinkWarden stores its `<title>`
  scrape undecoded. The control is inside a single row: `name` reads
  `Marketing &amp; Technology` where that row's `metaDescription` — same page,
  same scrape — has a bare `&`. No hand-written JSON fixture would have had an
  entity in it, because JSON doesn't need one.
- **The archived copies are in the file** (on the pinned rows, as server-side
  paths), which both docs denied. No bytes are, though — and that is now
  attested rather than assumed: the account uploaded a custom image and
  re-exported, and the image appears nowhere in the JSON.

The specimen is anonymized, which the netscape fixtures' rule forbids for a
reason — so the rule it is held to instead is written in its spec header: every
substitution preserves the property the original carried (the `&amp;` and its
bare-`&` control, an unbalanced U+202D, Thai script, an embedded `"`, empty query
values, a `www.` host beside its bare twin, the exact duplicate rows). What is
verbatim: key order, every id and `parentId`, every timestamp, the collection and
tag names. What is replaced: URLs, titles, scraped descriptions, and the four
account scalars that identify a person.

Rules still live in `linkwarden.spec.ts`, one per hand-written case — a fixture
can be shaped to reach an edge, and a real library can't. Replacing the specimen
means exporting again from an instance and re-anonymizing by the same rule.

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
- **The one rule the canonical copy can't hold for itself.**
  `links/_components/bulk-tags-dialog.spec.tsx` is a drift guard on a ported
  pair (_the ported pair_ above), not a second copy of the protocol:
  `bulk-tags-dialog.tsx` is duplicated source, and bracemark-expo's twin spec is
  canonical for the diff semantics — the seed, the per-link patch, the pending
  save, the unchanged link that gets no write. The two cases here are the
  intersection seed and the per-link diff, because the obvious simplification on
  this side (`links.map((link) => ({ link, patch: { tagIds } }))`) lints,
  typechecks and passes every expo case while stripping the tags only SOME of
  the selected links carried — which the dialog never showed as selected, so the
  user cannot know to restore them. Both halves were checked by mutating the
  source. It does NOT cover a rejected write: the silence is a decision
  (docs/editors.md) and the shape that carries it — an async handler whose
  promise nothing awaits — is one jest-circus turns into a failed test, so
  neither platform's spec can assert it.
- **A create that is also a move.** "Move to" can file into a list that does
  not exist yet (docs/editors.md, _"Move to" creates inline_), and the pairing
  lives in two places in the app that web-ui's picker specs cannot reach:
  `links/_components/link-move-surface.spec.tsx` for the page-level dialog and
  sheet, `links/_layouts/shared/link-row-menu.spec.tsx` for the row menu's wide
  submenu. Both pin the same two failures — a create with no move behind it
  closes over a new, empty list with every link where it was, and a create that
  comes back empty must move nothing — and the second adds two only that host
  has: the submenu must close itself (a CommandItem pick is not a menu
  selection, so Radix closes nothing and `engaged` stays held), and it must hold
  no live list read until it opens, since the menu renders once per virtualized
  row. That last case carries its own control, per _a cluster of negative
  assertions_ above. bracemark-expo's `features/links/move-to-dialog.spec.tsx`
  is the native half: one dialog, reporting a created list through the same
  `onSelect` a picked row uses. It also holds the one thing a barrel mock erases.
  A native dialog's content renders in the root `PortalHost`, above the `(app)`
  layout's `SyncProvider`, and an @rn-primitives portal carries no context — so
  a hook that reaches `useSync` throws there on open, while a spec that mocks
  `@stxapps/expo-react` whole stays green. The mock therefore hands out the list
  mutations only under a stand-in provider, and the spec mounts the `PortalHost`
  outside it, where the app has it. All were checked by mutating the source.
  None of them pins WHERE the new list lands — the hosts hand
  `useListMutations().createTopLevel` a name and nothing else — so that is
  `hooks/use-list-mutations.spec.tsx`'s, in `web-react` and `expo-react`:
  top-level, ahead of the root group's head as the tree renders it (a list whose
  parent is gone or is Trash sits at the root and can be that head), read at
  call time rather than captured at render.
- **`app/robots.spec.ts` and `lib/links-return.spec.ts`**, the two small ones,
  both guards rather than getters: `ALLOW_INDEXING` required in BOTH directions
  (a truthiness check reads `"false"` as allow), and a sessionStorage value that
  goes straight into a `<Link href>` and so is validated on the way out.
- **`app/inner-layout.spec.tsx`** holds the saved links view to its account:
  sign-out, revocation, or account replacement clears it even after routed content
  unmounts, while reload hydration and route changes preserve it. The spec renders
  the layout so it reaches the cleanup in `Initializer`, where the app mounts it.

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
- **A policy no row and no lint rule can report.** `web-react`'s
  `contexts/favicon-provider.spec.tsx` pins what SURROUNDS the favicon fetch —
  one fetch per host (the economics an icon-per-site rests on), a bounded
  fan-out, and the drain's switch-off guard. That last one is the queue's
  privacy TAIL, and the gate spec above cannot reach it: it proves nothing
  STARTS through a closed gate, not that a queue already draining stops. Its
  expo sibling covers the divergence, on the ported-pair rule below — expo's
  guard carries a gestured exemption (`!gestured &&`) web has no equivalent of,
  and on the DEFAULT mode that branch is not a race but steady state, since a
  share of more than `MAX_IN_FLIGHT` links queues gestured hosts whose drain
  reads an `enabled` that stays false. Neither file hardcodes the cap or the
  stagger; the first burst's size is read off the run, which is also what stops
  "nothing more went out" from passing against a provider that simply stopped
  pumping. Writing them also surfaced a hazard in the SOURCE, and it generalized
  to every provider here that resets on account change: a child's effect runs
  BEFORE its parent's, so a reset keyed on `[username]` alone — which also fires
  on mount — wiped anything asked inside the provider's own first commit. Both
  favicon providers and both file-content ones now compare the account their
  session memory belongs to rather than resetting on every mount (web's
  `file-content-provider.tsx` carries the reasoning, including why a first-run
  flag is not the fix: bracemark-web runs under StrictMode, whose double mount
  spends the flag on the first pass and wipes on the second). The specs still
  mount their askers a commit later, because that is the order the app has.

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
