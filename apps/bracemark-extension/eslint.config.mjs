import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react-typescript'],
  // react-hooks, jsx-a11y and react/* — see bracemark-web's config for why this
  // is `flat/react-jsx` and not `flat/react`. The `flat/react-base` half matters
  // here specifically: its `no-restricted-globals` bans `location`, which
  // `utils/capture.ts` reads legitimately in a content script.
  ...nx.configs['flat/react-jsx'],
  ...baseConfig,
  {
    // Generated / build output — not authored source, don't lint it.
    // public/theme-init.js is emitted from themeInitScript() at config load (wxt.config.ts).
    ignores: ['.wxt/**', '.output/**', 'public/theme-init.js'],
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
            // WXT public assets are imported by absolute path, e.g. '/wxt.svg'.
            '^/.*\\.(svg|png|jpg|jpeg|gif|webp|ico)$',
          ],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
];
