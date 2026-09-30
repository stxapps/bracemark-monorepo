module.exports = {
  displayName: '@stxapps/react',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  // Every render double-mounts, like the app does — see the file for why.
  setupFilesAfterEnv: ['../../jest.react-strict-mode.cjs'],
  coverageDirectory: 'test-output/jest/coverage',
};
