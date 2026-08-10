import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {
      // expo-status-bar's <StatusBar style="auto" /> uses `style` as a string
      // enum, not a style object — allow-list it for this rule.
      'react/style-prop-object': ['warn', { allow: ['StatusBar'] }],
    },
  },
  {
    // THE iOS SHARE-EXTENSION FENCE, mechanized. Everything this tree
    // transitively imports is executed on every cold share, in a separate
    // process with its own memory budget (docs/share-sheet.md, _keep
    // index.share.js lean_) — and Metro does not tree-shake, so one barrel
    // import costs the whole barrel. Until now the rule lived only in three file
    // headers, which is why `@stxapps/expo-react`'s index (60 `export *`s: every
    // provider and hook, the sync engine, import/export) had been sitting in the
    // extension bundle unnoticed: nothing failed, the sheet just booted slower
    // and heavier. A violation is invisible at runtime on Android (its share
    // activity rides the main bundle, where all of this is resident anyway) and
    // invisible in CI, so lint is the only place it can be caught.
    //
    // TYPE IMPORTS ARE EXEMPT because they are genuinely free: babel erases
    // `import type`, and the graph confirms it — the pickers' type-only barrel
    // import put nothing in the bundle. Drop the `type` keyword, though, and the
    // whole package arrives; that near-miss is exactly what this rule is for.
    //
    // The file list is the share tree plus link-quota-banner, which is not in it
    // but is rendered BY it (at the plan's link cap) and so shares its budget.
    files: [
      '**/src/features/share/**/*.ts',
      '**/src/features/share/**/*.tsx',
      '**/src/components/links/link-quota-banner.tsx',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@stxapps/expo-react',
              message:
                "Import the file, not the barrel: '@stxapps/expo-react/data/share-store'. The index is 60 `export *`s — providers, hooks, the sync engine, import/export — and Metro executes all of them on every cold share.",
              allowTypeImports: true,
            },
            {
              name: '@stxapps/expo-crypto',
              message:
                "Import the file, not the barrel: '@stxapps/expo-crypto/lib/ids'. The index pulls Argon2, the AES stack and quick-crypto into the extension's init.",
              allowTypeImports: true,
            },
            {
              name: '@stxapps/react',
              message:
                'The barrel drags react-query and react-hook-form into the share-extension bundle. Import the file you need.',
              allowTypeImports: true,
            },
            {
              name: 'lucide-react-native',
              message:
                "Deep-import the icon ('lucide-react-native/icons/folder'). The barrel is ~1700 icon modules and executes every one of them on import.",
              allowTypeImports: true,
            },
            {
              name: 'react-native-reanimated',
              message:
                'No Reanimated on the share path — it initializes a native runtime on every cold share. The sheet animates nothing (docs/share-sheet.md).',
            },
            {
              name: '@rn-primitives/portal',
              message:
                "No portals on the share path — the sheet's pickers are SCREENS within the sheet, not overlays over it (docs/share-sheet.md).",
            },
            {
              name: 'expo-router',
              message:
                'The extension process never loads the router; the sheet switches screens with local state.',
            },
          ],
          patterns: [
            {
              group: [
                '**/components/ui/dialog',
                '**/components/ui/dropdown-menu',
                '**/components/ui/alert-dialog',
                '**/components/ui/native-only-animated-view',
              ],
              message:
                'These ui components pull Reanimated + @rn-primitives/portal — a native runtime initialized on every cold share. Use a screen within the sheet instead (docs/share-sheet.md).',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['.expo', 'web-build', 'cache', 'dist', '**/out-tsc'],
  },
];
