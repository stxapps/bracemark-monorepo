/**
 * @jest-environment node
 *
 * Reads the source tree, which is a Node concern — nothing here renders.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SITE_URL } from '../lib/site';
import sitemap from './sitemap';

// Pages that exist on purpose but are not in the sitemap. Empty today: every
// page on the marketing site is one we want found. A page that should stay
// unlisted is named here, with its reason, rather than silently left out of the
// list in sitemap.ts.
const UNLISTED = new Set<string>();

/** Every route `src/app/` defines, read from its `page.tsx` files. */
function routesOnDisk(): string[] {
  const appDir = __dirname;
  return (readdirSync(appDir, { recursive: true }) as string[])
    .filter((file) => /(^|\/)page\.tsx$/.test(file))
    .map((file) => {
      const segments = file
        .split('/')
        .slice(0, -1)
        // A route group `(name)` shapes the tree but not the URL.
        .filter((segment) => !/^\(.*\)$/.test(segment));
      // A dynamic segment has no one URL to list — its params would have to be
      // enumerated in sitemap.ts, from the same source generateStaticParams uses.
      // Fail on it rather than let a whole family of pages go unlisted.
      if (segments.some((segment) => segment.startsWith('['))) {
        throw new Error(`${join('src/app', file)}: a dynamic route needs its own sitemap entries`);
      }
      return `/${segments.join('/')}`;
    });
}

const LISTED = sitemap().map((entry) => entry.url.slice(SITE_URL.length));

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
});
