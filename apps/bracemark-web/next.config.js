//@ts-check

// ONE IDENTIFIER PER BUILD (docs/offline-mode.md, _which build is this page_).
// The update pill needs to know whether the page on screen and the service worker
// that just took over are the same build, and nothing else in a static export
// says: `package.json`'s version does not move per deploy, and Next's own build
// id is not exposed to app code. So each `next build` stamps itself with the
// moment it started, and that one string goes to the two places that are
// compared — every document's `<html data-build>` (app/layout.tsx) and
// `/build.json` (app/build.json/route.ts), which the worker precaches.
//
// Set on `process.env` as well as returned in `env`: static generation renders in
// worker processes that load this file again, and each must see the id the main
// process chose rather than mint its own. `??=` is what makes the first one win.
const buildId = (process.env.BUILD_ID ??= new Date().toISOString());

/**
 * @type {import('next').NextConfig}
 **/
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  env: { BUILD_ID: buildId },
};

module.exports = nextConfig;
