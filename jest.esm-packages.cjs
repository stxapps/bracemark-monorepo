// node_modules packages that ship raw ESM (`"type": "module"`, bare `export`)
// and therefore must be transpiled by jest instead of ignored. Jest skips all
// of node_modules by default, so every jest project that transitively imports
// one of these needs it whitelisted in `transformIgnorePatterns`.
//
// Single source of truth, consumed by:
//   - jest.preset.js          → all preset-based packages (shared, react, …)
//   - jest.expo-base.cjs      → the jest-expo projects (bracemark-expo, expo-react),
//     which have to restate jest-expo's own node_modules allowlist to extend it
//   - apps/bracemark-web/jest.config.cts → next/jest (overrides preset, patched there)
//
// vitest-based projects (bracemark-api) don't need this — esbuild handles ESM.
// `lucide-react-native` is bracemark-expo's icon set (the RN sibling of the web
// apps' `lucide-react`), pulled in by any spec that renders a real screen.
module.exports = ['fractional-indexing', '@noble/ed25519', 'lucide-react-native'];
