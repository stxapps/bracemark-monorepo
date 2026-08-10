const nextJest = require('next/jest.js');

const createJestConfig = nextJest({
  dir: './',
});

const config = {
  displayName: '@stxapps/bracemark-site',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/bracemark-site',
  testEnvironment: 'jsdom',
};

const jestConfig = createJestConfig(config);

// ESM-only deps (raw `export` syntax) that live in node_modules and must be
// transpiled by jest. Same patch as apps/bracemark-web/jest.config.cts — see the
// long comment there for why it's applied to the RESOLVED config rather than the
// user one. Shared with the rest of the workspace via jest.esm-packages.cjs.
const esmNodeModules = require('../../jest.esm-packages.cjs');

module.exports = async () => {
  const resolved = await jestConfig();
  // Disable SWC path alias resolution — handled by Nx jest resolver.
  for (const value of Object.values(resolved.transform)) {
    if (Array.isArray(value) && value[1]?.resolvedBaseUrl) {
      value[1] = { ...value[1], resolvedBaseUrl: undefined };
    }
  }
  const extra = esmNodeModules.join('|');
  resolved.transformIgnorePatterns = (resolved.transformIgnorePatterns ?? []).map(
    (pattern: string) =>
      pattern
        .replace(/\(\?!\(([^)]*)\)\/\)/, (_m: string, g: string) => `(?!(${g}|${extra})/)`)
        .replace(/\(\?!\(([^)]*)\)@\)/, (_m: string, g: string) => `(?!(${g}|${extra})@)`),
  );
  return resolved;
};
