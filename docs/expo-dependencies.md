## expo dependencies (bracemark-expo)

What bracemark-expo is built out of — one section per dependency (or cluster):
what it's for, why it beat the alternative, and the wiring and gotchas that
aren't in its own README. For how the app is built and shipped, see
[expo-build.md](./expo-build.md); for the one-time scaffold commands,
[setup.md](./setup.md); for the RN-equivalent-of-the-web-stack overview,
[architecture.md](./architecture.md) — _bracemark-expo_.

**The install convention every section below follows**: run
`npx expo install <pkg>` from inside `apps/bracemark-expo` (it picks the
SDK-54-compatible version), then move the app's entry to `*` and pin the real
version once in the **root** `package.json` — [architecture.md](./architecture.md),
_dependency versions_. Anything native needs `npx expo prebuild` before it
exists on a device, and can't be exercised by jest or Metro alone.

#### expo-image-picker + expo-image-manipulator

The edit screen's custom-image flow (pick + client-side resize —
docs/editors.md, invariant 2). Added like expo-router below:

    npx expo install expo-image-picker expo-image-manipulator

(run inside `apps/bracemark-expo`; then move each to `*` in the app and pin the
real version in the root `package.json`, per the normal convention).
`expo-image-manipulator` is also a peerDependency `*` of `@stxapps/expo-react`
(its `lib/image.ts` — the NetInfo/expo-sqlite pattern). `app.config.ts`
carries the `expo-image-picker` config plugin with a `photosPermission`
string. Both are native modules — `npx expo prebuild` required. This section's
own image surface — the edit screen's preview — deliberately stays on **core RN
`Image`**, and so does `lib/image.ts`'s `probeImageSize`; `expo-image` (below)
arrived for the link LIST's slots only, and neither reason it was added reaches
here.

⚠ Both modules write their output under the OS cache directory, in a folder
they name themselves (`ImagePicker`, `ImageManipulator`; expo-document-picker's
is `DocumentPicker`), and the sign-out wipe deletes those folders **by name**
(`@stxapps/expo-react` `data/cache-files.ts`). An upgrade that renames one
breaks the sweep without an error anywhere — re-read the names from the native
sources when bumping any of the three
([data-lifecycle.md](./data-lifecycle.md), _what an empty table does not mean_).

#### expo-image

The renderer behind the link list's media slots — favicons and preview images
(`src/features/links/link-media.tsx`, whose header is canonical). Added per the
normal convention: `*` in the app, the real pin in the root `package.json`
(`~3.0.11` — the version `expo/bundledNativeModules.json` names for SDK 54).
Native module — `npx expo prebuild` required. Two things bought it, and NEITHER
is the usual reason to reach for it:

- **`recyclingKey`.** The list is a FlashList, which RECYCLES item views. Core RN
  `Image` keeps painting the previous source until the new one decodes, so a fast
  scroll flashes the wrong thumbnail on the row it's recycling into;
  `recyclingKey` blanks the view when the key changes. This is the FlashList
  docs' own recommendation for images in recycled cells.
- **SVG decoding** — `SDWebImageSVGCoder` on iOS, `androidsvg` on Android, both
  content-sniffed rather than extension-driven (the favicon cache writes
  extension-less files, so that matters). This is what lets the icon sniff accept
  `<link rel="icon" type="image/svg+xml">` at all; see
  [link-extraction.md](./link-extraction.md) — _favicons_.

What did **not** buy it: remote fetching, disk caching, placeholders,
transitions. Every source here is a local plaintext `file://` path this app
already wrote, which constrains one prop — **no slot may use `cachePolicy:
'disk' | 'memory-disk'`**, since that duplicates the user's image library into a
second on-device copy. Preview images use `'memory'` (a file id is immutable, so
a uri-keyed cache can't go stale, and it pays for the re-decode as rows recycle
back into view); favicons use `'none'` (the per-host path is stable while its
bytes are **replaceable** — the declared-icon capture landing over the guessed
`/favicon.ico` — so any uri-keyed cache would go on serving the superseded icon).

Two wiring notes: expo-image's `Image` is a composite, not a core RN host, so it
needs `withUniwind()` to accept `className` (the `SafeAreaView` treatment —
_uniwind + react-native-reusables_ below), and `resizeMode` is spelled
`contentFit`. No jest mock is
wired, because no spec renders these slots today; add one in
`src/testing/setup.ts` (the uniwind/NetInfo pattern) if that changes. The SVG
path can only be exercised on a device build.

#### expo-iap

