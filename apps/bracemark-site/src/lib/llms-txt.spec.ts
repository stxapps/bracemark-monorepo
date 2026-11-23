/**
 * @jest-environment node
 */
import sitemap from '../app/sitemap';
import { publishedBlogPosts } from '../content/blog';
import { DOC_PAGES } from '../content/docs';
import { llmsTxt } from './llms-txt';
import { SITE_DESCRIPTION, SITE_URL } from './site';

const ITEM = /^- \[([^\]]+)\]\((\S+)\)(?:: (.+))?$/;

/** The file as the llmstxt.org grammar reads it, failing on any line it doesn't. */
function parse(body: string) {
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  const [h1, summary, ...rest] = lines;
  const items: { title: string; url: string; note?: string }[] = [];
  const stray: string[] = [];
  for (const line of rest) {
    const match = ITEM.exec(line);
    if (match) items.push({ title: match[1], url: match[2], note: match[3] });
    else if (!line.startsWith('## ')) stray.push(line);
  }
  return { h1, summary, items, stray };
}

describe('/llms.txt', () => {
  const body = llmsTxt();
  const { h1, summary, items, stray } = parse(body);

  // An agent reads this with a parser, not a browser: a line that is neither a
  // heading nor a link item is one it drops or, worse, folds into the entry
  // above it. The summary is the meta description, not a sentence of its own.
  it('is one H1, the site description, then sections of link items', () => {
    expect(h1).toBe('# Bracemark');
    expect(summary).toBe(`> ${SITE_DESCRIPTION}`);
    expect(stray).toEqual([]);
    expect(items.length).toBeGreaterThan(0);
  });

  // The likely drift is the sitemap's: a docs page or a post that ships without
  // an entry here, which nothing else would notice. Derived from the manifests,
  // so a new page moves this spec with it.
  it('lists every docs page and published post once, with its own description', () => {
    const expected = [
      ...DOC_PAGES.map((page) => [`${SITE_URL}/docs/${page.slug}`, page.description]),
      ...publishedBlogPosts().map((post) => [`${SITE_URL}/blog/${post.slug}`, post.description]),
    ];
    for (const [url, description] of expected) {
      const entries = items.filter((entry) => entry.url === url);
      expect([url, entries.length]).toEqual([url, 1]);
      expect([url, entries[0]?.note]).toEqual([url, description.replace(/\s+/g, ' ').trim()]);
    }
  });

  // An own-origin link that is not a sitemap URL is a 404 or a 301 — a page that
  // was renamed or a trailing slash — and an agent following this file is exactly
  // the reader who will not go looking for the right one.
  it('links only to pages the sitemap lists, on this site', () => {
    const listed = new Set(sitemap().map((entry) => entry.url));
    const own = items.filter((entry) => entry.url.startsWith(SITE_URL));
    expect(own.length).toBeGreaterThan(DOC_PAGES.length);
    for (const entry of own) {
      expect([entry.url, listed.has(entry.url)]).toEqual([entry.url, true]);
    }
    expect(new Set(items.map((entry) => entry.url)).size).toBe(items.length);
  });

  // Nothing here is new copy (lib/llms-txt.ts): every note is a manifest's meta
  // description, word for word, so the file cannot say what no page says.
  it('carries no note that is not already a page description', () => {
    const descriptions = new Set(
      [...DOC_PAGES, ...publishedBlogPosts()].map((page) =>
        page.description.replace(/\s+/g, ' ').trim(),
      ),
    );
    for (const entry of items.filter((candidate) => candidate.note !== undefined)) {
      expect([entry.url, descriptions.has(entry.note as string)]).toEqual([entry.url, true]);
    }
  });
});
