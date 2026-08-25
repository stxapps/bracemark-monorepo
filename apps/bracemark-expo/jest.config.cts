/// <reference types="jest" />
/// <reference types="node" />

// preset: 'jest-expo', the babel transform, `watchman: false` and the
// transformIgnorePatterns allowlist all live in jest.expo-base.cjs, shared with
// @stxapps/expo-react (these two can't use jest.preset.js — see the comment
// there).
const expoJestConfig = require('../../jest.expo-base.cjs');

module.exports = {
  ...expoJestConfig({ babelConfig: __dirname + '/.babelrc.js' }),
  displayName: '@stxapps/bracemark-expo',
  setupFilesAfterEnv: ['<rootDir>/src/testing/setup.ts'],
  // Never scan build output: `typecheck` (tsc --build) emits declaration files
  // under out-tsc/, and a `.spec.d.ts` there matches jest's default testMatch —
  // running it as an empty suite fails with "must contain at least one test".
  testPathIgnorePatterns: ['/node_modules/', '/out-tsc/'],
  moduleNameMapper: {
    '[.]svg$': '@nx/expo/plugins/jest/svg-mock',
    '[.]css$': '<rootDir>/src/testing/css-mock.js',
    // expo-router/testing-library (renderRouter) deep-imports a jest-30 path
    // that no longer exists — see the mock for what it stands in for.
    '^expect/build/matchers$': '<rootDir>/src/testing/expect-matchers-mock.js',
  },
  coverageDirectory: '../../coverage/apps/bracemark-expo',
};
