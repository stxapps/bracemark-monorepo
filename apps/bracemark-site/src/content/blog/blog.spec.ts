/**
 * @jest-environment node
 *
 * MDX is outside ESLint and TypeScript, so keep its source and manifest in step.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sitemap from '../../app/sitemap';
import { MDX_COMPONENTS } from '../../components/mdx-components';
import { headingId } from '../../lib/mdx/headings';
import { SITE_URL } from '../../lib/site';
import { BLOG_POSTS } from './index';

const FILES = readdirSync(__dirname).filter((file) => file.endsWith('.mdx'));
const SITE_PATHS = new Set(sitemap().map((entry) => entry.url.slice(SITE_URL.length)));

function headingsOf(source: string): Set<string> {
  const seen = new Map<string, number>();
  return new Set(
    source
      .split('\n')
      .flatMap((line) => /^#{2,3}\s+(.+)$/.exec(line)?.[1] ?? [])
      .map((heading) => headingId(heading, seen)),
  );
}

describe('the /blog manifest', () => {
  it('names every post file once, with a clean slug and valid publication dates', () => {
    const slugs = BLOG_POSTS.map((post) => post.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(FILES.map((file) => file.replace(/\.mdx$/, '')).sort()).toEqual([...slugs].sort());

    for (const post of BLOG_POSTS) {
      expect(post.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(post.description.length).toBeLessThanOrEqual(160);
      expect(post.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Number.isFinite(Date.parse(post.publishedAt))).toBe(true);
      expect(new Date(post.publishedAt).toISOString().replace('.000Z', 'Z')).toBe(post.publishedAt);
      if (post.updatedAt) {
        expect(post.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        expect(new Date(post.updatedAt).toISOString().replace('.000Z', 'Z')).toBe(post.updatedAt);
        expect(Date.parse(post.updatedAt)).toBeGreaterThan(Date.parse(post.publishedAt));
      }
    }
  });
});

describe.each(BLOG_POSTS.map((post) => post.slug))('/blog/%s', (slug) => {
  const source = readFileSync(join(__dirname, `${slug}.mdx`), 'utf8');

  it('uses only mapped components and one page title from the manifest', () => {
    expect(source).not.toMatch(/^(import|export)\s/m);
    expect(source).not.toMatch(/^#\s/m);
    for (const match of source.matchAll(/^#{2,3}\s+(.+)$/gm)) {
      expect(match[1]).not.toMatch(/[`*_[\]<>{}\\]|&\w+;/);
    }
    const components = [...source.matchAll(/<([A-Z][A-Za-z0-9]*)/g)].map((match) => match[1]);
    expect(components.filter((name) => !(name in MDX_COMPONENTS))).toEqual([]);
  });

  it('uses typographic quotes and links to existing pages or headings', () => {
    const prose = source.replace(/`[^`]*`/g, '').replace(/<[^>]*>/g, '');
    expect(prose).not.toMatch(/['"]/);

    const headings = headingsOf(source);
    const internalLinks = [...source.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => target.startsWith('/') || target.startsWith('#'));
    const broken = internalLinks.filter((target) => {
      const [path, anchor] = target.split('#');
      if (!path) return !headings.has(anchor);
      if (!SITE_PATHS.has(path)) return true;
      if (anchor === undefined) return false;
      const docSlug = /^\/docs\/([^/]+)$/.exec(path)?.[1];
      if (!docSlug) return true;
      const docSource = readFileSync(join(__dirname, '..', 'docs', `${docSlug}.mdx`), 'utf8');
      return !headingsOf(docSource).has(anchor);
    });
    expect(broken).toEqual([]);
  });
});
