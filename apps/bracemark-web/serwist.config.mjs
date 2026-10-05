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
//
// `globIgnores`: PNGs the app never shows offline — the manifest screenshots
// (install-dialog art) and the OpenGraph/Twitter cards (for link unfurlers, never
// rendered in the app). They were about half the precache's bytes, downloaded by
// every signed-in browser now that the worker registers after sign-in rather
// than only when installed (docs/offline-mode.md, _when the worker registers_).
// The patterns are relative to this app's directory, where serwist globs
// `public/` and Next's static media.
//
// `globPatterns`: serwist's own two (Next's static assets, `public/`) — restated,
// because passing any pattern replaces its defaults — plus the export's RSC
// payloads, `out/**/*.txt`. Those are what a CLIENT-SIDE navigation fetches (the
// route's `.txt` and Next's per-segment `__next.*.txt` files, with an `?_rsc=`
// query the worker ignores — sw.ts). The route HTML alone brings back a cold
// launch, but an in-app hop to a section never opened online — the menu's
// Settings, then Data — needs the payload, and without it the click went nowhere
// offline (PWA-004). 118 files, ~40 KB gzipped. `manifestTransforms` maps their
// `out/…` paths to the URLs they are served at; serwist's own transform leaves
// them alone.
//
// …and `out/build.json`, the one file that says which build all the others are
// (app/build.json/route.ts). It is precached so that the update pill can ask the
// WORKER which build it holds; leave it out and that question goes to the network
// instead, which answers with the latest deploy whatever the worker holds — and
// the pill would compare a page against the wrong thing, silently.
export default serwist({
  swSrc: 'src/sw.ts',
  swDest: 'out/sw.js',
  globPatterns: [
    '.next/static/**/*.{js,css,html,ico,apng,png,avif,jpg,jpeg,jfif,pjpeg,pjp,gif,svg,webp,json,webmanifest}',
    'public/**/*',
    'out/**/*.txt',
    'out/build.json',
  ],
  globIgnores: [
    'public/ss-*.png',
    '**/opengraph-image*.png',
    '**/twitter-image*.png',
    'out/robots.txt',
  ],
  manifestTransforms: [
    (entries) => ({
      manifest: entries.map((entry) =>
        entry.url.startsWith('out/')
          ? { ...entry, url: `/${entry.url.slice('out/'.length)}` }
          : entry,
      ),
      warnings: [],
    }),
  ],
});
