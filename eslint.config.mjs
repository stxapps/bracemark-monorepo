import nx from '@nx/eslint-plugin';
import jsoncParser from 'jsonc-eslint-parser';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import prettier from 'eslint-config-prettier/flat';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/.wrangler'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [
            '^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$',
            // web-ui is a shadcn component library: components self-import its
            // own subpaths (e.g. lib/utils) and apps deep-import components.
            '@stxapps/web-ui/**',
          ],
          depConstraints: [
            // Layering (type): shared <- crypto <- react <- ui <- app.
            // A project may only depend on its own layer and lower ones.
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:app',
                'type:ui',
                'type:react',
                'type:crypto',
                'type:shared',
              ],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui', 'type:react', 'type:shared'],
            },
            {
              sourceTag: 'type:react',
              onlyDependOnLibsWithTags: ['type:react', 'type:crypto', 'type:shared'],
            },
            {
              sourceTag: 'type:crypto',
              onlyDependOnLibsWithTags: ['type:crypto', 'type:shared'],
            },
            {
              sourceTag: 'type:shared',
              onlyDependOnLibsWithTags: ['type:shared'],
            },
            // Platform: agnostic code must stay portable; web/worker/expo may
            // also use agnostic libs but never each other's. This keeps
            // web-only libs (ui, web-crypto) out of the Cloudflare Workers api
            // and out of the Expo app, and expo-only libs out of everything
            // that isn't Expo.
            {
              sourceTag: 'platform:agnostic',
              onlyDependOnLibsWithTags: ['platform:agnostic'],
            },
            {
              sourceTag: 'platform:web',
              onlyDependOnLibsWithTags: ['platform:web', 'platform:agnostic'],
            },
            {
              sourceTag: 'platform:worker',
              onlyDependOnLibsWithTags: ['platform:worker', 'platform:agnostic'],
            },
            {
              sourceTag: 'platform:expo',
              onlyDependOnLibsWithTags: ['platform:expo', 'platform:agnostic'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    // Override or add rules here
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'], // side-effect imports
            ['^node:'], // node builtins
            ['^react', '^@?\\w'], // external packages, react first
            ['^@stxapps/'], // internal workspace packages
            ['^\\.\\.(?!/?$)', '^\\.\\./?$', '^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // relative
            ['^.+\\.s?css$'], // styles last
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['**/*.json'],
    languageOptions: {
      parser: jsoncParser,
    },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          // Build/test/config files aren't shipped — their imports (wxt, vite,
          // eslint, jest, testing-library, next plugins) are dev tooling.
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs}',
            '{projectRoot}/*.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/specs/**/*',
            '{projectRoot}/**/*.spec.{ts,tsx}',
          ],
          // Apps render via the automatic JSX runtime and pull framework
          // runtime deps (react, react-dom, next) in without a direct import,
          // so the "obsolete dependency" direction only yields false positives.
          // Keep the valuable guard: imported packages must be declared.
          checkObsoleteDependencies: false,
          // expo-modules-core is provided by the Expo SDK — a transitive of
          // `expo`, whose version the root package.json pins (~54). Expo reaches
          // it via require('expo-modules-core') (e.g. bracemark-expo's share-host
          // requireNativeModule), which trips this rule, but the app must NOT
          // declare its own pinned copy: that would drift from the SDK. Ignoring
          // it stops --fix from re-adding a pinned version to any app package.json
          // (same spirit as checkObsoleteDependencies: framework-provided runtime).
          ignoredDependencies: ['expo-modules-core'],
        },
      ],
    },
  },
  {
    // Expo local native modules (apps/bracemark-expo/modules/*) are Kotlin/Gradle +
    // autolinking manifests, not JS packages — their package.json exists only so
    // Expo autolinking discovers the module; runtime deps come from the host app.
    // They aren't separate Nx projects, so @nx/dependency-checks maps them to the
    // enclosing @stxapps/bracemark-expo and, on --fix, floods their package.json with
    // the app's imports. Turn the rule off for these manifests. (Must sit AFTER
    // the block above so it wins in flat-config order.) Glob is depth-relative
    // like the '**/*.json' block above — Nx runs `eslint .` from the project
    // dir, so the path here is `modules/…`, not repo-relative `apps/bracemark-expo/…`.
    files: ['**/modules/**/package.json'],
    rules: {
      '@nx/dependency-checks': 'off',
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier formatting.
  prettier,
];
