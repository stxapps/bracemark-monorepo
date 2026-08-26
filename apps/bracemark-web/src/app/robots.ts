import type { MetadataRoute } from 'next';

// robots.txt, generated at BUILD time rather than served as a static file, because
// it is the one document that must differ between the two tiers.
//
// This app is bracemark-web, the application itself, on the `app.` host.
// Staging is a real, publicly resolvable registrable domain — dryrunbase.com, not
// a subdomain of bracemark.com (docs/hosting.md, _why staging is a separate
// registrable domain_) — so it is as crawlable as production is. It served the
// same allow-everything robots.txt as production until this file existed, which
// put a byte-for-byte copy of the sign-in and create-account pages in the index on a
// second domain: duplicate content competing with the real one.
//
// Deliberately NOT paired with a `noindex` meta tag on staging. The two do not
// stack the way they look like they should: a crawler that honours `Disallow: /`
// never fetches the page, so it never sees the meta, and adding both just writes
// two contradictory instructions into the repo. `Disallow` is the right one here
// because staging has no inbound links to be discovered through in the first
// place. (The residual gap — an externally linked but uncrawlable URL can still
// surface as a bare result — is what a `noindex` WOULD close, and it needs the
// Disallow dropped to work. Take that trade only if a staging URL actually leaks.)
//
// Keyed on ALLOW_INDEXING, which is the one var in these files with no
// `NEXT_PUBLIC_` prefix: it is read here at build time and never in a client
// component, so prefixing it would bake a string into every chunk for nothing.
// Required rather than defaulted, in both directions — defaulting to allow
// re-creates exactly the bug above the first time an env file is added without
// it, and defaulting to deny would silently deindex production the first time one
// is edited without it. See docs/env-files.md, _robots.txt is per-tier_.
const allowIndexing = process.env.ALLOW_INDEXING;
if (allowIndexing !== 'true' && allowIndexing !== 'false') {
  throw new Error(`ALLOW_INDEXING must be "true" or "false" (got: ${allowIndexing ?? 'unset'})`);
}

// Required by `output: 'export'` — a route handler under a static export has to
// say so explicitly, and robots.txt compiles to one. Without it the build fails
// with "export const dynamic ... not configured on route /robots.txt", which is a
// hard error rather than a silently dynamic route, so it can't regress quietly.
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  if (allowIndexing === 'false') return { rules: { userAgent: '*', disallow: '/' } };
  return { rules: { userAgent: '*', allow: '/' } };
}
