import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react-typescript'],
  // react-hooks (`rules-of-hooks` error, `exhaustive-deps` warn), jsx-a11y and
  // the react/* rules — the same set every package gets from `flat/react`. This
  // app took `flat/react-typescript` alone, which carries no plugins at all, so
  // none of the three ran here. NOT `flat/react`: that also pulls in
  // `flat/react-base`, whose create-react-app heritage bans globals (`location`)
  // that a browser surface uses legitimately.
  ...nx.configs['flat/react-jsx'],
  // This registers the @next/next plugin itself, so it replaces the bare
  // `{ plugins: { '@next/next': … } }` that used to sit here declaring the plugin
  // and enabling none of its rules — the two together fail with "Cannot redefine
  // plugin".
  nextEslintPluginNext.configs['core-web-vitals'],
  ...baseConfig,
  {
    rules: {
      // `output: 'export'` + `images: { unoptimized: true }` (next.config.js), so
      // next/image would optimize nothing here — and these sources are blob URLs
      // minted from the local store (favicons, link previews), not build-time
      // assets Next could have processed anyway.
      '@next/next/no-img-element': 'off',
    },
  },
  {
    ignores: ['.next/**', 'out/**'],
  },
];