Store IAP for the subscription section (docs/iap.md — the store purchase flow).
`expo-iap` is the OpenIAP successor to the deprecated react-native-iap (same
maintainer; the old repo is archived). Added per the normal convention: `*` in
the app, real pin (`^4.7.0`) in the root `package.json`. Its config plugin is in
`app.config.ts` (`expo-iap` — it wires the Android BILLING permission and the
native OpenIAP SDKs), and it's a native module — `npx expo prebuild` required;
the store sheet itself only works on a real device/simulator with a store
account (jest/Metro can't exercise it). No API keys on the client: server-side
verification config lives in bracemark-api's `wrangler.jsonc` (docs/iap.md — config
per env).

**Nothing to add in Xcode's Signing & Capabilities.** Ordinary StoreKit IAP
needs **no entitlement** — Apple enables the In-App Purchase service on every
explicit App ID by default, so the Xcode capability row writes nothing to
`.entitlements`, and there is nothing for prebuild to omit. Verified two ways:
`expo-iap`'s plugin touches entitlements **only** for alternative/external
purchase (`com.apple.developer.storekit.external-purchase*`), which is opt-in
through plugin options this app doesn't pass; and a fresh `expo prebuild
--platform ios` emits exactly one entitlement key in each of the two targets'
`.entitlements` — `com.apple.security.application-groups` — with no
`SystemCapabilities` block in the pbxproj at all. So the generated project is
complete as-is; if a purchase flow fails it is an App Store Connect problem
(Paid Applications Agreement not active, products not created or not "Ready to
Submit", no sandbox tester), not a missing capability.

One prebuild-durability catch if you test on the **simulator** with a local
StoreKit configuration file: the file is selected per **scheme** (Edit Scheme →
Run → Options → StoreKit Configuration), and schemes live under `ios/`, which
`--clean` deletes. Keep the `.storekit` file outside `ios/` and expect to
re-select it after each prebuild — or test on a device with a sandbox account
and skip it.

#### expo-store-review

The in-app rating prompt — `SKStoreReviewController` / `AppStore.requestReview`
on iOS, the Play In-App Review API on Android. Added per the normal convention
(`*` in the app, `~9.0.9` at root). **No config plugin** — the module ships
none, so nothing goes in `app.config.ts`'s `plugins` — but it is native, so
`npx expo prebuild` before it exists on a device.

The rules for WHEN to ask are `apps/bracemark-expo/src/lib/review-prompt.ts`,
and its header is the argument; in short, a successful save from the add panel,
every tenth since the last ask, never more than once per 120 days, never more
than three times, never after an error. Saves from the share sheet
count toward the ten (share-store's `applyShareDraft`, the one place both
platforms' shares land in the app's process) but never ask themselves. An import
never asks: it is usually the first session, before the user has used the
product. The bookkeeping is a device-local single-row table, `review_prompt`
(`@stxapps/expo-react` `data/review-prompt-store.ts`), wiped on sign-out with the
rest — so every limit here, the three asks and the Settings row below included,
holds **until sign-out** and starts over at the next sign-in. Only the OS's cap
is per install.

The ask is made about a second and a half after the save, once the add panel has
closed, and it is **recorded when it is made, not when it is earned**. If the app
is no longer active when that delay ends — paste, save, back to the browser —
nothing is asked and nothing is recorded; the saves stay earned and the next save
in the app asks instead. Recording at the save would spend one of the three asks,
and 120 days, on a request iOS rejects for want of a foreground scene.

Settings → About carries a **Rate Bracemark** row that opens the store listing
(on iOS with `?action=write-review`, which opens the review composer). Pressing
it stops the automatic prompt on that device until sign-out — it is the only sign
we can get that the user rated. The URLs come from `@stxapps/shared`'s
`stores/listings.ts`, **not** `StoreReview.storeUrl()`: that reads
`ios.appStoreUrl` / `android.playStoreUrl` from `app.config.ts`, which would be a
second copy of the listings. Nor does `app.config.ts` import them to fill those
fields: it is evaluated in Node at config time, and the shared barrel is raw
TypeScript with zod behind it — nothing there needs the URLs anyway.

Four things that aren't in its README:

- **The OS decides whether anything shows, and never says.** iOS caps the sheet
  at three a year per install and shows nothing from TestFlight; Play keeps an
  unpublished quota and shows nothing for an install that didn't come from Play.
  `requestReview` resolves either way, so "I called it and nothing appeared" is
  normal and not a bug. What we store is when we **asked**. Neither store says
  whether the user has rated either, which is why the cap on asks and the
  Settings row stand in for that answer.
- **We don't gate on `isAvailableAsync()`, because it answers nothing the request
  doesn't.** On iOS it is "not TestFlight", where the request is ignored anyway.
  On Android it is "the Play Store package is visible to us": true on a Play
  install — an app's installer is always visible to it, with or without a
  `<queries>` entry — and false on a sideload, where Play's flow resolves without
  UI anyway. Neither says whether a sheet will show. `requestReview` alone is
  safe on both platforms; its rejection (no foreground scene on iOS, a failed
  Play task) is swallowed.
- **`__DEV__` builds never ask.** In a development build the iOS simulator shows
  the sheet on _every_ call, which would land in the middle of the Maestro flows
  that save more than a handful of links. To see the real sheet, run a
  **release** build on the simulator (`npx expo run:ios --configuration Release`)
  and save ten links. On Android nothing shows outside a Play
  install; Play's internal-app-sharing or an internal-testing track is the way to
  see it there. The gate is the **bundle's**, not the binary's: `measure:native`
  serves a `--no-dev` bundle to the development client
  ([e2e.md](./e2e.md), _the native leg_), so the prompt is live there, on a
  simulator that shows every ask. Its flows import and export, which neither
  count nor ask; one that saved ten links through the add panel would meet the
  sheet.
- **It is in the iOS share extension's `excludedPackages`.** Its Swift reaches
  the host app's window scene through `UIApplication.shared`, which an app
  extension can't use, and the extension never asks anyway. After a prebuild,
  `ios/Podfile` should list it in the `BracemarkShareExtension` target's
  `exclude` array, and `ExpoStoreReview` should appear only in
  `Pods-Bracemark`'s xcconfigs.

#### @react-native-community/datetimepicker

The two **theme crossover-time** fields in Settings → Misc (`custom` mode —
[theme.md](./theme.md)). Added per the normal convention (`npx expo install`
inside `apps/bracemark-expo`, then `*` in the app and the real pin — `8.4.4`,
what `expo/bundledNativeModules.json` names for SDK 54 — in the root
`package.json`). Native module, so `npx expo prebuild` is required.

It is here because web's control for these fields is `<Input type="time">`, and
the property that makes that work is **not** the popup — it's that the browser
only ever emits a complete `"HH:mm"`. The times are validated at the read edge
by `coerceThemeState`, which falls back to `DEFAULT_THEME` on any malformed
value, so a free-text RN field can't reach a new time at all: each intermediate
keystroke is invalid and gets coerced away mid-edit (and on the Sync tab, each
one is its own `writeSettingsGeneral` + sync kick). A native picker restores the
commit-once-with-a-valid-value property that `type="time"` had. The wrapper is
`features/settings/time-field.tsx`; its header is canonical.

Two notes that aren't in the package's README:

- **Never pass `is24Hour` on Android.** Omitted, `RNTimePickerDialogFragment`
  defaults it to `DateFormat.is24HourFormat(context)` — the device's own
  "Use 24-hour format" setting. Any value passed there overrides the user's
  choice, so the app carries no 12h/24h flag of its own (iOS follows the locale;
  the button label goes through `toLocaleTimeString`).
- **The config plugin is listed in `app.config.ts` but does nothing.** It only
  restyles the Android dialogs, and every branch early-returns without an
  `android` option. It's named so `expo-doctor` doesn't flag an unlisted config
  plugin and `expo install` stops re-prompting for it — not because the pickers
  need configuring.

#### expo-router

File-based routing, the RN analogue of bracemark-web's Next.js App Router — routes
live in `apps/bracemark-expo/src/app/`, so the two apps share the same
folder-is-the-route-tree mental model. Added like:

    npx expo install expo-router react-native-screens expo-linking expo-constants

(run inside `apps/bracemark-expo`; `expo install` picks SDK-54-compatible versions,
then move each to `*` in the app and pin the real version in the root
`package.json`, per the normal convention). `react-native-screens`,
`expo-linking`, and `expo-constants` are required peers; `react-native-safe-area-context`
was already present. `expo install` also appends the `expo-router` config
plugin to the app config. Wiring (already done):

- **entry point**: `package.json` `"main": "expo-router/entry"` — this
  **replaces the old `index.js` + `registerRootComponent(App)`**, which were
  deleted. expo-router's entry sets up the route context itself; there is no
  hand-written root component anymore.
- **routes dir**: expo-router auto-detects `src/app` as the app root (it looks
  for `app/`, then `src/app/`), so **no `EXPO_ROUTER_APP_ROOT`** is needed. The
  root `src/app/_layout.tsx` hosts the `QueryClientProvider`,
  `useQueryManagers()`, `StatusBar`, the `global.css` import, and renders a
  `<Stack>`. Safe-area context comes from expo-router's NavigationContainer
  (react-navigation's `SafeAreaProviderCompat`), so screens use `SafeAreaView`
  with **no explicit `SafeAreaProvider`** in `_layout`.
- **route tree — mirrors bracemark-web's `src/app/`.** Same `(group)` syntax as the
  Next.js App Router (a folder in parens adds **no** URL segment), so the layout
  is a near 1:1 port:

  ```
  src/app/
    _layout.tsx                  root Stack + providers
    index.tsx                    "/"  public landing (bracemark-web's page.tsx)
    (auth)/_layout.tsx           GuestGuard chrome  → TODO once auth lands
    (auth)/sign-in/index.tsx     /sign-in
    (auth)/create-account/index.tsx   /create-account
    (app)/_layout.tsx            AuthGuard + sync/lock providers → TODO
    (app)/links/index.tsx        /links
    (app)/settings/index.tsx     /settings  (+ future settings/[section].tsx)
  ```

  `page.tsx`→`index.tsx` and `layout.tsx`→`_layout.tsx` are the only renames.
  The auth gating (bracemark-web's `AuthGuard`/`GuestGuard`/`AuthedHomeRedirect`) is
  left as `TODO(auth)` comments in the three layouts + the landing — there is
  nothing to bind to until `@stxapps/expo-react` ships the auth layer; the
  expo-router idiom will be `<Redirect>` / `<Stack.Protected guard>`.

- **no `_`-private folders — the one real divergence from bracemark-web.** Every
  file under the app root becomes a route: expo-router's `getFileMeta` treats
  only `_layout`, `(group)`, `+api`, `+not-found`, and platform suffixes
  (`.ios`/`.web`) as special — it has **no** `_`-prefixed private-folder
  convention, so bracemark-web's colocated `(app)/links/_components`, `_hooks`,
  `_panes`, … would each become a bogus route (e.g. `/links/_components/foo`).
  So route files under `src/app/` stay **thin** and their UI lives **outside**
  the app root — `src/components/` (e.g. the shared `Screen` placeholder) and,
  as screens grow, `src/features/<name>/`. This is the same reason specs live
  outside `src/app/` (below).
- **babel**: nothing to add — `babel-preset-expo` (already in `.babelrc.js`) has
  the router transform built in (it's what injects `EXPO_ROUTER_APP_ROOT` and
  auto-detects `src/app`). Metro also needs no change; the existing
  `@expo/metro-config` base + the Uniwind/Nx wrappers are enough.
- **specs colocate with their source — _outside_ `src/app/`.** Every file under
  the app root becomes a route (expo-router's ignore list drops only
  `+html`/`+api`/`+middleware`/`+native-intent` — **not `*.spec.*`**), so a
  `.spec.tsx` beside a route file would be scanned as a bogus route. That costs
  nothing here: the workspace convention is already colocated specs
  (`foo.spec.ts` next to `foo.ts`, never a central dir), and bracemark-expo's real UI
  lives outside `src/app/` anyway (thin routes — see "no `_`-private folders"
  above). So each spec sits next to its component/feature: the landing UI is
  `src/components/landing.tsx` with `src/components/landing.spec.tsx` beside it,
  while the route `src/app/index.tsx` is a thin wrapper that renders `<Landing/>`.
  Specs thus distribute across `src/components`/`src/features`; they don't pile up
  in a central folder.
- **test _infra_ lives in `src/testing/`** (mirroring
  `packages/expo-crypto/src/testing/`): the jest `setup.ts` (expo / NetInfo /
  safe-area / uniwind mocks) and `css-mock.js` (the `*.css` → empty-module map),
  wired from `jest.config.cts` and the tsconfigs. `testing/` is for test
  **helpers only — never specs** (those colocate, above).
- **jest ignores build output.** `jest.config.cts` sets
  `testPathIgnorePatterns: ['/node_modules/', '/out-tsc/']`. Without the
  `out-tsc/` entry, `typecheck` (`tsc --build`) emits `*.spec.d.ts` under
  `out-tsc/`, and jest's default testMatch runs that `.d.ts` as an empty suite,
  failing with "must contain at least one test".
  - **Could specs live _inside_ `src/app/`?** Only in a `__tests__/` subfolder,
    never as loose `.spec.tsx`. Metro's default `resolver.blockList` (from
    `metro-config`'s exclusionList) is `[/\/__tests__\/.*/]`, and expo-router
    scans routes over Metro's file map (`matchFilesWithContext` →
    `_fileSystem.matchFiles`), which excludes blocklisted paths — so a
    `__tests__/` dir is invisible to the router. We don't use that (colocating
    beside the out-of-`app` source is simpler and matches the convention). Note
    there is **no** `(test|spec)` blocklist anywhere in Expo/Metro — the only
    Expo-added blockList entry is `.expo/types`; and the route-tree `ignore`
    option (`getRoutesCore`, fed from `Constants.expoConfig.extra.router`) can't
    be used from app config because its entries must be `RegExp` and that config
    is read from a serialized JSON manifest that can't carry one. The only
    non-route markers are the fixed set (`_layout`, `+not-found`, `+html`,
    `+native-intent`, `+middleware`, `+api`, plus `(group)`/`[param]`).

#### expo-splash-screen

Configured in `app.config.ts` (the mark at 200pt, `contain`, on `#ffffff` with a
`dark` pair on `#0a0a0a` — the same two values `--color-background` resolves to,
see [brand-assets.md](./brand-assets.md)), so both platforms get a native launch
screen with no JS involved. What needs saying is **when it comes off**, because
the default answer is not the one this app wants and nothing about it is visible
in our source.

