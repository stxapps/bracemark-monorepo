// The shared half of a jest-expo project's jest config (bracemark-expo,
// expo-react). Those two can't use jest.preset.js the way every other project
// does — `preset` takes exactly one value and it has to be `jest-expo`, for its
// react-native transform, its module mapping and its asset transformer — so
// everything jest.preset.js would have handed them is restated here, once,
// instead of twice over.
//
// This is NOT itself a jest preset: it exports a factory, because the babel
// config path is per-project. Spread the result into `module.exports`; never
// point a `preset:` at this file. `preset: 'jest-expo'` is part of what it
// returns, so jest still runs its own preset merge — project keys win,
// preset-only keys survive (jest-config's `mergeOptionWithPreset`).
//
// Consumed by:
//   - apps/bracemark-expo/jest.config.cts
//   - packages/expo-react/jest.config.cts

const esmNodeModules = require('./jest.esm-packages.cjs');

/**
 * @param {{ babelConfig: string }} options `babelConfig` is the absolute path to
 *   the project's own babel config (`.babelrc.js`, or `.babelrc.cjs` in a
 *   `"type": "module"` package).
 */
module.exports = ({ babelConfig }) => ({
  preset: 'jest-expo',
  moduleFileExtensions: ['ts', 'js', 'html', 'tsx', 'jsx'],
  // jest-haste-map's watchman crawl `syncToNow`s over the watch root, which
  // here is the whole monorepo; once the fsevents queue overflows that sync
  // never lands and the run burns the full 60s timeout before falling back to
  // the node crawler anyway. `watchman` is a *global* jest option, so it only
  // takes effect on the config jest is actually invoked with — under
  // `nx run-many -t test` that is this project's config, never the root
  // jest.config.ts, and a jest-expo project never sees jest.preset.js's copy
  // either. See the longer comment in jest.preset.js.
  watchman: false,
  transform: {
    // `[cm]?` so `.mjs` is transformed too: an allowlisted ESM-only dep is no
    // use if its entry file's extension never matches the transform (
    // lucide-react-native resolves to dist/esm/*.mjs under the `react-native`
    // export condition).
    '[.][cm]?[jt]sx?$': [
      'babel-jest',
      {
        // Restate jest-expo's babel `caller` — overriding its transform entry
        // drops it, and babel-preset-expo keys the `process.env.EXPO_OS` inline
        // off `caller.platform`. Without it every occurrence is replaced by a
        // literal `undefined` (not left alone), so expo-modules-core's
        // Platform.ts warns "The global process.env.EXPO_OS is not defined."
        // on any suite that pulls in expo (e.g. via expo-router).
        //
        // Note this runtime cannot service a real `import()`: jest's CJS vm
        // throws "A dynamic import callback was invoked without
        // --experimental-vm-modules", and neither babel-preset-expo nor
        // @react-native/babel-preset lowers one to a require() (verified — the
        // `supportsDynamicImport: false` caller flag that would do it elsewhere
        // is simply not read by either preset). That is why native code that
        // wants a deferred load spells it `require()` at the call site rather
        // than `import()` — see the lazy requires in expo-react's
        // data/share-store.ts and the note on bracemark-expo's
        // features/auth/password-strength.tsx.
        caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
        configFile: babelConfig,
      },
    ],
    '^.+[.](bmp|gif|jpg|jpeg|mp4|png|psd|svg|webp|ttf|otf|m4v|mov|mp4|mpeg|mpg|webm|aac|aiff|caf|m4a|mp3|wav|html|pdf|obj)$':
      require.resolve('jest-expo/src/preset/assetFileTransformer.js'),
  },
  // jest-expo's preset only babel-transforms an allowlist of node_modules;
  // extend it with the ESM-only deps (jest.esm-packages.cjs — e.g.
  // fractional-indexing via @stxapps/shared's barrel, @noble/ed25519 via
  // @stxapps/expo-crypto), or their `export` syntax breaks require(). Metro has
  // no such allowlist, so runtime needs nothing. @rn-primitives
  // (react-native-reusables' primitives) ships raw JSX in its dist like the RN
  // packages do, so it joins the allowlist too.
  transformIgnorePatterns: [
    `/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|@rn-primitives|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|${esmNodeModules.join('|')}))`,
    '/node_modules/react-native-reanimated/plugin/',
  ],
});
