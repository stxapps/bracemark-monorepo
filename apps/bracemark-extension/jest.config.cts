// The extension's jest project — jsdom, like the other two web surfaces, because
// everything worth asserting here either renders (the popup / options React trees)
// or reads the DOM (utils/capture.ts's injected collectors, which this suite runs
// against jsdom rather than mocking their return values).
//
// The transform pair is web-ui's, not the preset's: `jest.preset.js` inherits
// `@nx/jest/preset`, whose transform key covers `.ts` but NOT `.tsx`, and every
// component spec here is `.tsx`. babel over ts-jest for the same reason web-ui
// picked it — the packages are consumed as raw source (`exports` points at
// `src/*.ts`), so a spec's module graph is full of workspace TypeScript that
// only needs stripping, not a second typecheck (that is `npm run typecheck`'s job).
module.exports = {
  displayName: '@stxapps/bracemark-extension',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  // WXT's `browser` / `defineBackground` are AUTO-IMPORTS: the source files use
  // them as bare globals and WXT's vite plugin rewrites them at build time. There
  // is no such rewrite under jest, so they have to be real globals — testing/setup.ts
  // installs a fresh fake before every test.
  setupFilesAfterEnv: ['<rootDir>/testing/setup.ts'],
  moduleNameMapper: {
    // `utils/web-app-url.ts` branches on `import.meta.env.MODE`, which cannot be
    // compiled to CommonJS at all (babel throws on `import.meta` in a CJS output).
    // It is pure build-mode config with nothing to assert, so the whole module is
    // swapped for the value the development build resolves to. Must precede the
    // general `@/` rule below — jest takes the first pattern that matches.
    '^@/utils/web-app-url$': '<rootDir>/testing/web-app-url.ts',
    // WXT's alias (see .wxt/tsconfig.json): `@/` is the PROJECT root, not `src/`.
    '^@/(.*)$': '<rootDir>/$1',
  },
  // Generated build output. `.output` in particular contains bundled copies of
  // this source, which jest-haste-map would otherwise index as duplicate modules.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.output/', '<rootDir>/.wxt/'],
  modulePathIgnorePatterns: ['<rootDir>/.output/'],
  coverageDirectory: 'test-output/jest/coverage',
};
