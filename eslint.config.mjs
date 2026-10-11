import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import jsoncParser from 'jsonc-eslint-parser';

// The typographic selectors and the files they skip, exported because
// `no-restricted-syntax` does not MERGE across flat-config blocks — the last
// block matching a file supplies the whole option list. A project config that
// needs its own selector must therefore spread these into its block or it
// silently drops the apostrophe rule for that project, which is the same class
// of invisible loss the rule itself exists to stop. apps/bracemark-expo does
// exactly that (its `leading-none` selector).
export const TYPOGRAPHY_IGNORES = ['**/*.spec.ts', '**/*.spec.tsx', 'e2e/**'];

export const TYPOGRAPHY_SYNTAX = [
  {
    selector: "Literal[value=/[A-Za-z]'[A-Za-z]/]",
    message: "Use the typographic apostrophe ’ (U+2019), not '.",
  },
  {
    selector: "TemplateElement[value.raw=/[A-Za-z]'[A-Za-z]/]",
    message: "Use the typographic apostrophe ’ (U+2019), not '.",
  },
  {
    selector: "JSXText[value=/[A-Za-z]'[A-Za-z]/]",
    message: "Use the typographic apostrophe ’ (U+2019), not ' or &apos;.",
  },
  {
    selector: 'JSXText[value=/"/]',
    message: 'Use the typographic quotation marks “ ” (U+201C/U+201D), not " or &quot;.',
  },
];

// An unbounded LAZY loop over a class that matches every character — `[\s\S]*?`,
// its spellings `[\S\s]` `[\w\W]` `[\d\D]` `[^]`, and `+?` — is quadratic on
// Hermes: every match costs time in proportion to the REST of the input. `.*?`
// under the `s` flag matches the same characters and is linear; V8 runs both
// alike, so no spec and no web run can see the difference. Measured on the
// Hermes CLI, 4,000 matches over 391 KB: 2,532 ms against 3 ms. It held
// bracemark-expo's JS thread for 31 s on a bookmarks import before this rule
// (import/netscape.ts; docs/data-lifecycle.md, _readings — expo_). A narrow
// class (`[^<]*?`), a greedy `[\s\S]*` and a bounded `{0,n}?` measured linear,
// so they stay legal. Workspace-wide rather than only where Hermes runs, like
// the apostrophe: one spelling, and nobody has to judge where a regex might end
// up — `.*?`/`s` is ES2018, fine on every runtime here. Exported, and spread
// alongside TYPOGRAPHY_SYNTAX, for the no-merge reason above.
const ANY_CHAR_LAZY = String.raw`/\[(?:\\s\\S|\\S\\s|\\w\\W|\\W\\w|\\d\\D|\\D\\d|\^)\][*+]\?/`;
const ANY_CHAR_LAZY_MESSAGE =
  'A lazy `[\\s\\S]*?` (or `[^]*?`, `[\\w\\W]*?`, `+?`) is quadratic on Hermes — each match costs the rest of the input. Write `.*?` with the `s` flag: same characters, linear. eslint.config.mjs, ANY_CHAR_LAZY.';

export const REGEX_SYNTAX = [
  {
    selector: `Literal[regex.pattern=${ANY_CHAR_LAZY}]`,
    message: ANY_CHAR_LAZY_MESSAGE,
  },
  {
    selector: `:matches(NewExpression, CallExpression)[callee.name="RegExp"] > Literal.arguments[value=${ANY_CHAR_LAZY}]`,
    message: ANY_CHAR_LAZY_MESSAGE,
  },
];