**expo-router hides the splash itself.** One `requestAnimationFrame` after the
`NavigationContainer` reports ready (`global-state/router-store.js`, `onReady` →
`_internal_maybeHideAsync`), which it arms from the entry in a `setTimeout`
explicitly so an app can get its own `preventAutoHideAsync()` in first
(`renderRootComponent`). That instant is the first frame the navigator CAN paint —
strictly before `AuthProvider`'s secure-store read resolves, before the locks
read, before the store's first-sync flag. So the splash used to lift onto the null
branch of `HomeGuard`/`AuthGuard` and the `'checking'` branch of `AppLockGate`/
`InitialSyncGate`: a launch screen followed by a blank one, every cold start, for
as long as a keystore round trip takes on a cold Android process.

**The hold is two files and only works as a pair.**
`SplashScreen.preventAutoHideAsync()` at module scope in `src/app/_layout.tsx`
(module scope is the point — anything later loses the race it was written to win)
turns the router's auto-hide into a no-op, and
`src/components/splash-hold.tsx` — mounted under `AuthProvider`, renders null in
every state — hides it once `status` leaves `'loading'`. The prevent without the
component is a splash that never lifts, which is why neither half moves alone.

Three properties worth keeping if this is ever touched:

- **It hides on the AUTH decision, not on first content.** The `<Redirect>` to
  `/links`, the locks read and the first-sync flag all land after the splash is
  gone. Each is one local read, the long pole is the one being covered, and
  reaching further would mean gating on providers that only exist under `(app)` —
  a guest never mounts them.
