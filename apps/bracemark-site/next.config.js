//@ts-check

/**
 * @type {import('next').NextConfig}
 **/
const nextConfig = {
  // Static export, same as bracemark-web: the whole marketing site prerenders to
  // `out/` and is served from S3 + CloudFront (docs/hosting.md). Nothing here
  // is per-request — it's a content site — so no Next server runs on the apex.
  output: 'export',
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  experimental: {
    // OFF, because with it on `next dev` can serve a stylesheet that is one
    // edit behind the file and stay there. It takes two caches agreeing to be
    // wrong. Turbopack persists its dev build under `.next/dev/cache/turbopack`
    // and, on the next start, replays the PostCSS transform of `globals.css`
    // with the source it REMEMBERS before re-running it with the source on disk
    // — which it does whenever a file Tailwind scans changed while the server
    // was down. `@tailwindcss/postcss` keeps a compiler per input file and
    // rebuilds it only when that file's mtime moves; between those two runs it
    // has not, so the second run reuses the compiler built from the stale
    // source. Nothing errors, `touch` does not help (same bytes, so Turbopack
    // never calls the transform again), and only a real edit made while the
    // server is running clears it.
    //
    // The trigger is ordinary: stop the server, change `globals.css` and any
    // component, start it — a branch switch, a pull, an agent's edit. The
    // symptom is a rule that is in the file and not on the page, which reads as
    // a specificity bug in whatever was just written. Measured on Next 16.1.7 +
    // Tailwind 4.3.2 with `DEBUG=1`: two `[@tailwindcss/postcss] globals.css`
    // lines at startup, the second with no "Setup compiler" under it.
    //
    // What it costs here is nothing worth having: this is a small content site
    // and a cold `next dev` is ready in under a second. `next build` never used
    // the cache (it is off for builds by default), so the export was always
    // right — which is what made the dev server the odd one out.
    turbopackFileSystemCacheForDev: false,
  },
};

module.exports = nextConfig;
