/**
 * @jest-environment node
 *
 * Reads the source tree, which is a Node concern — nothing here renders.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BLOG_POSTS } from '../content/blog';
import { DOC_PAGES } from '../content/docs';
import { SITE_URL } from '../lib/site';
import sitemap from './sitemap';

// The /docs and /blog pages import the MDX compiler, which is ESM-only and which
// jest would have to transpile. Their `generateMetadata` never calls it, so only
// rendering would need it.
jest.mock('../lib/mdx/load', () => ({}));

// Pages that exist on purpose but are not in the sitemap. Empty today: every
// page on the marketing site is one we want found. A page that should stay
// unlisted is named here, with its reason, rather than silently left out of the
// list in sitemap.ts.
const UNLISTED = new Set<string>();

// A dynamic route has no one URL to list, so each one is expanded here from the
// same source its `generateStaticParams` reads — the manifest, not the files, so
// the expansion can't be satisfied by the list it is checking.
const DYNAMIC_ROUTES: Record<string, string[]> = {
  '/docs/[slug]': DOC_PAGES.map((page) => page.slug),
  '/blog/[slug]': BLOG_POSTS.map((post) => post.slug),
};

/** Every route `src/app/` defines, read from its `page.tsx` files. */
function routesOnDisk(): string[] {
  const appDir = __dirname;
  return (readdirSync(appDir, { recursive: true }) as string[])
    .filter((file) => /(^|\/)page\.tsx$/.test(file))
    .flatMap((file) => {
      const segments = file
        .split('/')
        .slice(0, -1)
        // A route group `(name)` shapes the tree but not the URL.
        .filter((segment) => !/^\(.*\)$/.test(segment));
      const route = `/${segments.join('/')}`;
      // A dynamic route not in DYNAMIC_ROUTES fails outright rather than let a
      // whole family of pages go unlisted.
      if (segments.some((segment) => segment.startsWith('['))) {
        const params = DYNAMIC_ROUTES[route];
        if (!params) {
          throw new Error(
            `${join('src/app', file)}: a dynamic route needs its own sitemap entries`,
          );
        }
        return params.map((param) => route.replace(/\[[^\]]+\]/, param));
      }
      return [route];
    });
}

const LISTED = sitemap().map((entry) => entry.url.slice(SITE_URL.length));

/**
 * The canonical a page declares, resolved as Next would: its static `metadata`,
 * or its `generateMetadata` given the route's params and an empty parent.
 */
async function canonicalOf(path: string): Promise<unknown> {
  const [, section, slug] = path.split('/');
  const isDynamic = slug !== undefined && (section === 'docs' || section === 'blog');
  const file = path === '/' ? './page' : isDynamic ? `./${section}/[slug]/page` : `.${path}/page`;
  const page = await import(file);
  const metadata =
    page.metadata ??
    (await page.generateMetadata({ params: Promise.resolve({ slug }) }, Promise.resolve({})));
  return metadata.alternates?.canonical;
}

describe('/sitemap.xml', () => {
  it('lists every page on the site', () => {
    const expected = routesOnDisk().filter((route) => !UNLISTED.has(route));
    expect([...LISTED].sort()).toEqual(expected.sort());
  });

  it('lists each URL once, absolute, in the clean form that answers 200', () => {
    expect(new Set(LISTED).size).toBe(LISTED.length);
    for (const path of LISTED) {
      expect(path.startsWith('/')).toBe(true);
      if (path === '/') continue;
      // `/about/` and `/about.html` both 301 at the CDN (docs/hosting.md, _clean URLs_).
      expect(path).not.toMatch(/\/$|\.html$/);
    }
  });

  // A page with no canonical leaves the choice to the search engine, and ten
  // pages here shipped that way while every /docs and /blog page named itself.
  // A WRONG one is worse, and nothing else notices it: a canonical copied from
  // the page it was cloned from tells Google this page is a duplicate of that
  // one, and drops it from the index while it renders, builds and links exactly
  // as before. So each listed URL must be the canonical its own page declares.
  it.each(LISTED)('%s names its sitemap URL as its canonical', async (path) => {
    await expect(canonicalOf(path)).resolves.toBe(`${SITE_URL}${path}`);
  });
});
