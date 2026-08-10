// @ts-check
import { serwist } from '@serwist/next/config';

// Configurator mode: the service worker is built by `serwist build` as an
// external step after `next build` (see the build target in package.json).
// This works with Turbopack and lets Serwist see prerendered routes.
//
// We use `output: 'export'`, so `next build` copies `public/` into `out/`
// before this runs. The SW must therefore be emitted into `out/` (the
// deployed dir), not `public/`. The precache manifest URLs (`/_next/...`,
// route HTML, public assets) all resolve against the exported `out/`.
export default serwist({
  swSrc: 'src/sw.ts',
  swDest: 'out/sw.js',
});
