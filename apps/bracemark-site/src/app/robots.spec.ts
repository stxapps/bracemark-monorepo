/**
 * @jest-environment node
 */
import type { MetadataRoute } from 'next';

import { SITE_URL } from '../lib/site';

// robots.ts reads ALLOW_INDEXING at import, so each tier gets a fresh module.
function robotsFor(allowIndexing: 'true' | 'false'): MetadataRoute.Robots {
  const saved = process.env.ALLOW_INDEXING;
  process.env.ALLOW_INDEXING = allowIndexing;
  try {
    let result: MetadataRoute.Robots | undefined;
    jest.isolateModules(() => {
      result = (require('./robots') as typeof import('./robots')).default();
    });
    return result as MetadataRoute.Robots;
  } finally {
    process.env.ALLOW_INDEXING = saved;
  }
}

describe('/robots.txt', () => {
  it('allows everything on production and points at the sitemap', () => {
    const robots = robotsFor('true');
    expect(robots.rules).toEqual({ userAgent: '*', allow: '/' });
    expect(robots.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });

  // A Disallow-everything file that also advertises URLs is two contradictory
  // instructions — staging must carry the first and not the second.
  it('disallows everything elsewhere and names no sitemap', () => {
    const robots = robotsFor('false');
    expect(robots.rules).toEqual({ userAgent: '*', disallow: '/' });
    expect(robots.sitemap).toBeUndefined();
  });
});
