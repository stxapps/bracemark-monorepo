/**
 * @jest-environment node
 *
 * Reads the MDX sources, which is a Node concern — nothing here renders.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sitemap from '../../app/sitemap';
import { MDX_COMPONENTS } from '../../components/mdx-components';
import { headingId } from '../../lib/mdx/headings';
import { SITE_URL } from '../../lib/site';
import { FAQ_GROUPS } from '../faq';
import { DOC_PAGES } from './index';

// The /docs pages are MDX, which no linter, type-checker or prettier pass reads.
// Everything a .tsx page gets for free from those tools, and that a docs page can
// get wrong silently, is asserted here instead. The MDX is read as TEXT, never
// compiled: the compiler is ESM-only and deep (lib/mdx/headings.ts has why).

const DIR = __dirname;
const FILES = readdirSync(DIR).filter((file) => file.endsWith('.mdx'));
const SOURCES = new Map(
  DOC_PAGES.map((page) => [page.slug, readFileSync(join(DIR, `${page.slug}.mdx`), 'utf8')]),
);

/** The source's lines outside fenced code blocks. */
function proseLines(source: string): string[] {
  let fenced = false;
  return source.split('\n').filter((line) => {
    if (line.startsWith('```')) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** The h2/h3 headings of a page, with the ids the rehype plugin will give them. */
function headingsOf(source: string): { text: string; id: string }[] {
  const seen = new Map<string, number>();
  return proseLines(source).flatMap((line) => {
    const match = /^#{2,3}\s+(.+)$/.exec(line);
    if (!match) return [];
    const text = match[1].trim();
    return [{ text, id: headingId(text, seen) }];
  });
}

const HEADING_IDS = new Map(
  [...SOURCES].map(([slug, source]) => [slug, new Set(headingsOf(source).map((h) => h.id))]),
);
const FAQ_IDS = new Set(FAQ_GROUPS.flatMap((group) => [group.id, ...group.items.map((i) => i.id)]));
const SITE_PATHS = new Set(sitemap().map((entry) => entry.url.slice(SITE_URL.length)));

describe('the /docs manifest', () => {
  it('names every .mdx file here, and each once', () => {
    const slugs = DOC_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(FILES.map((file) => file.replace(/\.mdx$/, '')).sort()).toEqual([...slugs].sort());
  });

  it('uses slugs that are clean URL segments', () => {
    for (const { slug } of DOC_PAGES) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  // The description is the meta description AND the printed lede, so it has the
  // layout's budget (app/layout.tsx): Google shows about 160 characters.
  it('keeps each description inside the meta-description budget', () => {
    const over = DOC_PAGES.filter((page) => page.description.length > 160);
    expect(over.map((page) => `${page.slug}: ${page.description.length}`)).toEqual([]);
  });
});

describe.each(DOC_PAGES.map((page) => page.slug))('/docs/%s', (slug) => {
  const source = SOURCES.get(slug) ?? '';
  const lines = proseLines(source);

  // The component map is the whole vocabulary (components/mdx-components.tsx).
  // An import would let a page reach past it, and an export would add a
  // named binding nothing renders.
  it('imports and exports nothing', () => {
    expect(lines.filter((line) => /^(import|export)\s/.test(line))).toEqual([]);
  });

  it('uses only components the map provides', () => {
    const used = new Set([...source.matchAll(/<([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !(name in MDX_COMPONENTS))).toEqual([]);
  });

  // The page prints its own <h1> from the manifest title; a `# ` line would be a
  // second one.
  it('starts its headings at h2', () => {
    expect(lines.filter((line) => /^#\s/.test(line))).toEqual([]);
  });

  // What lets `headingsOf` above compute an id from a source line: with no markup
  // in it, the source text IS the rendered text the plugin slugs.
  it('keeps headings to plain text', () => {
    for (const { text } of headingsOf(source)) expect(text).not.toMatch(/[`*_[\]<>{}\\]|&\w+;/);
  });

  // The workspace rule for `’` and `“ ”` (docs/brand-assets.md, _the mechanics_)
  // is held by ESLint in .ts/.tsx, which never reads MDX. Code spans and JSX tags
  // are data and are stripped first.
  it('uses typographic apostrophes and quotation marks in its prose', () => {
    const prose = lines
      .map((line) => line.replace(/`[^`]*`/g, '').replace(/<[^>]*>/g, ''))
      .filter((line) => /['"]/.test(line));
    expect(prose).toEqual([]);
  });

  it('links only to pages and anchors that exist', () => {
    const targets = [
      ...[...source.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1]),
    ].filter((target) => target.startsWith('/') || target.startsWith('#'));

    const broken = targets.filter((target) => {
      const [path, anchor] = target.split('#');
      if (path === '') return !HEADING_IDS.get(slug)?.has(anchor);
      const docSlug = /^\/docs\/([^/]+)$/.exec(path)?.[1];
      if (docSlug) {
        const ids = HEADING_IDS.get(docSlug);
        return !ids || (anchor !== undefined && !ids.has(anchor));
      }
      if (path === '/faq' && anchor !== undefined) return !FAQ_IDS.has(anchor);
      return !SITE_PATHS.has(path);
    });
    expect(broken).toEqual([]);
  });
});
