module.exports = {
  displayName: '@stxapps/web-react',
  preset: '../../jest.preset.js',
  // This package IS the local store (Dexie over IndexedDB) plus the sync engine that
  // drives it, so every spec here needs an IndexedDB. fake-indexeddb/auto installs the
  // globals once per test file; each spec still clears the tables between cases.
  //
  // 'node', not 'jsdom': fake-indexeddb needs `structuredClone`, which the node
  // environment provides and jest-environment-jsdom does not. Nothing under test here
  // touches the DOM — a future spec that renders a hook can opt itself into jsdom with
  // an `@jest-environment jsdom` docblock (and would then have to polyfill the clone).
  testEnvironment: 'node',
  setupFiles: ['fake-indexeddb/auto'],
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: 'test-output/jest/coverage',
};