- **What those remaining frames paint is the root navigator's background**, which
  is `--color-background` only because `_layout.tsx` says so; react-navigation's
  stock `DefaultTheme` background is `rgb(242, 242, 242)`. See
  [theme.md](./theme.md), _per-app wiring_.
- **The hide is latched and has a 5s fallback timer.** A splash that never hides
  is an app that never starts — no error, no screen, nothing to tap — so a
  hydration that never settles still gets the screen back.
  `components/splash-hold.spec.tsx` pins that one, because it is the only failure
  here that isn't cosmetic and it has no symptom in jest or on device short of a
  brick.

`expo-splash-screen` is in the iOS share extension's `excludedPackages`
(`app.config.ts`): that process has no splash, and it never loads `_layout.tsx`
anyway — it boots `index.share.js`, which registers the share root and nothing
else ([share-sheet.md](./share-sheet.md)).

#### uniwind + react-native-reusables

The RN equivalent of the web tailwind + shadcn stack (see architecture.md —
_bracemark-expo_). Styling is **Uniwind** (Tailwind **v4**, CSS-first, a Metro
plugin — from the Unistyles authors). We migrated off NativeWind once
react-native-reusables shipped first-class Uniwind support
([PR #492](https://github.com/founded-labs/react-native-reusables/pull/492));
the payoff is that the whole workspace is on **Tailwind v4** and the old v3/v4
version split is gone. Wiring (already done):

- deps: `uniwind` (version in the root `package.json`, app declares `*`, per the
  normal convention) + `tailwindcss@^4.x` pinned in
  `apps/bracemark-expo/package.json` — Uniwind peers on `tailwindcss@>=4`. Every
  Tailwind consumer now pins `^4.x` itself (`bracemark-web`, `bracemark-extension`,
  `web-ui`, and bracemark-expo); there is **no root-hoisted `tailwindcss` and no
  `overrides` entry** (both existed only to keep NativeWind's edge on v3). If
  styling breaks after dependency surgery, check
  `require.resolve('tailwindcss', { paths: ['apps/bracemark-expo'] })` resolves v4.
- config: **no `tailwind.config.js`** (Tailwind v4 is CSS-first) and **no
  babel preset** (Uniwind is Metro-only). `global.css` holds
  `@import 'tailwindcss'; @import 'uniwind';` plus an `@source` line for any
  workspace package the app renders classNames from (the v4 replacement for the
  old `content` glob), and is imported **once at the top of the root
  `src/app/_layout.tsx`** (Uniwind wants it in the app tree, not the entry).
  `metro.config.js` wraps with
  `withUniwindConfig(..., { cssEntryFile: './global.css', dtsFile:
'./uniwind-env.d.ts' })` as the **outermost** wrapper (around `withNxMetro`).
  `uniwind-env.d.ts` is **generated by Uniwind** on the first metro run (holds
  the `className` types + theme list) and is referenced from the solution
  `tsconfig.json` `include`; `tsconfig.app.json` needs **no** `jsxImportSource`.
  Composite components that aren't core RN hosts (e.g. `SafeAreaView` from
  `react-native-safe-area-context`) need `withUniwind(Component)` to accept
  `className`; `View`/`Text` and reanimated components accept it directly, and
  uniwind ships wrappers for the core RN components that need one — `TextInput`,
  `ScrollView` (including `contentContainerClassName`), `KeyboardAvoidingView` —
  so only third-party composites need wrapping by hand.
- components come from **react-native-reusables** (the shadcn analogue —
  same copy-into-the-app model), landing in `src/components/ui/` (the mirror of
  `packages/web-ui/src/components/ui/` — in the app, not a package: there is
  deliberately no `expo-ui` lib while bracemark-expo is the only expo app). But
  **the CLI doesn't work here — copy from the registry by hand.**
  `npx @react-native-reusables/cli@latest add <component>` resolves its write
  paths through tsconfig `paths` aliases (`tsconfig-paths`), and bracemark-expo has
  none — apps in this workspace use relative imports (web-ui only satisfied the
  shadcn CLI via its `@stxapps/web-ui/*` self-alias + package `exports`, which
  an app has no reason to grow). Even `--yes` still blocks on an interactive
  components.json prompt. So instead fetch the Uniwind variant straight from
  the registry the CLI reads —
  `https://reactnativereusables.com/r/uniwind/<component>.json` (`files[].content`)
  — write it to `src/components/ui/<component>.tsx`, and rewrite the
  `@/registry/uniwind/*` imports to relative (`../../lib/utils` for `cn` —
  which lives at `src/lib/utils.ts`, byte-identical to web-ui's — and `./text`
  etc. for registry siblings). Declare any `dependencies` the registry entry
  lists per the root-pin + app-`*` convention (done so far:
  `@rn-primitives/slot`, `class-variance-authority`, `clsx`, `tailwind-merge`).
  Keep the copy otherwise verbatim so future upstream diffs stay legible; local
  changes are flagged in a header comment per file (`text.tsx` carries
  `font-sans` in its base variant — see the font section).
  **Watch for NativeWind-isms the port left behind:** the registry's uniwind
  variant was ported from its NativeWind one, and stray props survive. `input`
  arrived destructuring `placeholderClassName`, which is NativeWind's name —
  Uniwind neither declares it in its type augmentation nor reads it at runtime
  (its own is `placeholderTextColorClassName`, fed an `accent-*` utility; the
  `placeholder:` class variant the registry also ships does **not** cover the
  same ground on native — it compiles to an empty style, see `theme.md`,
  _extending_). That surfaces as a TS2339 under
  `npx nx typecheck @stxapps/bracemark-expo`, **not** at lint, so it's caught but
  only if you typecheck the app after copying. Drop the dead prop and record the
  removal in the header comment like any other local change. One jest catch:
  `@rn-primitives/*` ships raw JSX in its dist (expects the consumer's
  Metro/babel to transform, like RN packages), so `@rn-primitives` is in
  `jest.config.cts`'s `transformIgnorePatterns` allowlist. Components that
  animate will pull in `react-native-reanimated` / `react-native-worklets`
  (already installed, SDK 54-pinned at root).
- jest: `uniwind` is mocked (its className→style bridge needs the Metro
  transform / native runtime — the HOC becomes identity in tests) and `*.css`
  imports map to an empty module (`src/testing/css-mock.js`), alongside the
  official NetInfo and safe-area-context mocks, all in `src/testing/setup.ts` /
  `jest.config.cts`.

#### font — Inter

The web apps load Inter via CSS (`next/font` in bracemark-web, `@font-face` in
bracemark-extension) — neither works on React Native (no DOM cascade, no woff2). The
native equivalent is **expo-font, embedded at build time via its config plugin**
(not the runtime `useFonts` hook): the font is registered natively from process
start, so `fontFamily: 'Inter'` is available at first paint with no async load,
no splash gate, and no flash. Wiring (already done):

- **asset**: `assets/fonts/InterVariable.ttf` — the same single variable file the
  web/extension use (as woff2), so one source of truth; the `wght` axis backs the
  Tailwind font-weight utilities (`font-medium`/`font-semibold`/…). Downloaded as
  TTF from the [Inter release](https://github.com/rsms/inter/releases) (native
  can't consume the vendored woff2). Italic isn't embedded yet — add its TTF and a
  second path to the plugin `fonts` array when a surface needs it.
- **rename**: upstream `InterVariable.ttf` names its family **"Inter Variable"**,
  and the expo-font plugin embeds under the font's _internal_ name on iOS with no
  override — so `tools/scripts/rename-inter.py` rewrites the name table to plain
  **"Inter"** (run once per downloaded release; needs `brew install fonttools` or
  `pip install fonttools`). This is why the committed TTF isn't byte-identical to
  upstream. Without it, iOS would need `fontFamily: 'Inter Variable'`.
- **plugin (iOS)**: `["expo-font", { fonts: ["./assets/fonts/InterVariable.ttf"] }]`
  in `app.config.ts` — picked up on `npx expo prebuild` (the dev client is already
  required for the expo-crypto native module). Keep `expo-font` in
  `package.json` dependencies even though nothing imports it in JS: the config
  plugin resolves from the package. It must stay the **top-level `fonts`** key,
  not `ios.fonts`: `expo-share-extension` reads exactly that key to embed Inter
  in the iOS share extension target ([share-sheet.md](./share-sheet.md)), and
  finds nothing under `ios`.
- **plugin (Android)**: `plugins/with-android-variable-font.js`, because the
  expo-font path form does **not work on Android** — silently. It copies the
  file to `assets/fonts/`, and React Native resolves an asset font by **file
  name**: `fontFamily: 'Inter'` looks for `assets/fonts/Inter.ttf`, misses, and
  `Typeface.create` hands back the system face (Roboto). No error, no warning —
  just no Inter, and since Roboto is resolved at regular or bold only, every
  `font-medium`/`font-semibold` (nearly all the weights this app uses) drew at
  400: "no bold text anywhere on Android", while iOS was fine. Renaming the file
  to `Inter.ttf` would restore the face but not the weights — the asset path
  only knows `NORMAL` and a separate `_bold` file. The plugin instead writes a
  `res/font` XML family (`inter.xml`) with one `<font>` per weight 100–900, each
  pinning `app:fontVariationSettings="'wght' N"` on the one TTF, and registers
  it under `"Inter"` with `ReactFontManager.addCustomFont` in `MainApplication`;
  RN then asks `Typeface.create(family, weight, italic)` for the right entry.
  expo-font's own object form writes that XML too, but without
  `fontVariationSettings`, so every entry would draw the file's default
  instance. The plugin also deletes the dead `assets/fonts/` copy the top-level
  expo-font key leaves on Android (a `finalized` mod, so plugin order doesn't
  matter).
- **Uniwind binding**: `global.css` sets `--font-sans: 'Inter'`, so the
  `font-sans` utility emits `fontFamily: 'Inter'`. RN has no CSS cascade, so
  `font-sans` must be applied where text renders — it lives in the
  react-native-reusables `Text` base variant (`src/components/ui/text.tsx`, a
  deliberate local addition to the registry copy), making Inter the app-wide
  default wherever that `Text` is used; only text rendered outside it needs an
  explicit `font-sans`.
- **verify a real build**: the embed only takes effect after a native build
  (`npx expo prebuild` + run on device/simulator) — it can't be exercised by
  jest or Metro alone. Check **both** platforms: a missing family falls back to
  the system face without complaint, so Roboto on Android looks like "a font"
  unless you compare it with iOS. The quick tell is weight: the links screen's
  empty-state heading ("No links yet", `font-medium`) must read heavier than the
  body line under it.

#### runtime polyfills

`@stxapps/shared`'s byte encodings (`crypto/encoding.ts`) call the standard
`atob`/`btoa`/`TextEncoder`/`TextDecoder` globals. On Hermes/Expo most are
already present — `TextEncoder` is built into Hermes and Expo's winter runtime
installs `TextDecoder` (`node_modules/expo/src/winter/runtime.native.ts`) — but
that runtime installs **neither `atob` nor `btoa`**, and Hermes ships neither
itself, so `base64ToBytes`/`bytesToBase64` would throw `ReferenceError` on
native. The app installs them once at startup in **`src/polyfills.ts`**,
imported for its side effects as the **first line of the native entries**
(`index.js` and the iOS extension's `index.share.js`), ahead of
`expo-router/entry` and the share root — so the side effect lands before any app
code (the router tree, including `_layout.tsx`) evaluates. (This used to be the
first import of `src/app/_layout.tsx`; it moved to the entries when the
`index.js` shim was added for the share extension — see
[share-sheet.md](./share-sheet.md) — which is the true process start and covers
both bundles, so `_layout.tsx` no longer imports it.) They're backed by
the **native** Buffer (`@craftzdog/react-native-buffer`, C++-fast) rather than
the pure-JS `base-64` lib, since the images that flow through base64 are
multi-hundred-KB — see the rationale in `packages/shared/src/crypto/encoding.ts`.
`@craftzdog/react-native-buffer` is declared in `apps/bracemark-expo/package.json`
so the app doesn't lean on hoist order — as `*`, with the version pinned once at
the workspace root (`^6.1.2`), the same root-pin + app-`*` convention the other
RN native deps use (`react-native-quick-base64`, `react-native-quick-crypto`).
This can only be exercised on a native build, not jest/Metro.

The same file installs **`crypto.getRandomValues`**. Hermes has no `crypto`
global at all and the winter runtime installs none, so the two secrets
`@stxapps/shared` mints in platform-agnostic code — `generatePassphrase`
(`crypto/passphrase.ts`, the create-account default) and `generateRecoveryCode`
(`crypto/recovery-code.ts`) — crash the create-account screen on mount with
`ReferenceError: Property 'crypto' doesn't exist`. @noble/hashes' `randomBytes`
reads `globalThis.crypto` **once at module init**, so this belongs at the entry
rather than behind the first caller. It is backed by `react-native-quick-crypto`'s
native CSPRNG (already a dependency of `@stxapps/expo-crypto`, so no new native
module) — but **not** via quick-crypto's own `install()`, which assigns the whole
module to `global.crypto` and also replaces `global.Buffer`. The `require` is
**lazy and memoized**, for the same reason as `newId`'s in
`packages/expo-crypto/src/lib/ids.ts`: `polyfills.ts` is also the first import of
`index.share.js`, and a static import would drag quick-crypto's ~390KB of JS into
the init of the iOS share extension's process, which is re-created on every share
([share-sheet.md](./share-sheet.md), _keep `index.share.js` lean_). The shim is
deliberately partial — no `subtle`, no `randomUUID` (native ids go through
expo-crypto's `newId`).

Last in the file, and **only under `__DEV__`**, comes the **audit**: a list of
every global the platform-agnostic packages are allowed to assume, checked
against this engine, throwing at boot with the missing names. It is the runtime
half of the contract those packages are held to statically (see
[architecture.md](./architecture.md), _the globals a `platform:agnostic` package
may assume_) — lint refuses a global that isn't portable, the audit catches one
that is supposed to be portable and turns out to be missing here. That gap is
exactly what shipped the `crypto` crash, and it is not hypothetical maintenance:
every name in the list that isn't ours comes from Hermes or Expo's winter runtime
(`node_modules/expo/src/winter/runtime.native.ts`, which installs `TextDecoder`,
`URL`, `URLSearchParams` and `structuredClone`), so an SDK upgrade can withdraw
one. The failure it replaces is a `ReferenceError` from whatever screen touches
the API first, three navigations deep and blamed on the feature; the audit names
it at launch instead. `__DEV__` is compile-time constant, so Metro drops the
whole block from release bundles — the share extension's cold boot pays nothing.
What it cannot see is import **order**: a module that reads `globalThis.crypto`
at its own init still loses if it evaluates before `polyfills.ts`, which is why
that import is first in both entries and not lazy.

**Present is not the same as fast.** The `TextDecoder` Expo installs is a
pure-JS port of the text-encoding polyfill: it copies its input into a reversed
token array and builds the result a character at a time. That is harmless for a
favicon's `<head>`, and it was most of the blob-decode cost on the data path. A
Hermes profile of a 1,000-link CSV export put 235 ms of its 279 ms of
`parseBlob` inside it. So `expo-react` decodes stored blobs and import files
with its own `lib/utf8.ts` (`decodeUtf8`), which produces `TextDecoder`'s exact
output (its spec holds it to Node's decoder, malformed input included) without
that overhead. The global is left alone: replacing it would change every
caller's semantics at once, including the streaming and `fatal` modes nothing
on the data path needs. Reach for `decodeUtf8` when decoding something
library-sized on native. See [data-lifecycle.md](./data-lifecycle.md),
_readings — expo_.
