// The app's ambient module declarations — mirrors bracemark-web's index.d.ts, kept
// at the app root alongside global.css and the generated uniwind-env.d.ts (this
// is where hand-written ambient decls live workspace-wide, not in src/).
//
// Only `*.css` for now: side-effect CSS imports like `import '../../global.css'`
// in _layout.tsx. Uniwind consumes global.css through the Metro transform at
// build time; TypeScript only needs to know the module exists. (uniwind-env.d.ts
// is generated and can't hold this; `*.svg` module types come from the
// referenced @nx/expo svg.d.ts in tsconfig.app.json.)
declare module '*.css';
