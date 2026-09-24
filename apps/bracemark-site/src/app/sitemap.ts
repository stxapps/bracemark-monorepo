import type { MetadataRoute } from 'next';

import { SITE_URL } from '../lib/site';

// /sitemap.xml — every page on the marketing site, for the crawlers that read
// one. `app/robots.ts` points at it on production only; see there.
//
// A hand-kept list rather than a walk of `src/app/`, because this module runs
// inside Next's build output, where the source tree is not where a relative path
// would look for it. What stops the list rotting is `sitemap.spec.ts` beside
// this file, which does walk the tree and fails on any page missing from here —
// the likely drift is a new page that ships unlisted, and that is silent
// otherwise: the page renders, links and builds exactly as it would listed.
//
// Clean URLs only — the form the CloudFront function answers 200 for
// (docs/hosting.md, _clean URLs_). A `/about.html` or `/about/` here would be a
// URL that 301s, which a search console reports as a sitemap error rather than
// following.
//
// No `lastModified`, `changeFrequency` or `priority`. Google ignores the last two
// outright, and trusts `lastmod` only from a site whose values have proven
// accurate — a build timestamp on every page, which is all a static export could
// cheaply give, is the canonical inaccurate one.
//
// Absolute against SITE_URL, which is production in every tier (lib/site.ts). A
// staging build therefore publishes a sitemap of production's URLs, and that is
// the right content rather than a tolerated one: those are the canonical
// addresses of these pages. Staging's robots.txt is `Disallow: /` and names no
// sitemap, so nothing is pointed at this copy anyway.
const PATHS = [
  '/',
  '/about',
  '/pricing',
  '/faq',
  '/support',
  '/security',
  '/extractor',
  '/privacy',
  '/terms',
  '/delete-account',
];

// Required by `output: 'export'`, same as app/robots.ts.
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((path) => ({ url: `${SITE_URL}${path}` }));
}
