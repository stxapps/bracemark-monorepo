// The ambient globals `platform:agnostic` source may NOT reach for — the half of
// the portability contract that types can't express.
//
// Why this file exists. `@stxapps/shared` and `@stxapps/react` are compiled ONCE
// and run on three engines: browsers, workerd (bracemark-api) and Hermes
// (bracemark-expo). A global they reach for has to exist on all three, and
// nothing checks that: `crypto.getRandomValues` in crypto/passphrase.ts
// typechecked, passed jest (node has crypto), passed lint, and threw
// `ReferenceError: Property 'crypto' doesn't exist` the moment the expo
// create-account screen mounted. Hermes is the floor and NO published lib
// describes it, so the tsconfigs pin the ambient surface as close as a real lib
// gets (`webworker`, see packages/shared/tsconfig.lib.json) and this list refuses
// the rest BY NAME, at authoring time, with the fix in the message.
//
// The list is the three-way intersection, so it runs in both directions: browser-
// and worker-only names are refused because Hermes lacks them, and React Native-
// only names are refused because the browser and workerd lack them.
//
// Adding a name here is cheap. REMOVING one — i.e. deciding the agnostic layer
// may use it after all — means checking it on all three engines first, and
// usually means an entry in apps/bracemark-expo/src/polyfills.ts. A one-off use
// is an `eslint-disable-next-line` plus a comment saying which platform makes it
// safe: that turns a silent assumption into a reviewable one, which is the whole
// point. Both existing disables (crypto/passphrase.ts, crypto/recovery-code.ts)
// read that way.
//
// Not listed, and worth knowing why: `URL`, `URLSearchParams`, `TextDecoder` and
// `structuredClone` are absent from bare Hermes but installed by Expo's winter
// runtime (node_modules/expo/src/winter/runtime.native.ts), so they ARE portable
// here. `atob`/`btoa` are installed by our own polyfills. `Blob`/`File`/
// `FileReader` exist on all three but with materially different capabilities —
// they're not banned, they're just never portable in the details.
// See docs/expo-native-deps.md, _runtime polyfills_.

const NODE_ONLY = 'is a Node/CJS global — absent on browsers, on workerd and on Hermes.';
const BROWSER_ONLY = 'is a browser/worker global — Hermes (bracemark-expo) has no such thing.';
const RN_ONLY = 'is a React Native global — absent on browsers and on workerd.';

// name → message. One list, two rules: the bare identifier (`crypto`) and the
// property spelling that dodges it (`globalThis.crypto`).
const RESTRICTED = [
  {
    name: 'crypto',
    message:
      'Hermes has NO `crypto` global; bracemark-expo installs ONLY `crypto.getRandomValues` (apps/bracemark-expo/src/polyfills.ts) — no `subtle`, no `randomUUID`. For randomness, disable this rule on the line with a comment; for anything else use @stxapps/web-crypto / @stxapps/expo-crypto.',
  },
  { name: 'Buffer', message: `Buffer ${NODE_ONLY} Use crypto/encoding.ts.` },
  {
    name: 'process',
    message: `process ${NODE_ONLY} workerd has no \`process.env\` either — the api reads its bindings from the handler's \`env\`; take config as a parameter.`,
  },
  { name: 'require', message: `require ${NODE_ONLY} Use a static import.` },
  { name: '__dirname', message: `__dirname ${NODE_ONLY}` },
  { name: '__filename', message: `__filename ${NODE_ONLY}` },
  { name: 'global', message: `global ${NODE_ONLY} Use globalThis.` },
  { name: 'document', message: `document ${BROWSER_ONLY}` },
  { name: 'window', message: `window ${BROWSER_ONLY}` },
  { name: 'self', message: `self ${BROWSER_ONLY} Use globalThis.` },
  { name: 'location', message: `location ${BROWSER_ONLY} Take the URL as a parameter.` },
  { name: 'history', message: `history ${BROWSER_ONLY}` },
  {
    name: 'navigator',
    message: `navigator exists on all three with three different shapes — read what you need in the platform layer and pass it in.`,
  },
  { name: 'alert', message: `alert ${BROWSER_ONLY}` },
  {
    name: 'localStorage',
    message: `localStorage ${BROWSER_ONLY} Persistence belongs in the platform store (docs/local-first-sync.md).`,
  },
  { name: 'sessionStorage', message: `sessionStorage ${BROWSER_ONLY}` },
  {
    name: 'indexedDB',
    message: `indexedDB ${BROWSER_ONLY} It is web-react's store; expo uses expo-sqlite.`,
  },
  { name: 'caches', message: `caches ${BROWSER_ONLY}` },
  { name: 'XMLHttpRequest', message: `XMLHttpRequest is not on workerd. Use fetch.` },
  { name: 'Worker', message: `Worker ${BROWSER_ONLY}` },
  {
    name: 'setImmediate',
    message: `setImmediate ${RN_ONLY} Use setTimeout(fn, 0) or queueMicrotask.`,
  },
  { name: '__DEV__', message: `__DEV__ ${RN_ONLY} Take the flag as a parameter.` },
];

/**
 * Flat-config block for the platform:agnostic packages. Spread it into
 * `packages/<agnostic>/eslint.config.mjs` AFTER the base config.
 *
 * The glob is `**​/src/**` rather than a repo-relative path on purpose: Nx runs
 * `eslint .` from the PROJECT directory, so paths arrive as `src/…`, but the same
 * config is also matched repo-relative when eslint is run from the root. A
 * leading `**​/` matches zero segments, so this spelling covers both (the same
 * gotcha the root config's `**​/modules/**​/package.json` block documents).
 *
 * Specs are excluded: they run on node under jest and never ship, so a spec is
 * free to reach for `Buffer` or stub `globalThis.crypto`. `src/testing` is
 * excluded on the same ground and needs it more, because the exemption is less
 * obvious there: a file named `*.spec.ts` announces what it is, while
 * `src/testing/backup-fixtures.ts` looks like source. What keeps it honest is
 * that the package's own tsconfig.lib.json excludes the directory too, so
 * nothing shipped can import it — the deny list and the compiler agree, and a
 * `src/testing` module that drifted into the shipped graph would fail to
 * typecheck rather than reach Hermes.
 */
export const agnosticGlobals = {
  files: ['**/src/**/*.ts', '**/src/**/*.tsx'],
  ignores: ['**/src/testing/**', '**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
  rules: {
    'no-restricted-globals': ['error', ...RESTRICTED],
    'no-restricted-properties': [
      'error',
      ...RESTRICTED.map(({ name, message }) => ({
        object: 'globalThis',
        property: name,
        message,
      })),
    ],
  },
};
