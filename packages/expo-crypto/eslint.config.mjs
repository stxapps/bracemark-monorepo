import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      // Same options as the root config, plus src/testing/** — the jest-only
      // quick-crypto shim imports dev tooling (hash-wasm, node:crypto) that
      // must not become package dependencies.
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs}',
            '{projectRoot}/*.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/specs/**/*',
            '{projectRoot}/**/*.spec.{ts,tsx}',
            '{projectRoot}/src/testing/**/*',
          ],
          checkObsoleteDependencies: false,
        },
      ],
    },
  },
];
