import type { MetadataRoute } from 'next';

import { BLOG_POSTS } from '../content/blog';
import { DOC_PAGES } from '../content/docs';
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
// No `changeFrequency` or `priority`. Only /blog posts have an accurate
// `lastModified`: their publication/update timestamps are set by the author.
// A build timestamp on every page would misstate unchanged content.
//
// Absolute against SITE_URL, which is production in every tier (lib/site.ts). A
// staging build therefore publishes a sitemap of production's URLs, and that is
// the right content rather than a tolerated one: those are the canonical
// addresses of these pages. Staging's robots.txt is `Disallow: /` and names no
// sitemap, so nothing is pointed at this copy anyway.
//
// Both dynamic routes are enumerated from the manifests their
// `generateStaticParams` read, so a page added there is listed here too.
const PATHS = [
  '/',
  '/about',
  '/pricing',
  '/faq',
  '/docs',
  ...DOC_PAGES.map((page) => `/docs/${page.slug}`),
  '/blog',
  '/tools/bookmark-converter',
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
  return [
    ...PATHS.map((path) => ({ url: `${SITE_URL}${path}` })),
    ...BLOG_POSTS.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: post.updatedAt ?? post.publishedAt,
    })),
  ];
}
