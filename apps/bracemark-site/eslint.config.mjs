import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react-typescript'],
  // react-hooks, jsx-a11y and react/* — see bracemark-web's config for why this
  // is `flat/react-jsx` and not `flat/react`.
  ...nx.configs['flat/react-jsx'],
  // Registers the @next/next plugin AND turns its rules on; a bare
  // `{ plugins: { '@next/next': … } }` next to it fails with "Cannot redefine
  // plugin".
  nextEslintPluginNext.configs['core-web-vitals'],
  ...baseConfig,
  {
    rules: {
      // `output: 'export'` + `images: { unoptimized: true }` (next.config.js) —
      // next/image has nothing to optimize on a statically exported apex.
      '@next/next/no-img-element': 'off',
    },
  },
  {
    ignores: ['.next/**', 'out/**'],
  },
];
