## nx monorepo setup

> How this workspace was scaffolded — run-once history, kept so a regenerated
> project can be compared against what the generators originally produced.
>
> This file used to also carry bracemark-expo's whole native story; that moved out
> when it outgrew "setup". The living references are
> [expo-native-deps.md](./expo-native-deps.md) (what each expo dependency is
> for and how it's wired) and [expo-build.md](./expo-build.md) (prebuild,
> app config, the npm scripts, R8, signing). For libs & dependency rules, see
> [architecture.md](./architecture.md).

#### init

- npx create-nx-workspace@latest
- npx nx add @nx/next
- npx nx g @nx/next:app apps/bracemark-web
- cd apps
- npx wxt@latest init bracemark-extension
- cd .. && npm i
- claude manually create bracemark-api file by file
- ask claude to generate like:
  npx nx g @nx/js:lib --directory=packages/shared --importPath=@stxapps/shared --bundler=none --linter=eslint --unitTestRunner=jest --minimal
- ask claude to generate like:
  npx nx g @nx/react:lib --directory=packages/web-ui --importPath=@stxapps/web-ui --bundler=none --linter=eslint --unitTestRunner=jest --minimal
- ask claude to generate like:
  npx nx g @nx/react:lib --directory=packages/react --importPath=@stxapps/react --bundler=none --linter=eslint --unitTestRunner=jest --minimal --no-component
- npx nx g @nx/react:lib --directory=packages/web-crypto --importPath=@stxapps/web-crypto --bundler=none --linter=eslint --unitTestRunner=jest
  --minimal --no-component
- npx nx g @nx/react:lib --directory=packages/web-react --importPath=@stxapps/web-react --bundler=none --linter=eslint --unitTestRunner=jest
  --minimal --no-component

Flag notes:

- `--bundler=none` — libs are consumed directly as TS source through the
  workspace; no per-lib build step.
- `--importPath=@stxapps/*` — npm scope is `@stxapps`; product name is bracemark.
- `--no-component` on `react`, `web-crypto`, and `web-react` — those libs are
  hooks/logic/crypto, no UI components (unlike `web-ui`).

#### shadcn

- npx shadcn@latest add <component> -c packages/web-ui
- npx shadcn@latest add button -c packages/web-ui --overwrite
- npx shadcn@latest add input -c packages/web-ui
- npx shadcn@latest add card -c packages/web-ui
- npx shadcn@latest add accordion -c packages/web-ui
- npx shadcn@latest add checkbox -c packages/web-ui
- npx shadcn@latest add label -c packages/web-ui
- npx shadcn@latest add field -c packages/web-ui
- npx shadcn@latest add select -c packages/web-ui
- npx shadcn@latest add textarea -c packages/web-ui

#### expo

- npx nx add @nx/expo
- npx nx g @nx/expo:app bracemark-expo --directory=apps/bracemark-expo --importPath=@stxapps/bracemark-expo
- `packages/expo-crypto` was written by hand (no generator): the usual lib
  files following the other packages' conventions, PLUS the Expo native module
  pieces `create-expo-module` would scaffold — `expo-module.config.json`,
  `ios/BracemarkCrypto.podspec` + Swift, `android/build.gradle` + Kotlin. One pod
  (`BracemarkCrypto`, source-file glob — a new `.swift` needs no podspec edit)
  hosts two Apple modules: `BracemarkFileCrypto` and the iOS-only
  `BracemarkSharedKeychain`.
  Native code is picked up by Expo autolinking from the workspace symlink in
  `node_modules` during `npx expo prebuild` (dev client required — not Expo Go).
- `packages/expo-react` was also written by hand (no generator), mirroring
  `web-react`'s package conventions (source-exports `package.json`, `nx.tags`,
  solution-style tsconfigs) with bracemark-expo's test setup (`jest-expo` preset +
  `babel-preset-expo`; the babel file is `.babelrc.cjs`, not `.js`, because
  the package is `"type": "module"`). Native modules it builds on
  (`expo-sqlite`, `expo-file-system`, `expo-secure-store`, NetInfo) are
  peerDependencies — bracemark-expo owns them so Expo autolinking sees them. The
  version each slot declares (root pins, everyone else defers) is
  [architecture.md](./architecture.md) — _dependency versions_.
