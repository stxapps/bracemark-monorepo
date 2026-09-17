## dependency upgrades

Version bumps that are a **plan** rather than a rule — what currently caps the
Expo SDK, when that cap is expected to lift, and how to run `nx migrate` without
letting it drag the SDK along with it. For which manifest is allowed to state a
version at all, see [architecture.md](./architecture.md) — _dependency
versions_; for what each expo dependency is and how it's wired,
[expo-dependencies.md](./expo-dependencies.md); for the build itself,
[expo-build.md](./expo-build.md).

**Everything here is dated on purpose.** The invariants in `architecture.md`
hold until the design changes; the findings below are research against
third-party release state and go stale on their own. Re-verify anything with a
date on it before acting on it, and re-date it when you do.

#### what caps the Expo SDK is `@nx/expo`, not Expo

Researched 2026-07-31. The repo is on **Expo SDK 54 / RN 0.81.5 / React 19.1.0**
and **Nx 23.1.1**, so the Nx-side prerequisite for SDK 56 is already met and the
remaining blocker is app-side (next section).

- `@nx/expo@22.x` — lanes for SDK 53/54 only. Its `withNxMetro` and its
  `metro-resolver` plugin do a bare `require('metro-config')` /
  `require('metro-resolver')`, and **SDK 55+ moved Metro into `@expo/metro`**
  (subpath exports only), so SDK 55/56 on Nx 22 breaks the Metro config.
- `@nx/expo@23.1.x` — lanes for 53–56, default 56, and a
  `minSupportedExpoVersion` of `53.0.0`. It prefers `@expo/metro/metro-config`
  with a `metro-config` fallback, so SDK 54 keeps working after the Nx 23 bump.
- **SDK 57 (GA 2026-06-30, RN 0.86) has no Nx lane** — nrwl/nx#36443.

#### the app-side blocker — `expo-share-extension`

Its stable ceiling is **5.0.6 = SDK 54**. Only `6.0.0-beta` (published
2026-02-23, described as "for testing with expo v55") goes further; nothing
covers 56 or 57. The iOS **share extension** — the share sheet target inside
`bracemark-expo`, not the browser extension ([share-sheet.md](./share-sheet.md))
— is a shipped feature, so this gates the SDK regardless of what Nx supports.

#### the Play Store deadline is not a reason to move

API 36 is required by **2026-08-31**, with a deferral available to 2026-11-01 —
and **SDK 54 already targets 36** (the RN 0.81 default), so nothing is owed. The
next pressure is ~API 37 around Aug 2027.

#### the target window

**Nx 23.1+ with SDK 56, skipping 55**, once `expo-share-extension` ships a stable
6.x that covers it. Re-verify at that point:

- the hand-written `BraceCrypto` pod against `expo-modules-core` — which
  renumbers to 56/57.x under unified versioning, and note 56/57 use a tilde where
  SDK 54 used an exact pin ([architecture.md](./architecture.md), _dependency
  versions_, for why a second opinion on that package nests a duplicate);
- `react-native-quick-crypto` + `nitro-modules`;
- `expo-iap`, pinned `^4.7.0` here — 5.0.0 landed 2026-07-30.

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
