const { readFileSync } = require('fs');

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@stxapps/expo-crypto',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
  // The native pieces can't run under jest: react-native-quick-crypto is JSI
  // (needs a real RN runtime), so specs run against a Node-crypto-backed shim
  // with the SAME API — the point of the specs is the frozen-contract math in
  // OUR code (param mapping, tag placement, wire format), not quick-crypto's
  // internals. The BracemarkFileCrypto native module is exercised on-device against
  // the same shared vectors instead (see src/lib/file-crypto.ts).
  moduleNameMapper: {
    '^react-native-quick-crypto$': '<rootDir>/src/testing/quick-crypto-node-shim.ts',
  },
};