- **No EAS.** Builds are local — `npx expo prebuild` then Xcode / Gradle (or
  `expo export`) — so there is no `eas.json` and none is needed. The generator's
  `eas-build-post-install` script in the app's `package.json` (and its
  `tools/scripts/eas-build-post-install.mjs`, which symlinked the workspace
  `node_modules` for EAS Build's isolated checkout) were deleted as dead code;
  that lifecycle hook only ever runs on EAS. If you re-run an `@nx/expo`
  generator, drop the script again. What stays is `nx.json`'s
  `"buildTargetName": "eas-build"` — that's **not** leftover EAS wiring but a
  guard: it renames @nx/expo's inferred `eas build` target away from `build`, so
  `npm run build` (an `nx run-many -t build`) can't fire an EAS build.
- Note: `jest-expo` ships a bin literally named `jest`, colliding with the real
  jest CLI in `node_modules/.bin` — whichever npm links last wins. The root
  `postinstall` (`tools/scripts/fix-jest-bin.mjs`) re-points the bin at the
  real jest 30 deterministically (every project, including bracemark-expo with the
  jest-expo _preset_, runs fine on it; only the _bin_ is the trap).

###### build

- (generate a keystore for uploading)
- npm run prebuild
- open Bracemark.xcworkspace on Xcode
  - targets: Bracemark, on General: update Version, App Category: Productivity, Display Name: Bracemark
  - targets: SavetoBracemark, on Signing & Capabilities, select team
  - targets: SavetoBracemark, on General: update Version, Miminum iOS, Display Name: Save to Bracemark
- cd android
  - ./gradlew bundleRelease

#### bracemark-site (the marketing apex)

Replaces an earlier planned `apps/bracemark-docs` — docs are a path on the apex
now, not their own host (architecture.md — _apps_).

- npx nx g @nx/next:app apps/bracemark-site --name=@stxapps/bracemark-site
  --linter=eslint --unitTestRunner=jest --e2eTestRunner=none
  --tags=type:app,platform:web
- Run at the time with an extra `--style=css`, because nx.json's `generators`
  block still defaulted `@nx/next.application.style` to `tailwind` — a value
  @nx/next 23 rejects outright (`Property 'style' does not match the schema`),
  so **any** `nx g @nx/next:app` failed until the flag was passed. That default
  has since been corrected to `css` in nx.json, so the flag is no longer needed
  and the command above is what to run now. Tailwind is not a generator concern
  here anyway: it's wired up afterwards the way bracemark-web does it —
  `postcss.config.js` + `@tailwindcss/postcss`, and a `globals.css` that imports
  `@stxapps/web-ui/styles.css`.
- The generator's output was then reshaped to match bracemark-web: static export
  in next.config.js, the `nx.targets` block (dev on port 3001, `start` /
  `serve-static` repointed off `next start` — see
  [hosting.md](./hosting.md#previewing-a-production-build-locally--nx-start)
  — and the `staging` build configuration), tsconfig `references` to shared +
  web-ui, and the ESM-packages patch in jest.config.cts.

#### serwist

- npm install serwist -w @stxapps/bracemark-web
- npm install @serwist/next -w @stxapps/bracemark-web
- npm install @serwist/cli --save-dev -w @stxapps/bracemark-web

#### wrangler

- rm -rf apps/bracemark-api/.wrangler/state/v3/d1 or rm -rf apps/bracemark-api/.wrangler/state
- npm run d1:migrate (was `nx run bracemark-api:migrate`; the target is now `d1-migrate`
  on `@stxapps/bracemark-api`, because `nx migrate` is a built-in Nx command)
