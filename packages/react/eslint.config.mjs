import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';
import { agnosticGlobals } from '../../tools/eslint/agnostic-globals.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  // platform:agnostic — same contract as @stxapps/shared: hooks and stores here
  // are compiled once and run on browsers, workerd and Hermes.
  agnosticGlobals,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
];
