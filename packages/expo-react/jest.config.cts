/// <reference types="jest" />
/// <reference types="node" />

// preset: 'jest-expo', the babel transform, `watchman: false` and the
// transformIgnorePatterns allowlist all live in jest.expo-base.cjs, shared with
// @stxapps/bracemark-expo (these two can't use jest.preset.js — see the comment
// there). `.babelrc.cjs`, not `.js`: this package is `"type": "module"`.
const expoJestConfig = require('../../jest.expo-base.cjs');

module.exports = {
  ...expoJestConfig({ babelConfig: __dirname + '/.babelrc.cjs' }),
  displayName: '@stxapps/expo-react',
  setupFilesAfterEnv: ['<rootDir>/src/testing/setup.ts'],
  coverageDirectory: 'test-output/jest/coverage',
};
