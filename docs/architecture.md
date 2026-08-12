## architecture

Living reference for how the workspace is organized: what each app and package
is, the dependency rules between them and how they're enforced, which manifest
declares which dependency version, and how the source is resolved and bundled.

**This file is not the doc index.** The routing table — which of the ~20 files
in `docs/` covers which subject — lives in the workspace `CLAUDE.md`, so it sits
in context from the start of a session instead of at the top of a long file you
have to already be reading. Sections below link to their neighbours directly;
the ones that come up most from here are [setup.md](./setup.md) (the one-time
scaffold commands), [expo-native-deps.md](./expo-native-deps.md) and
[expo-build.md](./expo-build.md) (how bracemark-expo's dependencies are wired, and
how it's built), and [hosting.md](./hosting.md) (which host each app answers).

### apps

**Naming — never write "extension" bare.** Two unrelated things here are
extensions: the **browser extension** (`bracemark-extension`, wxt —
[browser-extension.md](./browser-extension.md)) and the iOS **share extension**
(a target inside `bracemark-expo` — [share-sheet.md](./share-sheet.md)). Qualify
which one on first mention; bare "extension" is fine afterwards inside a doc
that only discusses one of them (share-sheet.md does exactly this). Say
**"browser extension"**, never "web extension" — `web` is already taken by
bracemark-web, the `web-*` packages, and `platform:web` (which covers
bracemark-extension too), and `web/extension` is established shorthand for bracemark-web
_vs._ bracemark-extension.

**Naming — `bracemark-web` and `bracemark-site` are different properties, not two
words for the same one.** `web` / `expo` / `extension` sit on the **platform**
axis: three builds of one product, the thing a signed-in user works in.
`bracemark-site` is not on that axis at all — it is the public `bracemark.com`
property (landing, docs, blog, legal), which nobody signs into. In prose, write
**"the marketing site"** on first mention; "the site" is fine afterwards inside a
passage that only discusses one of them. The split is enforced by more than
convention: the site has no auth stack, no data layer, and its own origin (see
[hosting.md](./hosting.md#the-hosts) — _the hosts_).

- **bracemark-web** — Next.js web app, served at `app.bracemark.com`. Its `/`
  is a bare redirect (`/links` or `/sign-in`, whichever the session says); the
  public landing that used to live there is now bracemark-site's. Traffic goes
  the other way too: a deliberate sign-out (and account deletion) leaves this
  origin for the apex landing page, since what's left after the session ends is
  a marketing surface, not an app one (`AuthGuard`, `NEXT_PUBLIC_SITE_URL`) —
  **except from an installed PWA**, whose manifest scope is `/` on `app.*`.
  Leaving the origin from a standalone window doesn't navigate the window, it
  hands the user to the platform's in-app browser and strands them outside the
  app; a site → app bounce can't undo that, so an installed sign-out stays here
  on `/sign-in` (`AuthGuard`'s `isInstalled`).
- **bracemark-site** — Next.js marketing site, served at the apex
  `bracemark.com`: the landing page, `/pricing`, `/about`, `/docs`, `/blog`,
  `/terms`, `/privacy`, `/support`, `/contact`. Static export like bracemark-web, and
  deliberately **thin** — it depends on `@stxapps/shared` and `@stxapps/web-ui`
  and nothing else, so no auth stack, no Dexie, no crypto ships to the apex. It
  links to bracemark-web across origins (`NEXT_PUBLIC_APP_URL`) rather than
  rendering any signed-in UI. What it shares with the app it shares through
  `shared` — the store-listing URLs (`stores/listings.ts`) are the first
  instance, and the plan/price table (`iap/plans.ts`) is the one that matters
  most: a marketing pricing page that hand-copies quotas is the classic drift.
  It also calls `bracemark-api` for public data (stats, health), which is why the
  apex is a real CORS origin and not a redirect-only host.
- **bracemark-extension** — browser extension (wxt)
- **bracemark-api** — backend API (hand-written, not nx-generated)
- **bracemark-extractor** — Cloudflare Workers + hono server that fetches
  link metadata (title/image; read-mode deferred) for clients that can't reach the
  URL themselves (`bracemark-web` without the browser extension, bulk imports). Its **own app on
  its own origin** `extractor.bracemark.com`, **separate from `bracemark-api`** (the blind sync
  broker) so that "`api.bracemark.com` only ever sees ciphertext" stays code-provable —
  the extractor is the one component that fetches arbitrary user URLs. A pure
  function (returns plaintext, holds no key, persists nothing — no D1/R2/DO
  bindings, only CORS config + rate limiters), anonymous, off-by-default and opt-in.
  Not "someday": the design **needs** it now that the browser extension is
  active-context only (no background bg-fetch), so web/desktop users have no
  other bulk-enrichment path. Two endpoints, contract-typed in `@stxapps/shared` (`extract/endpoints.ts`):
  `POST /v1/extract` (per-URL `{ title, image }` metadata) and `GET /v1/image` (a
  stateless, stream-don't-store image proxy). All arbitrary-URL fetches go through
  one `safeFetch` choke point — SSRF guard re-validated on every redirect hop,
  per-response byte ceiling, timeout, content-type allowlist. See
  [link-extraction.md](./link-extraction.md) — _server extraction_.
- **bracemark-expo** — Expo mobile app. The crypto/account layer is
  `@stxapps/expo-crypto` below; the RN-specific React logic — including the
  local-first data layer (write edge, sync engine, and read edge) — lives in
  `@stxapps/expo-react` below.
  The client stack mirrors the web apps with the RN equivalents: **expo-router**
  for file-based routing (routes in `src/app/`, the analogue of bracemark-web's
  Next.js App Router — the same `(app)`/`(auth)` route groups and
  `layout`→`_layout`, `page`→`index` renames; entry is `expo-router/entry`, not
  a hand-written `registerRootComponent`. One divergence: expo-router has **no**
  `_`-private-folder convention, so unlike bracemark-web's colocated
  `_components`/`_panes`, screen code lives **outside** `src/app/` in
  `src/components`/`src/features` — every file under the app root is a route.
  See expo-native-deps.md — _expo-router_), **Uniwind**
  for Tailwind classes (styling — a Metro-plugin, Tailwind **v4** CSS-first
  binding; see the version note below), **react-native-reusables** for
  shadcn-style components (copied into the app like shadcn on web — into
  `src/components/ui/`, by hand from the Uniwind registry variant, since its
  CLI needs tsconfig path aliases this app doesn't have; see expo-native-deps.md — there
  is no `expo-ui` package: with a single expo app, components live in the app
  until a second expo surface exists), **expo-sqlite + drizzle**
  as the Dexie analogue (drizzle's `useLiveQuery` ≈ Dexie `liveQuery`),
  **expo-file-system** for decrypted file blobs (see `expo-crypto`),
  **FlashList** in place of TanStack Virtual, and the same TanStack Query /
  react-hook-form / zod as web (TanStack Query's online/focus detection is
  browser-only, so `expo-react`'s `useQueryManagers` rewires it to
  NetInfo/AppState). Styling is now **Tailwind v4 across the whole workspace**:
  Uniwind requires Tailwind v4 (unlike NativeWind v4, which pinned Tailwind v3
  and forced a version split), so every Tailwind consumer — bracemark-expo plus
  each web project (`bracemark-web`, `bracemark-extension`, `web-ui`) — pins
  `tailwindcss@^4.x` itself; there is no root `overrides` split anymore
  (see expo-native-deps.md — _uniwind_).

A separate **bracemark-docs** app was planned here once. It's gone:
`bracemark-site` owns `/docs` as a path on the apex, so the docs accrue SEO
authority to the one domain instead of a second host.

### libs

#### @stxapps/shared

- used by any app
- Types, constants, validation, pure utils

#### @stxapps/react

- used by bracemark-web, bracemark-extension, bracemark-expo
- hooks, contexts, React utilities, no-ui components
- **not** bracemark-site: the marketing site renders no stateful UI, so it stops
  at `shared` + `web-ui`

#### @stxapps/web-ui

- used by bracemark-web, bracemark-extension, bracemark-site
- web-only ui components
- bracemark-site uses the presentational end of it (Button, the store/brand
  icons, `lib/utils`, `styles.css`) but **not** `contexts/theme-provider`, which
  reads settings through `web-react` — see the note in the site's root layout
- `components/links/*` is the shared link-editing surface — the pickers both
  editors render (`list-select`, `tags-field`), the at-cap wall
  (`link-quota-banner`), and `host-monogram`, the deterministic letter-on-hue
  tile a host falls back to when it has no favicon. A piece lands here the
  moment a SECOND surface draws it: the monogram moved out of bracemark-web's
  `link-media.tsx` when bracemark-extension's popup specimen became its second
  consumer, because "same site, same tile" has to hold across the popup and the
  library it saves into (see [browser-extension.md](./browser-extension.md), _the
  popup and options surfaces_)

#### @stxapps/web-crypto

- used by bracemark-web, bracemark-extension, and web-react
- web-only crypto-global primitives: KDF, AES-256-GCM, and id minting
  (`newId`, a `crypto.randomUUID()` wrapper; bracemark-api keeps its own copy since
  it's `platform:worker` and can't import this `platform:web` package)
- also owns the **v1 blob frame** (`blob.ts` — `packBlob`/`unpackBlob` +
  `encryptEntity`/`decryptEntity`): the `[version(1) || iv(12) || ciphertext+tag]`
  wire/at-rest layout wrapped around the AES-256-GCM primitive. Lives here (not in
  `web-react`, whose sync engine is the caller) so the framing sits next to the
  primitive it frames and the golden-vector spec (below) can assert the real
  `unpackBlob`. On expo the same frame is produced two ways (see `expo-crypto`);
  web has no native content path, so this is its only framer.

#### @stxapps/expo-crypto

- used by bracemark-expo only
- expo-only crypto — the `platform:expo` sibling of `web-crypto`: the same
  account derivation pipeline (docs/account.md) and AES-256-GCM primitives,
  implemented on React Native. Heavy compute runs **native**: Argon2id, HKDF,
  and AES-GCM go through `react-native-quick-crypto` (C++ JSI/Nitro); Ed25519
  stays on the same `@noble/ed25519` as web (signing is microseconds, and
  sharing the library makes credential drift structurally impossible). Also
  ships the **`BracemarkCrypto` pod** (`ios/` Swift, `android/` Kotlin, autolinked
  by `expo prebuild`), which hosts two Expo modules. **`BracemarkFileCrypto`**
  (Swift CryptoKit / Kotlin `javax.crypto`): whole-file
  encrypt/decrypt path-to-path in the native layer, reading/writing the frozen
  v1 blob frame — file bytes never enter the JS heap; the app stores content
  DECRYPTED on device (the Dexie-`data` analogue) and e.g. `expo-image` renders
  straight from the plaintext `file://` path. **`BracemarkSharedKeychain`** is the
  pod's second module — iOS-only (registered under `apple.modules`, no Kotlin
  counterpart), it reads/writes generic-password items under an explicit App
  Group access group, the one Keychain capability `expo-secure-store` doesn't
  expose; it's what lets the separate-process iOS share extension see the
  session (docs/share-sheet.md). The **small ENTITY blobs** take the
  JS-side path instead: `blob.ts` (`packBlob`/`unpackBlob` + `encryptEntity`/
  `decryptEntity`, the sibling of `web-crypto`'s) frames the identical v1 layout
  in JS over the `react-native-quick-crypto` AES — so the same wire frame is
  produced on whichever side of the JSI boundary suits the payload size (native
  for `files/` content, JS for KB-sized entity JSON). The frozen parameters stay
  in `shared`; the golden vectors (`shared` `crypto/contract-vectors.ts`) are asserted by
  both this package's and `web-crypto`'s specs, so "web and native derive
  identical keys/blobs" is a test rather than a review claim — within two limits
  that file's header states: no CI runs them yet, and the expo suite shims quick-crypto
  onto Node, so the on-device primitives and the Swift/Kotlin `BracemarkFileCrypto`
  framer are unproven until there's a device/simulator harness. One deliberate
  divergence: the account's `encryptionKey` is raw bytes, not a non-extractable
  `CryptoKey` (native has no such handle) — at-rest protection is
  `expo-secure-store`'s job.

#### @stxapps/web-react

- used by bracemark-web, bracemark-extension, web-ui (auth forms) — **not**
  bracemark-site, which has no session and no local store
- web-only React hooks/contexts/logic — the web-only sibling of `@stxapps/react`
  (same React-logic layer, but free to use browser-only APIs like IndexedDB and
  Web Crypto). Home for things shared across the web apps that aren't components
  (those live in `web-ui`) or pure crypto (that lives in `web-crypto`). In
  particular it owns the **local-first stack** shared by bracemark-web and
  bracemark-extension: the auth + sync providers (`contexts/`), the Dexie store and
  data layer (`data/`), the hand-rolled sync engine (`sync/`), and the
  editor/auth hooks (`hooks/`). These reach the API through `useApiClient()` /
  `SyncDeps.api` — the `@stxapps/react` seam each app binds to its own baseUrl —
  so nothing here imports an app's `process.env`.

#### @stxapps/expo-react

- used by bracemark-expo only
- expo-only React hooks/contexts/logic — the `platform:expo` sibling of
  `web-react` (same React-logic layer, but free to use React Native and Expo
  APIs). Home of the bracemark-expo local-first stack as it gets built: the
  expo-sqlite + drizzle store and data layer (write edge in `data/mutations.ts`
  - `data/item-store.ts`/`data/projection.ts`, sync engine in `sync/`, and the
    **read edge** — `data/queries.ts`, web-react queries.ts's SQLite port, plus
    the `useLiveRead` change-listener hook standing in for Dexie's liveQuery and
    the `useLists`/`useTags`/`useSettings` hooks over it; the shared query
    GRAMMAR — `LinkQuery`, `emptyQuery`, `excludeLists` — was hoisted to
    `@stxapps/shared` `sync/link-query.ts` when this second engine arrived, the
    same move as `WithPath`/`LinkItem` → `sync/items.ts` and, when bracemark-expo's
    settings tables grew a drag surface, the settings tree's drag projection →
    `sync/tree-dnd.ts` beside the `sync/tree.ts` helpers it builds on — each
    platform keeping only its px calibration and its own gesture layer
    (docs/editors.md)), the remaining editor
    hooks — plus: the session store
    (`data/session-store.ts`, web-react's sibling — expo-secure-store-backed
    since the key is raw bytes; `AFTER_FIRST_UNLOCK` for background sync, plus a
    sandbox sentinel file so an iOS reinstall doesn't resurrect the Keychain's
    old session), the first slice of the expo-sqlite + drizzle store
    (`data/db.ts` — lazy-opened, change-listener on for drizzle's `useLiveQuery`,
    idempotent DDL per the greenfield no-migrations policy — holding the `locks`
    table behind `data/lock-store.ts`, web lock-store's sibling; lock verifiers
    are deliberately NOT in secure-store — they're one-way PBKDF2 pairs gating
    already-decrypted data, and the pure covering logic both platforms share is
    `computeCoverage` in `@stxapps/shared` `sync/lock-coverage.ts`), the
    ON-DEVICE EXTRACTION stack (`lib/device-extraction.ts` — the worker that
    fetches each page natively, parsed by `lib/parse-html-head.ts` and decided by
    `@stxapps/shared` `extract/select.ts`, which every extracting client shares so
    a tier upgrade is an improvement rather than a change — driven by
    `contexts/extraction-provider.tsx`, the `platform:expo` sibling of web's; it
    never calls `bracemark-extractor` and rides its own `deviceExtractionMode` ladder, see
    docs/link-extraction.md), and
    `useQueryManagers` (rewires TanStack Query's browser-only
    online/focus managers to NetInfo and AppState). Native modules it builds on
    (`expo-sqlite`, `expo-file-system`, `expo-secure-store`, NetInfo) are
    **peerDependencies** — the
    app owns them so Expo autolinking sees them (the same pattern `expo-crypto`
    uses for `react-native-quick-crypto`). See _dependency versions_ below for the
    version each slot declares, and why `expo-modules-core` is declared nowhere.

### dependency rules

Keep the dependency graph acyclic and layered. From lowest to highest:
`shared` → `web-crypto` → `web-react` → `web-ui` → apps. `web-crypto` sits
below the React-logic layer in the type dimension (so React logic may build on
crypto primitives), but because it's `platform:web` the only thing that
actually imports it there is the `platform:web` sibling `web-react` — the
platform-agnostic `react` can't reach it. `web-crypto` itself depends only on
`shared` and is also consumed directly by apps.

- `shared` must not import from any other workspace package.
- `react` may import `shared` and `web-crypto` (at the type layer) — not
  `web-ui`. In practice the platform-agnostic `react` lib still can't reach
  `web-crypto` (it's `platform:web`); only the `platform:web` sibling
  `web-react` does.
- `web-ui` may import `shared`, `react`, and `web-react` (it's the UI layer,
  above the React-logic layer) — not the other way around. Most `web-ui`
  components are presentational and don't reach for `web-react`, but the auth
  forms (`components/auth/*`) do: they pair the shared field UI with the
  `useSignIn` / `useCreateAccount` submit hooks that live in `web-react`.
- `web-crypto` may import `shared` only.
- `expo-crypto` is the `platform:expo` sibling of `web-crypto` (same crypto
  layer): it may import `shared` only. Only `bracemark-expo` (and future
  `platform:expo` React-logic packages) can consume it.
- `web-react` is the web-only sibling of `react` (same React-logic layer, but
  `platform:web`): it may import `shared`, `react`, and `web-crypto`. Apps and
  `web-ui` (for the auth forms) consume it; it must not import `web-ui`.
- `expo-react` is the `platform:expo` sibling of `web-react` (same React-logic
  layer): it may import `shared`, `react`, and `expo-crypto`. Only `bracemark-expo`
  consumes it.
- Apps may import any package; **packages must never import an app.**
- `web-ui`, `web-crypto`, and `web-react` are web-only — do not import them from
  code meant to run on Expo/native; `expo-crypto` and `expo-react` are
  expo-only — do not import them from web/worker code (`react` and `shared`
  stay platform-agnostic).

These rules are **enforced at lint time** by `@nx/enforce-module-boundaries`
(config in `eslint.config.mjs`) — an illegal import fails `npm run lint`.
Enforcement is driven by two tag dimensions set in each project's
`package.json` under `nx.tags`:

| project             | type          | platform            |
| ------------------- | ------------- | ------------------- |
| shared              | `type:shared` | `platform:agnostic` |
| react               | `type:react`  | `platform:agnostic` |
| web-ui              | `type:ui`     | `platform:web`      |
| web-crypto          | `type:crypto` | `platform:web`      |
| expo-crypto         | `type:crypto` | `platform:expo`     |
| expo-react          | `type:react`  | `platform:expo`     |
| web-react           | `type:react`  | `platform:web`      |
| bracemark-web       | `type:app`    | `platform:web`      |
| bracemark-extension | `type:app`    | `platform:web`      |
| bracemark-api       | `type:app`    | `platform:worker`   |
| bracemark-extractor | `type:app`    | `platform:worker`   |
| bracemark-expo      | `type:app`    | `platform:expo`     |

- **type** enforces the layering: a project may depend only on its own layer
  and lower ones (`app` → `ui` → `react` → `crypto` → `shared`). `crypto` sits
  below `react` so React logic can build on it, and is also consumed directly by
  apps (`app` → `crypto` → `shared`).
- **platform** enforces portability: `agnostic` may depend only on `agnostic`;
  `web`/`worker`/`expo` may also use `agnostic` but never each other. (`worker`
  is the Cloudflare Workers runtime — web-standards, not Node — see `bundling
bracemark-api` below; `expo` is React Native/Hermes — no DOM, no Web Crypto.)

When you add a new package, give it both a `type:` and a `platform:` tag, and
add a matching `type:crypto`-style constraint block if it's a new layer.

### dependency versions

Where the previous section governs _what_ a project may import, this one governs
_which version_ it gets. **This section is about the Expo projects only**
(`bracemark-expo`, `expo-crypto`, `expo-react`) — see _the web side is different_ at
the end for why it stops there.

Expo is the special case because `react`, `react-native`, `expo-modules-core`, and
every autolinked native module must resolve to **exactly one** copy. Two copies
means duplicate native module registration, a second React, or Metro resolving one
while autolinking binds the other — and the symptom is an opaque native crash, not
a version error. What makes that hard to hold is that the Expo SDK version-locks
its whole native constellation **by exact pin**, and moves those pins on patch
releases. So any manifest that restates one of those versions is a second opinion
that can only agree by luck, and npm nests a duplicate the moment it disagrees.
Hence: **a version is chosen in exactly one place, and everyone else defers.**

| slot                       | version              | why                                                       |
| -------------------------- | -------------------- | --------------------------------------------------------- |
| root `package.json`        | real pin             | single source of truth                                    |
| app (`bracemark-expo`)     | `*`                  | never published; a range here can only conflict with root |
| package `dependencies`     | real range           | the package's own contract; not singletons                |
| package `peerDependencies` | real floor, else `*` | the app + root decide the version                         |
| package `devDependencies`  | **absent**           | nothing needs it — see below                              |

- **Root pins; the app declares `*`.** The app is private and never published, so
  a range in it can only ever disagree with root. (One deliberate exception:
  `tailwindcss@^4.x`, which root does _not_ pin — see expo-native-deps.md, _uniwind_.)
- **`react` is pinned _exactly_, not with a caret** — `react`, `react-dom`, and
  `react-test-renderer` are all `19.1.0`, the version `expo/bundledNativeModules.json`
  names for SDK 54. React Native ships its **own** copy of the renderer built for one
  exact React version (RN 0.81.5 → 19.1.0), and the legacy Paper renderer
  (`Libraries/Renderer/shims/ReactNative`) _throws_ on any mismatch:
  `Incompatible React versions: … must have the exact same version`. Fabric's
  renderer has no such assertion, so the app boots — the throw only surfaces when
  something reaches Paper, which `react-native-gesture-handler` does eagerly
  (`RNRenderer` ← `GestureDetector/utils.js`). A caret (`^19.1.0`) silently floats to
  19.2.x the next time the tree is re-solved and breaks the drag surfaces on device
  and the bracemark-expo suite. `react` is part of the version-locked constellation —
  pin it like `react-native` itself. Note `scheduler` follows react down (0.26.0).
  **Follow any react bump with `npm dedupe`:** every radix package peers on
  `react`, so changing the pin re-solves all of them and npm strands ~185 nested
  `@radix-ui/*` duplicates (measured: +137 KB in bracemark-web's bundle). `npm dedupe`
  collapses them back to one copy each — verify with
  `find node_modules -type d -path '*@radix-ui/react-primitive' | wc -l` (expect 1).
- **A package's `dependencies` carry real ranges** (`@noble/*`, `drizzle-orm`,
  `zod`, …) — they're the package's genuine contract and none are singletons.
- **A package's native/singleton `peerDependencies` are `*`** — the app owns them
  so Expo autolinking sees them, and root owns the version. Keep a real floor only
  where it encodes something you'd actually break on (`react: ^19.0.0`,
  `@tanstack/react-query: ^5.101.0`), not as a restatement of the root pin.
- **The expo packages declare no `devDependencies` at all** — not even the usual
  `*` mirror of their peers. The mirror's only job would be to make `typecheck`/
  `jest` resolve, but resolution is plain Node upward traversal
  (`packages/expo-crypto/src` → … → root `node_modules`, hit) and never reads the
  package's own manifest; and `@nx/dependency-checks` already counts the **peer**
  as the declaration, so `lint --fix` doesn't repopulate. A mirror would therefore
  carry no information the peer line doesn't — while reintroducing exactly the
  drift that nests a duplicate. This leans on npm workspace hoisting and is only
  sound because these packages are private and consumed as source by `bracemark-expo`
  alone; publishing them, or moving to a strict store like pnpm, would mean
  bringing real devDeps back.

**Never declare expo's internal, exactly-pinned transitives — `expo-modules-core`
above all.** `expo` depends on it at an _exact_ version (`expo@54.0.36` →
`expo-modules-core@3.0.30`), so any second declaration is a competing opinion that
can only agree by luck. It also moves on expo **patch** releases (`expo@54.0.30` →
`3.0.29`), so a well-meant `~3.0.30` (i.e. `>=3.0.30 <3.1.0`) silently nests a
duplicate the moment expo steps outside that window — in either direction. The SDK
is its sole owner: `expo-crypto` declares it **only** as a peer `*` and carries no
devDep for it, which resolves (verified via `npm ls`) to expo's exact `3.0.30`,
deduped to one hoisted copy. A bare `*` is safe **only** because expo's exact edge
constrains the intersection — on its own it would resolve to `latest`, which is
`57.x` (the package renumbered to track SDK versions). `@nx/dependency-checks`
counts the peer as a declaration, so `lint --fix` won't repopulate a pin; the app
gets the same outcome via `ignoredDependencies: ['expo-modules-core']` in the root
`eslint.config.mjs`.

**`*` is safe in a package peer, NOT in the root manifest.** The intersection
argument above holds only where some _other_ edge is exact. A package's
`peerDependencies` always has one (expo's), so `*` there resolves to expo's
version. The **root** manifest is resolved on its own, so a root `*` resolves to
`latest` — measured 2026-07-27: root `@expo/cli: "*"` + `@expo/metro-config: "*"`
installed **57.x** at `node_modules/@expo/*` and pushed expo's 54.x copies down
into `node_modules/expo/node_modules/`, which is strictly worse than the range it
replaced (anything resolving by bare specifier would load the SDK 57 copy).
`npm dedupe` does **not** repair that — only restoring a real range at root
re-hoisted them. So when root defers a version, defer with a real range that
admits the intended one (`~54.0.9`), never with `*`.

**The hoisting exception — `@expo/cli` and `@expo/metro-config` stay declared at
root.** These two _are_ expo internals pinned exactly (`expo@54.0.36` →
`@expo/cli@54.0.26`, `@expo/metro-config@54.0.17`), so the rule above would say
delete them. Don't: two third parties resolve them by **bare specifier** from
their own directory, and Node's upward traversal from `node_modules/<pkg>/` can't
see a copy nested under `node_modules/expo/`:

- `uniwind/dist/metro/transformer.cjs` does `require('@expo/metro-config')` — that
  is the Metro transform worker, i.e. all styling.
- `@nx/expo`'s `start`/`prebuild` executors do
  `require.resolve('@expo/cli/build/bin/cli')` — i.e. `nx start`, `nx prebuild`.

Their root declarations exist to keep both **hoisted**, not to pick a version:
the tilde ranges (`~54.0.16`, `~54.0.9`) sit below expo's exact pins and simply
admit them. This is also why `apps/bracemark-expo/metro.config.js` keeps the bare
`require('@expo/metro-config')` and ignores expo-doctor's advice to switch to the
`expo/metro-config` sub-export — the sub-export works, but the root declaration
would still be required, so the change buys nothing. A comment at that call site
records it. If you ever bump the SDK far enough that expo's pins leave those
tilde windows, widen the ranges rather than deleting the lines.

So an Expo SDK bump edits **one** file: the root `package.json`.

**Checking alignment.** The authority for "what does this SDK want" is
`node_modules/expo/bundledNativeModules.json`, and `npx expo-doctor` (run from
`apps/bracemark-expo`) diffs the installed tree against it. Three of its checks fail
here **by design** — the Metro config `projectRoot`/`watchFolders` mismatch (Nx
monorepo), `@expo/metro-config` installed directly (the hoisting exception
above), and the React Native Directory check (no metadata for the local native
modules `@stxapps/expo-crypto` / `bracemark-share`, plus "untested on New
Architecture" for `expo-share-extension`). A failure in _Check that packages
match versions required by installed Expo SDK_ is the real signal. Do **not** read versions off npm's
`latest` tag: Expo adopted unified versioning at SDK 55, so every `expo-*`
package renumbered to track the SDK major and `latest` is always the newest
SDK's — `expo-font` is `14.0.12` on SDK 54 while npm `latest` is `57.x`, and
`expo-modules-core` is `3.0.30` against a `latest` of `57.x`. Use the `sdk-54`
dist-tag (`npm view expo-font dist-tags`) or `npx expo install --check`; note the
latter writes into `apps/bracemark-expo/package.json`, so move any version it
proposes up to root and leave the app at `*`.

#### the web side is different — don't propagate this

`shared`, `react`, `web-crypto`, `web-ui`, `bracemark-web`, `bracemark-site`,
`bracemark-extension`, and the worker apps deliberately do **not** follow the
above, and shouldn't be "fixed" to match. They use ordinary npm conventions: each
manifest is self-describing, with real ranges (the two Next apps each own
`next: ~16.1.6`; `web-ui` owns its radix/lucide deps; `react` and `web-ui` keep
`react`/`react-dom` peer+devDep mirrors at `^19.0.0`). Root pins the RN/Expo
constellation for the Expo side; it is not a version registry for the web side.

In particular **`next` does not belong in the root manifest** — it is not a second
hoisting exception alongside `@expo/cli`. The bare-specifier concern is real
(`@nx/next`'s inference plugin does `require('next/constants')` from inside
`node_modules/@nx/next/`, which only resolves to a hoisted copy), but nothing
competes to nest `next` the way `expo`'s exact pins nest `@expo/*`: both Next apps
declare the same range, so npm hoists it, and root's `@nx/next` peers on
`next: >=14.0.0 <17.0.0`, which keeps a copy at the root either way. A root
declaration would add only a fourth opinion to drift from.

That's not inconsistency — the hazard that motivates the Expo rule doesn't exist
here:

- **No autolinking, no native constellation.** Nothing on web is version-locked as
  a set by an SDK, so there's no pin for a second manifest to contradict.
- **Web ranges intersect by construction.** `^19.0.0` in `web-ui`, `^19.1.0` at
  root, and `^19.0.0` in `bracemark-web` all admit the hoisted `19.2.7`, so npm
  dedupes to one copy without anyone deferring to anyone. The Expo problem is
  specifically that `react-native@0.81.5` and `expo-modules-core@3.0.30` are
  **exact**, leaving no room for a range to agree.
- **The web devDeps do real work.** `web-ui`'s `tailwindcss: ^4.3.0` and
  `bracemark-web`'s `@serwist/cli` aren't peer mirrors — they're genuine build-time
  deps with real ranges that carry real information.

`react` is a singleton on web too (two copies ⇒ "Invalid hook call"), so the
_concern_ isn't unique to Expo — but the ranges above already prevent it, and the
failure is legible when it does happen, unlike a native crash. When in doubt on
the web side, follow normal npm practice, not this section.

### module resolution in packages

Packages are `bundler=none` — apps consume their raw `.ts` source, so each
consuming bundler (Turbopack, Vite/wxt, Metro/Expo) resolves the package's
internal relative imports itself. Use **extensionless, bundler-style imports**
in package source:

```ts
// ✅ portable across every bundler that consumes the source
export * from './lib/theme';
// ❌ NodeNext convention — Turbopack/Metro resolve it literally and 404,
//    since the file on disk is theme.ts, not theme.js
export * from './lib/theme.js';
```

This requires `moduleResolution: bundler` (with `module: esnext` or
`preserve`) — which is now the **`tsconfig.base.json` default** (`module:
esnext`, `moduleResolution: bundler`), so packages and apps inherit it without
per-project overrides. Only two projects override `module`: `packages/shared`
uses `module: preserve`, and `bracemark-api`'s `tsconfig.spec.json` drops to
`commonjs`/`node10` for ts-jest.

The same applies to **apps**: extensionless source only works if a bundler is
in the path. `bracemark-web` (Turbopack) and `bracemark-extension` (Vite/wxt) bundle by
nature. `bracemark-api` is bundled at build time too — see below — so it uses
`moduleResolution: bundler` and extensionless imports as well. Since every
current project is bundled, `bundler` is the base default rather than a
per-project override.

#### the barrel is the API — except where a barrel is the cost

Every package's `exports` map is `"."` → `src/index.ts`, and consumers import
that: one entry point, one place to see what a package offers. `web-ui` is the
long-standing exception (a shadcn component library, whose components are meant
to be deep-imported — hence its `@stxapps/web-ui/**` entry in the
`enforce-module-boundaries` `allow` list).

The second exception is narrower and is a **memory** rule, not an API one. A
barrel costs whatever it re-exports, because **Metro does not tree-shake**: an
`index.ts` of 60 `export *`s compiles to 60 eager `require`s, so importing one
symbol from `@stxapps/expo-react` executes every provider, every hook, the sync
engine and the import/export path. In an app that is a one-time cost paid at
startup on a bundle that holds all of it anyway. In the **iOS share extension**
— a separate process, re-created on every share, with its own memory budget —
it is paid per share, for code that process will never call. So a handful of
files carry **explicit subpath exports** beside the `"."` entry:

| package                | subpath                 | who names it, and why                                                            |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `@stxapps/expo-react`  | `./data/share-store`    | the share sheet's data seam — the alternative is the whole package               |
| `@stxapps/expo-react`  | `./data/share-theme`    | the sheet's pre-paint theme read, on the same cold path ([theme.md](./theme.md)) |
| `@stxapps/expo-react`  | `./lib/auth-api-client` | the app's `lib/api-client` binding, which the sheet threads into Save            |
| `@stxapps/expo-crypto` | `./lib/ids`             | `newId` alone, without the AES + Argon2 stack behind the barrel                  |
| `@stxapps/expo-crypto` | `./lib/shared-keychain` | `session-store`'s three-function native wrapper, same reason                     |

They are declared, not reached for: a deep import that isn't in `exports` fails
to resolve. Add one only when a real cold-start path demands it, keep it out of
`index.ts`'s way (the barrel still re-exports the same file), and remember the
counterpart rule — the extensionless spelling above applies to the `exports`
targets too (`./src/lib/ids.ts` is a real path; there is no `.js` on disk).

The consumer side of this rule, and the numbers behind it, live in
[share-sheet.md](./share-sheet.md), _keep `index.share.js` lean_ — including the
lint rule that enforces it for the one tree where it is load-bearing.

### bundling bracemark-api

`bracemark-api` runs on **Cloudflare Workers**, with `src/worker.ts`
(`export default app`) as the entry. **wrangler** bundles it (esbuild under the
hood), inlining the workspace `@stxapps/*` packages from source — the same way
the web apps consume them, so the extensionless internal imports resolve.
Third-party deps (`hono`, `@hono/zod-validator`) are inlined too, since Workers
has no `node_modules` at runtime. There is **no Node entry** — bracemark-api does not
run on Node, so there is no `main.ts` / `@hono/node-server`.

Targets live in `apps/bracemark-api/package.json` under `nx.targets` (the same place
bracemark-web/bracemark-extension keep theirs). Since no plugin infers `build`/`deploy`
for this app, each target declares `"executor": "nx:run-commands"` **explicitly**
— the bare `options.command` form only resolves when a plugin already provides
the target to merge onto (as `@nx/next` does for bracemark-web's `build`):

- **dev** — `wrangler dev --env development`: runs the Worker in a local runtime
  (workerd/miniflare) with **local emulation** of D1/R2 (state under
  `.wrangler/`). The local-only `development` env in `wrangler.jsonc` supplies
  `CORS_ORIGINS=http://localhost:3000`. Add `--remote` to run on a real edge
  preview against the real bindings instead. Bindings live only under `env.*`,
  so `--env` is required.
- **build** — `wrangler deploy --env staging --dry-run --outdir dist`: bundles
  and validates without deploying (no auth needed). Real deploys use the
  `deploy` target (`wrangler deploy --env staging|production`); what each tier's
  hosts and bindings are called, and why the two tiers are isolated accounts, is
  in `docs/hosting.md`.
- **typecheck** — `tsc --noEmit` (wrangler/esbuild don't type-check); this is the
  type gate. Declared as an explicit `typecheck` **npm script** in
  `package.json` (`tsc --noEmit -p tsconfig.app.json && … -p tsconfig.spec.json`,
  app sources then specs) rather than left to the `@nx/js/typescript` plugin's
  inferred target: that inferred target is `tsc --build`-based and auto-disables
  itself into a green-exiting `echo` whenever a referenced tsconfig sets
  `noEmit: true` — which `tsconfig.spec.json` does (you don't emit test files).
  Left inferred, `npm run typecheck` would silently skip bracemark-api. An npm script
  named `typecheck` overrides the inferred target (the same reason bracemark-web's own
  `tsc --noEmit` script works), so nx runs the real `tsc`.

  Both passes are **self-contained — no prior build required.** `tsconfig.spec.json`
  deliberately **compiles the app sources directly** (`include: src/**/*.ts`) instead
  of pulling app types via a project `reference` to the composite `tsconfig.app.json`.
  A `tsc -p` reference resolves the referenced composite project's types from its
  emitted `dist/*.d.ts` — which this `--noEmit` typecheck never writes — so a
  reference made `npx nx typecheck @stxapps/bracemark-api` fail with `TS6305` on a clean
  clone or after any add/move/rename/delete under `src` (stale `dist/`). Compiling
  from source removes that `dist/` dependency entirely. The split still pulls its
  weight: the **app pass** (`tsconfig.app.json`, Workers-only types, no `node`) is
  the portability gate on app source; the **spec pass** adds the specs and
  `node` / `cloudflare:test` types. **Do not re-add the `references` block to
  `tsconfig.spec.json`** — it reintroduces the prebuilt-`dist/` requirement.

esbuild remains a single workspace-root devDependency for `@serwist/cli`'s
optional-peer service-worker build in `bracemark-web` (don't redeclare it per-app).
