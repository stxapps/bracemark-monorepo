## dependency upgrades

Version bumps that are a **plan** rather than a rule — what currently caps the
Expo SDK, when that cap is expected to lift, why Xcode and macOS wait for it, and how to run `nx migrate` without
letting it drag the SDK along with it. For which manifest is allowed to state a
version at all, see [architecture.md](./architecture.md) — _dependency
versions_; for what each expo dependency is and how it's wired,
[expo-dependencies.md](./expo-dependencies.md); for the build itself,
[expo-build.md](./expo-build.md).

**Everything here is dated on purpose.** The invariants in `architecture.md`
hold until the design changes; the findings below are research against
third-party release state and go stale on their own. Re-verify anything with a
date on it before acting on it, and re-date it when you do.

#### what caps the Expo SDK is `expo-share-extension`, not Nx or Expo

Re-researched 2026-11-06 (first written 2026-07-31, when the answer was
`@nx/expo`). The repo is on **Expo SDK 54 / RN 0.81.5 / React 19.1.0** and
**Nx 23.1.1**.

**Expo and React Native are not the wait.** RN **0.88.1** is npm `latest` (0.89
is at RC), and **SDK 58** (GA 2026-09-29) ships it — `react-native: 0.88.1` in
its `bundledNativeModules.json`. SDK 57 (GA 2026-06-30) is RN 0.86.

**Nx is a soft gate, not a hard one.** The `@nx/expo` history:

- `@nx/expo@22.x` — lanes for SDK 53/54 only. Its `withNxMetro` and its
  `metro-resolver` plugin do a bare `require('metro-config')` /
  `require('metro-resolver')`, and **SDK 55+ moved Metro into `@expo/metro`**
  (subpath exports only), so SDK 55/56 on Nx 22 breaks the Metro config.
- `@nx/expo@23.1.x` — lanes for 53–56, default 56, and a
  `minSupportedExpoVersion` of `53.0.0`. It prefers `@expo/metro/metro-config`
  with a `metro-config` fallback, so SDK 54 keeps working after the Nx 23 bump.
