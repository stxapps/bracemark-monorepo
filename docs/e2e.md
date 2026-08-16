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
  .artifacts/             gitignored — traces, reports, run manifests, profiles
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
  via `launchApp` for exactly that reason.

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

Three repo-specific gotchas:

- **`launchApp` resumes, it does not cold-start.** Every flow that assumes a root
  screen needs `clearState: true`, or it passes alone and fails in a directory run
  because the previous flow left the app deep in a navigation stack. That failure
  looks exactly like Maestro's batch-mode driver bug and is not one.
- **Android needs `adb reverse tcp:8787 tcp:8787`** (and `8788` for the
  extractor). Both `.env.development` files point at `http://localhost:8787` and
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

Contract legs live in `mobile/contract/`, outside the `mobile/flows/` glob, because
a parameterised leg run without its `-e` values fails on unset variables rather
than on anything meaningful.

#### the testID contract — not yet in the app

The mobile flows are written and their YAML parses, but **they cannot run until
four `testID`s exist**, because the screens they drive currently have nothing
stable to bind to:

| testID             | where                                           |
| ------------------ | ----------------------------------------------- |
| `sign-in-username` | `src/features/auth/sign-in-form.tsx`            |
| `sign-in-password` | `src/features/auth/sign-in-form.tsx`            |
| `sign-in-submit`   | `src/features/auth/sign-in-form.tsx`            |
| `links-screen`     | `src/app/(app)/links/index.tsx` (a root marker) |

`add-link-url` and `add-link-save` are the same story in
`src/features/links/link-add-screen.tsx`, though its URL field already carries
`aria-label="URL"`.

**The sign-in fields are an accessibility defect too, not only a selector gap.**
They are `Input`s whose only label is a visually adjacent `<Text>`, with no
`aria-label` and no association — so VoiceOver announces an unnamed text field.
That is the same class of miss [accessibility.md](./accessibility.md) exists to
catch, and it is why "an unlabelled control is untestable as well as inaccessible"
is the framing above rather than a slogan.

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

The mobile and contract targets additionally need a **bracemark-expo dev build
already installed on a booted simulator or emulator**. Nothing here builds the
app — see [expo-build.md](./expo-build.md).

Failures leave a trace: `npx nx e2e-web:report @stxapps/e2e`, or
`npx playwright show-trace e2e/.artifacts/test-results/<test>/trace.zip`. A run
also writes its throwaway credentials to `e2e/.artifacts/*.json`, so the account a
failed run left behind can be signed into and looked at.

Local api state lives in `apps/bracemark-api/.wrangler/`. Nothing resets it, on
purpose: a throwaway account per worker is cheaper and less brittle than clearing
that directory, and it means two runs never contend for the same rows.

### state today

| surface  | status                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| web      | **5 specs, passing** — account (reload, sign-out), links, lists              |
| native   | 3 flows written, YAML validated, **not yet executed** — no dev build, no AVD |
| contract | both runners written, **not yet executed** — same reason                     |

The honest reading of that table: the web half is real, and the native and
contract halves are scaffolding whose first real run will find things. The
contract runs are the highest-value part of this doc and the least proven part of
the code — that gap is the next thing to close, and it needs an installed dev
build before anything else.

Nothing here runs automatically. There is still no CI ([testing.md](./testing.md)),
and the only git hook guards `internal/`.
