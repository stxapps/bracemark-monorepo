const nxPreset = require('@nx/jest/preset').default;
const esmNodeModules = require('./jest.esm-packages.cjs');

// passWithNoTests: packages can be generated before they have specs; a project
// with zero test files should be green, not a hard jest exit-1 (was failing
// `npm run test` for the not-yet-tested libs).
module.exports = {
  ...nxPreset,
  passWithNoTests: true,
  // Transpile ESM-only deps (see jest.esm-packages.cjs) instead of ignoring
  // them. Inherited by every preset-based package; a package that sets its own
  // `transformIgnorePatterns` would override this, so don't.
  transformIgnorePatterns: [
    `/node_modules/(?!(?:${esmNodeModules.join('|')})/)`,
    '\\.pnp\\.[^\\/]+$',
  ],
  // jest-haste-map crawls with its own node crawler instead of asking watchman.
  // Watchman's watch here is the whole monorepo root, so every `npm run test`
  // made each project `syncToNow` over the full tree (node_modules included);
  // once the fsevents queue overflows (`MustScanSubDirs UserDropped`) that sync
  // never lands and jest burns the full 60s timeout per project before falling
  // back to this crawler anyway. The crawl is ~1s per package, so watchman was
  // only ever a liability. Do NOT "fix" this by adding node_modules to
  // .watchmanconfig's ignore_dirs — Metro needs the symlinked @stxapps/*
  // packages under there watched for expo HMR.
  watchman: false,
};