- `@nx/expo@24.0.4` (2026-10-21, the newest) — its newest lane is **still SDK
  56** (`expoVersion = "~56.0.0"`); nothing for 57 or 58 (nrwl/nx#36443). Its
  peers are open-ended, though: `expo >=53.0.0`, `@expo/metro >=55.0.0`.

A lane is what Nx's generators and `nx migrate` write, not what its runtime
accepts. What this workspace actually takes from `@nx/expo` is four small
things: `withNxMetro` (`apps/bracemark-expo/metro.config.js`), the jest svg mock
(`jest.config.cts`), the svg `.d.ts` (`tsconfig.app.json`), and the
`start`/`prebuild` executors ([architecture.md](./architecture.md), _dependency
versions_). Each has a plain-Expo replacement — Expo's own Metro config has
resolved npm-workspace monorepos by itself since SDK 52; the mock and the typings
are a few lines each; the targets can be `expo` scripts. So if `withNxMetro`
fails on SDK 58, **replace it rather than wait for a lane**. Untried as of this
date.

#### the app-side blocker — `expo-share-extension`, and the plan: vendor it

Its stable ceiling is **5.0.6 = SDK 54**. Only `6.0.0-beta` (published
2026-02-23, described as "for testing with expo v55") goes further. The iOS
**share extension** — the share sheet target inside `bracemark-expo`, not the
browser extension ([share-sheet.md](./share-sheet.md)) — is a shipped feature,
so this gates the SDK regardless of what Nx supports.

**Treat it as unmaintained** (checked 2026-11-06). Last commit 2026-04-12, last
release 2026-02-23, and the open issues that matter to us have no maintainer
reply: SDK 56 support (#119), a boot crash on SDK 57 —
`Cannot read property 'EventEmitter' of undefined`, `globalThis.expo` never
installed (#121) — a blank sheet when sharing from third-party apps (#122), and
an `RCTThirdPartyComponentsProvider` crash on the New Architecture (#117).

**Decided 2026-11-06: vendor it** (MIT). The share UI is already ours
(`ShareRoot`/`ShareScreen`); what the package supplies is the config plugin that
adds the extension target to the Xcode project, the Swift view controller that
boots an RN instance in the extension process, and the `withShareExtension`
Metro wrapper. Four local plugins (`plugins/with-share-extension-*`) already
patch its output, so part of it is ours already. Bring it into
`apps/bracemark-expo` — the iOS twin of `modules/bracemark-share` on Android —
**while still on SDK 54**, prove the sheet behaves exactly as before, and only
then fix it forward to 58, using #117/#119/#121 as the map. Not yet started.

Weighed and set aside:

- **`@bacons/apple-targets`** (MIT, by an Expo team member, 5.0.0 in July 2026)
  for the Xcode target, with our own RN-booting view controller. The fallback if
  the target generation — the part that breaks across Xcode versions — becomes
  the recurring cost. It means rewriting the four patch plugins against it, and
  the RN boot code is ours either way.
- **`expo-sharing`'s incoming-share support** (official, SDK 58). On iOS its
  extension opens the main app instead of presenting a sheet, which Expo's own
  docs call unsupported by Apple and liable to break in a future iOS. It loses
  the floating sheet over Safari.
- **A native SwiftUI sheet, no RN.** Lightest in the extension's memory budget,
  but a second share UI to keep in step with Android's. Last resort.

#### Xcode 27 and macOS 27 follow the SDK bump, not the other way round

Researched 2026-11-06. Release builds are archived and uploaded from the local
Xcode ([expo-build.md](./expo-build.md), _ios release_), so the dev Mac's Xcode
is the shipping toolchain. **Stay on Xcode 26.6 (and macOS 26) to ship until the
SDK bump lands.** RN ≤ 0.87 built with Xcode 27 has known failures:

- UIKit requires the UIScene lifecycle for apps built against the iOS 27 SDK —
  blank screen or crash on launch (expo/expo#46663, #46664;
  react/react-native#58545);
- Xcode 27 replaced Simulator.app with DeviceHub.app, which breaks `expo run:ios`
  (expo/expo#46882);
- the minimum deployment target rises to iOS 15.0, which trips pods whose
  resource bundles declare less.

Xcode 27 itself runs on macOS 26.6+, so it can sit beside 26.6 for trials —
download the `.xip` from developer.apple.com as `Xcode-27.app` (an App Store
update would replace `Xcode.app`) and switch with `DEVELOPER_DIR` or
`xcode-select`. **Whether Xcode 26.6 runs on macOS 27 is unconfirmed** — one
field report says yes, a third-party table says unsupported, Apple says nothing
— and a macOS downgrade is an erase-and-reinstall, so the OS upgrade waits for
the Xcode move.

**The clock that could force this early** is Apple's iOS 27 SDK upload
requirement, typically around April. If it arrives before the vendored share
extension reaches SDK 58, SDK 54 has to build with Xcode 27 — the UIScene
patch at least (the unofficial `react-native-xcode27` shows the shape). Find out
how much that is with a side-by-side Xcode 27 build before then, not at the
deadline.

#### the Play Store deadline is not a reason to move

API 36 is required by **2026-08-31**, with a deferral available to 2026-11-01 —
and **SDK 54 already targets 36** (the RN 0.81 default), so nothing is owed. The
next pressure is ~API 37 around Aug 2027.

#### the target window

**SDK 58 / RN 0.88, skipping 55–57**, once the vendored share extension runs on
it (re-decided 2026-11-06; it was SDK 56, waiting on a stable 6.x of
`expo-share-extension`). Move the SDK by hand, not through `nx migrate` — Nx's
newest lane is 56, so it would drag the SDK to the wrong place (_running
`nx migrate`_, below). Re-verify at that point:

- the hand-written `BraceCrypto` pod against `expo-modules-core` — which
  renumbers to 58.x under unified versioning (`~58.0.30` in SDK 58), and note
  that 55+ uses a tilde where SDK 54 used an exact pin
  ([architecture.md](./architecture.md), _dependency versions_, for why a
  second opinion on that package nests a duplicate);
- `react-native-quick-crypto` + `nitro-modules`;
- `expo-iap`, pinned `^4.7.0` here — it is at 6.4.3 as of 2026-11-06;
- `withNxMetro` on SDK 58 (_what caps the Expo SDK_, above);
- a Release build from **Xcode 27** launching on iOS 27 — RN 0.88 is expected to
  carry the UIScene fix, but that is unverified here.

**The bump also fixes a bug, so prove it rather than assume it** (researched
2026-09-24). On Android, changing the OS text size while the app is running
leaves every Text measured before the change at its OLD height, painted at the
new size — the links list clipped to unreadable, titles through hosts, until a
cold start. Text first measured after the change is correct. The cause is RN
0.81's `enableFontScaleChangesUpdatingLayout` feature flag, `false` in 0.81.5 and
in none of its release levels: with it off, `ReactSurfaceImpl` hands Fabric a
font scale of `1` whatever the device says, and `TextMeasureCache` keys on that
multiplier, so a stale measurement is still a cache hit. **RN 0.82.0 defaults it
to `true`**, so any SDK on RN ≥ 0.82 fixes it with no code of ours. Forcing it
on 0.81 was weighed and declined: it means overriding an experimental flag
through `com.facebook.react.internal.featureflags` from a config plugin
(`loadReactNative` installs its own provider, so only
`dangerouslyForceOverride` reaches it) — internal API, to repair a state a cold
start already clears, that the upgrade retires anyway. After the bump: cold
start at 1.0, raise the text size, return, and see the list re-measure — then
add that as a large-text visual checkpoint (`VISUAL-FONT-001`), which it could
not have been before, since it would only have photographed the bug. iOS was not
checked.

**The same bump retires a native module.**
`apps/bracemark-expo/modules/bracemark-input` exists only to set an ellipsize
mode on Android's single-line `EditText`, so a placeholder longer than its field
truncates instead of wrapping ([theme.md](./theme.md), _extending_). React
Native does that itself from **0.88** (`ReactEditText.updatePlaceholderEllipsize`;
absent from every release branch through 0.87), and SDK 58 carries 0.88.1. In
that bump: delete the module folder,
`src/lib/placeholder-ellipsis.ts` and its spec, and the `onLayout` wrapper in
`ui/input.tsx` — then open a link whose extracted title is longer than the Title
field, type a character, clear it, and see the placeholder still on one line.
Until then the module is harmless to leave in: it sets the same value upstream
would.

**Drop the `@expo/metro` override as part of that bump.** Root `package.json`
carries `"overrides": { "@nx/expo": { "@expo/metro": "~54.2.0" } }` only because
`@nx/expo@23.1.1` declares an optional peer `@expo/metro: ">= 55.0.0"` that
nothing on SDK 54 can satisfy; on SDK 55+ expo's own range satisfies it and the
override becomes dead weight. The full rationale — and why removing it later
doesn't repair a tree that was already re-solved without it — is
[architecture.md](./architecture.md), _dependency versions_.

#### running `nx migrate` — apply the `@nx/*` bumps, nothing else

Observed on the real Nx 22.7.8 → 23.1.1 run, 2026-07-31.

**`npx nx migrate latest` proposes far more than Nx.** Because `@nx/expo@23`'s
default lane is SDK 56, its `packageJsonUpdates` rewrote `package.json` to expo
`56.0.9`, react-native `0.85.3`, react `19.2.8`, plus `@expo/cli`,
`babel-preset-expo`, `jest-expo`, `@expo/metro-config`, `@expo/metro-runtime`,
`expo-splash-screen`/`-status-bar`/`-system-ui` — **and `typescript` 5.9 →
6.0.3**. It also flattened deliberate `~`/`^` ranges to exact pins on unrelated
packages (`metro-config`, `react-native-web`,
`@testing-library/react-native`, …).

So: after `nx migrate`, `git checkout package.json` and re-apply **only** the
`@nx/*` + `nx` version bumps, then `npm install`. On that run the three
`update-23-1-0-*-expo-56` migrations carried `requires: { expo: ">= 56.0.0" }`
and correctly no-opped once expo stayed at 54 — `metro.config.js` and the root
`metro-config`/`metro-resolver` deps were left untouched.

#### `requires` is not a gate — always diff the tsconfigs

On the same run, `@nx/js`'s `23-1-0-add-ignore-deprecations-for-ts6` and
`23-1-0-set-tsconfig-root-dir-for-ts6` both declare a `requires` of
`{ typescript: ">=6.0.0" }` and **ran anyway** against a TypeScript 5.9.3
workspace, with no nested TS 6 anywhere in the tree. They wrote
`ignoreDeprecations: "6.0"` into ~26 tsconfigs, plus
`noUncheckedSideEffectImports: false`, `types: ["*"]` and
`esModuleInterop: false` into `tsconfig.base.json` — TS 6 semantics, and wrong
on 5.9.

Nothing reports this: the migration run exits 0, and the values it writes look
deliberate in a diff. The fix was
`git checkout -- $(git diff --name-only | grep tsconfig)`; everything else that
run produced was a legitimate no-op. **After any
`nx migrate --run-migrations`, read the tsconfig diff before staging it.**