// zip.js is imported from its native build, '@zip.js/zip.js/index-native.js',
// never the bare specifier, which is the WASM build. Both build their streams
// on the browser's CompressionStream; the WASM one differs in its fallback
// codec, which the backup export's stored (`level: 0`) entries load and compile
// on every export for nothing, fetching it from a `data:` URI that the app's
// `connect-src` reports as a violation (and that fails outright on the
// marketing site, which has no 'wasm-unsafe-eval'). Nothing else shows it: the
// types are one file for both builds, and every spec passes either way.
// docs/data-lifecycle.md, _which zip.js build_.
//
// Two halves because `no-restricted-imports` sees only import/export
// DECLARATIONS, and zip.js is loaded lazily through `import()` — so the path
// entry in RESTRICTED_IMPORT_PATHS catches a static import, and this selector
// the dynamic one. Exported, and spread alongside TYPOGRAPHY_SYNTAX, for the
// no-merge reason above.
const ZIP_JS_MESSAGE =
  "Import zip.js from '@zip.js/zip.js/index-native.js'. The bare specifier is the WASM build: the backup export would load its codec for nothing, from a data: URI the CSP blocks. docs/data-lifecycle.md, _which zip.js build_.";

export const ZIP_JS_SYNTAX = [
  {
    selector: 'ImportExpression[source.value="@zip.js/zip.js"]',
    message: ZIP_JS_MESSAGE,
  },
];

