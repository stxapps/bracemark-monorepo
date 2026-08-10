const nextJest = require('next/jest.js');

const createJestConfig = nextJest({
  dir: './',
});

const config = {
  displayName: '@stxapps/bracemark-web',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/bracemark-web',
  testEnvironment: 'jsdom',
};

const jestConfig = createJestConfig(config);

// ESM-only deps (raw `export` syntax) that live in node_modules and must be
// transpiled by jest. next/jest ignores all of node_modules by default and
// derives exceptions from Next's `transpilePackages`, so we patch the resolved
// `transformIgnorePatterns` here instead of via the user config (which next/jest
// only appends — it can't relax the base `/node_modules/` ignore). Shared with
// the rest of the workspace via jest.esm-packages.cjs.
const esmNodeModules = require('../../jest.esm-packages.cjs');

module.exports = async () => {
  const resolved = await jestConfig();
  // Disable SWC path alias resolution — handled by Nx jest resolver.
  for (const value of Object.values(resolved.transform)) {
    if (Array.isArray(value) && value[1]?.resolvedBaseUrl) {
      value[1] = { ...value[1], resolvedBaseUrl: undefined };
    }
  }
  // next/jest builds the node_modules ignore as a negative lookahead seeded from
  // Next's `transpilePackages` (e.g. `(?!(geist)/)` and `.pnpm/(?!(geist)@)`).
  // Inject our ESM packages into those alternations so they get transpiled too.
  const extra = esmNodeModules.join('|');
  resolved.transformIgnorePatterns = (resolved.transformIgnorePatterns ?? []).map(
    (pattern: string) =>
      pattern
        .replace(/\(\?!\(([^)]*)\)\/\)/, (_m: string, g: string) => `(?!(${g}|${extra})/)`)
        .replace(/\(\?!\(([^)]*)\)@\)/, (_m: string, g: string) => `(?!(${g}|${extra})@)`),
  );
  return resolved;
};
