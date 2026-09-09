import nx from '@nx/eslint-plugin';

import baseConfig, { TYPOGRAPHY_IGNORES, TYPOGRAPHY_SYNTAX } from '../../eslint.config.mjs';

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
    // `leading-none` DOES NOT PORT FROM WEB, mechanized. A line box tighter than
    // the font's own is centred by CSS and by Android, and is NOT centred by
    // iOS: RN's `RCTApplyBaselineOffsetForRange` compensates a box LARGER than
    // the font and returns early otherwise, so TextKit takes the whole shortfall
    // off the ascent and the glyphs ride high inside their own box — measured
    // 1.96pt at the brand wordmark's 15px step, 1.55pt on a dialog title.
    // `items-center` cannot reach it: the boxes ARE centred, the caps are not
    // centred in theirs. `leading-none` is the only step in the scale that can
    // never clear Inter's natural 1.21 ratio, which is what makes it a name
    // worth banning rather than a number worth judging.
    //
    // The rule is here because the same class is CORRECT on web — web-ui's
    // BrandLockup carries it — so every port from a web twin arrives holding it,
    // and nothing downstream objects: no type error, no failing test (jest lays
    // no text out), and on Android, where a layout usually gets eyeballed first,
    // it is off by half a pixel. It reached three components that way.
    //
    // THE FIX IS ALMOST ALWAYS TO DELETE THE CLASS. Setting no leading is the
    // native spelling of what `leading-none` buys on web — Inter's own box is
    // already tight to the glyphs, and it self-centres (its ascender minus its
    // cap height equals its descender to the unit). Reach for `leading-tight`
    // only when a specific leading is wanted; below 1.25 nothing is safe.
    // docs/theme.md, _extending_, carries the measurements for every pairing in
    // this app.
    //
    // The typography selectors are SPREAD IN rather than assumed: flat config
    // hands the last matching block's option list to the rule whole, so a bare
    // `no-restricted-syntax` here would drop the apostrophe rule for this app.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: TYPOGRAPHY_IGNORES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...TYPOGRAPHY_SYNTAX,
        {
          selector: 'Literal[value=/(^|\\s)leading-none(\\s|$)/]',
          message:
            '`leading-none` is not centred on iOS — the glyphs ride high inside their own box and no `items-*` can reach them. Delete the class (Inter’s own box is tight to the glyphs and self-centres), or use `leading-tight` if you need a number. docs/theme.md, _extending_.',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|\\s)leading-none(\\s|$)/]',
          message:
            '`leading-none` is not centred on iOS — the glyphs ride high inside their own box and no `items-*` can reach them. Delete the class (Inter’s own box is tight to the glyphs and self-centres), or use `leading-tight` if you need a number. docs/theme.md, _extending_.',
        },
      ],
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