// The root's `@typescript-eslint/no-restricted-imports` paths — the `zod` shim
// rule below carries the why. Exported for the same reason as the typography
// selectors above: flat config gives a rule's options to the LAST block that
// matches a file, whole, so a project block that restricts its own imports
// under this rule replaces these rather than adding to them. Spread them in.
// apps/bracemark-expo's share-extension fence does; before it did, every file
// in the share tree could import 'zod' bare with lint green.
export const RESTRICTED_IMPORT_PATHS = [
  {
    name: 'zod',
    message:
      "Import { z } from '@stxapps/shared' (or '../zod' inside that package) — it sets `jitless` before any schema is built, which is what keeps 'unsafe-eval' out of the CSP. A type-only import may stay.",
    allowTypeImports: true,
  },
  {
    // The static half of ZIP_JS_SYNTAX, which carries the why. A type-only
    // import erases, so it may stay.
    name: '@zip.js/zip.js',
    message: ZIP_JS_MESSAGE,
    allowTypeImports: true,
  },
];

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
            // e2e (the `e2e/` project) drives the BUILT apps over the wire and
            // the screen — it is a client of them, never a consumer of their
            // source. Importing app or UI internals would let a refactor "fix" a
            // broken flow, which is the one thing this layer exists to prevent.
            // `shared` is allowed for ADDRESSING (the LinkQuery URL grammar, sync
            // paths) and never for EXPECTATIONS: copy, crypto and formatting must
            // be spelled out in the spec, or it can't catch a regression in them.
            // See docs/e2e.md.
            {
              sourceTag: 'type:e2e',
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
    // The apostrophe is `’` (U+2019), never a straight `'`, in every string this
    // workspace writes — docs/brand-assets.md, _mechanics_. The rule is here
    // because stating it was already tried and did not hold: the same
    // recovery-code sentence shipped in both forms, one screen apart, because
    // the choice was being made by prettier's quote heuristic rather than by
    // anyone. See that doc for the whole story.
    //
    // The JSXText selector is the load-bearing one. `&apos;` decodes to a
    // straight `'` at parse time and had accumulated 44 times, invisible to
    // every grep for `'` — this rule sees it because the parser hands the
    // selector the DECODED text. (`&rsquo;` decodes to `’` and is correct, but
    // write the literal character: one spelling, and it greps.)
    //
    // FIXING A HIT IS ALWAYS THE SAME: type `’`. There is no user-facing/
    // developer-facing split — a log line, a thrown Error, a dev-only warning
    // all take `’` too, so that nobody has to judge whether a string might reach
    // a user one day. The single exception is a string where the apostrophe is
    // DATA rather than prose (a parser token, a fixture, something compared
    // against input); there `’` would be a bug, and that is what a disable
    // comment is for. There are none today.
    //
    // Specs and e2e are out of scope: a test NAME is prose nobody reads in the
    // product, and `it("a child's own lock…")` is fine. A spec asserting on real
    // copy still has to spell that copy exactly, or it stops passing.
    //
    // The QUOTATION MARK is `“ ”` (U+201C/U+201D) by the same rule, and it gets
    // one selector rather than three. Prettier's heuristic never touched it —
    // a `"` inside a single-quoted literal needs no escape, so nothing ever
    // flipped a literal on its account and nothing pulled the choice wrong. But
    // nothing pulls it RIGHT either, which is the whole reason the apostrophe
    // drifted, so the one place a straight `"` is unambiguously prose is linted
    // before it has a first hit: JSX text. A Literal cannot be, because `"` is
    // real DATA in this workspace — the CSV quoting in shared/src/{im,ex}port,
    // the HTML attributes in export/netscape.ts, the entity table in
    // expo-react's parse-html-head.ts — and a selector over those would be
    // per-file disables forever. The single-quoted prose literal (`'the "Service"'`)
    // is the gap, and docs/brand-assets.md is what covers it.
    //
    // REGEX_SYNTAX rides in this block because the rule's options can't be split
    // across two (see the exports). Specs share the ignore: they run on V8 only.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: TYPOGRAPHY_IGNORES,
    rules: {
      'no-restricted-syntax': ['error', ...TYPOGRAPHY_SYNTAX, ...REGEX_SYNTAX, ...ZIP_JS_SYNTAX],
    },
  },
  {
    // The specs the block above skips still get the zip.js selector: a spec
    // that imports the bare specifier tests a build the app does not ship.
    files: ['**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...ZIP_JS_SYNTAX],
    },
  },
  {
    // `z` comes from `@stxapps/shared` (or, inside that package, `../zod`) —
    // never from the bare 'zod' specifier. That module calls
    // `z.config({ jitless: true })` before it re-exports the binding, which is
    // the only reason bracemark-web's CSP can withhold 'unsafe-eval': zod 4
    // JIT-compiles each object schema through `new Function`, and probes for
    // eval support with a `new Function('')` whose caught throw is STILL a
    // reported violation. See packages/shared/src/zod.ts for the whole of it,
    // and docs/hosting.md, _security headers_, for the policy it serves.
    //
    // The rule exists because the failure is silent everywhere it matters. A
    // fresh `import { z } from 'zod'` builds its schemas against whatever
    // config is set when its MODULE BODY runs, and losing that race changes no
    // behaviour and no types — it just puts a violation back in the console of
    // a browser nobody is watching, which is the one place these are reported
    // (there is no report-uri).
    //
    // `import type { z } from 'zod'` is exempt and correct: it erases, so it
    // constructs nothing and cannot race anything.
    //
    // The exemption for the shim itself is the override block below rather than
    // an `ignores` here, and its glob is depth-relative for the reason the
    // `**/modules/**/package.json` block gives: Nx runs `eslint .` from the
    // PROJECT dir, so this file is `src/zod.ts` there and
    // `packages/shared/src/zod.ts` from the workspace root. Only a pattern that
    // matches both is safe.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: RESTRICTED_IMPORT_PATHS }],
    },
  },
  {
    // The one file allowed to import 'zod' — it is what the rule above points
    // everyone else at. Must sit AFTER that block so it wins in flat-config
    // order.
    files: ['**/src/zod.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
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
  {
    // `handler` is the CloudFront function's entry point. cloudfront-js calls a
    // bare global of that name and gives the file no module system, so nothing
    // in the file refers to it and there is no `export` to mark it used. The
    // exception is here rather than in a disable comment beside the function
    // because that file, COMMENTS INCLUDED, counts against CloudFront's 10 KB
    // function-size limit. Repo-relative on purpose: `tools/` is no Nx project,
    // so this file is only ever linted from the workspace root (`lint:root`).
    files: ['tools/cloudfront/rewrite-url.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { varsIgnorePattern: '^handler$' }],
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier formatting.
  prettier,
];
