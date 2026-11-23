import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';

import sitemap from '../app/sitemap';
import { JsonLd } from '../components/json-ld';
import { BLOG_POSTS } from '../content/blog';
import { DOC_GROUPS } from '../content/docs';
import { FAQ_GROUPS } from '../content/faq';
import { SITE_URL } from './site';
import { blogPosting, docsArticle, faqPage, plainText, SITE_GRAPH } from './structured-data';

const ALL_ITEMS = FAQ_GROUPS.flatMap((group) => group.items);

/** What a reader of the rendered page sees, whitespace collapsed the same way. */
function renderedText(node: React.ReactNode): string {
  const { container } = render(<div>{node}</div>);
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// The FAQPage answers are extracted from JSX without rendering it, and nobody
// reads JSON-LD — so an answer that lost a clause in extraction (a component
// whose text is not its children) would publish a different answer to machines
// than to people, with nothing anywhere to show it. The DOM is the reference.
describe('FAQPage answers', () => {
  it.each(ALL_ITEMS.map((item) => [item.id, item] as const))(
    '%s says in JSON-LD what it says on the page',
    (_id, item) => {
      expect(plainText(item.a)).toBe(renderedText(item.a));
    },
  );

  it('carries every question on /faq, once', () => {
    const questions = faqPage(FAQ_GROUPS).mainEntity.map((entry) => entry.name);
    expect(questions).toEqual(ALL_ITEMS.map((item) => item.q));
  });
});

// A post page is read on its own: an `@id` resolves only against nodes on the
// same page. The publisher used to be a bare `{ '@id' }` into the landing page's
// graph, which on a post page is an organisation with no name — valid JSON-LD,
// a clean build, and nothing in Google's eyes. So the node must be there in
// full, and the SAME node as the landing page's, or the two would describe two
// organisations under one id.
describe('BlogPosting', () => {
  const organization = SITE_GRAPH['@graph'].find((node) => node['@type'] === 'Organization');

  it.each(BLOG_POSTS.map((post) => [post.slug, post] as const))(
    '%s names its publisher on its own page',
    (_slug, post) => {
      expect(organization).toBeDefined();
      expect(blogPosting(post).publisher).toEqual(organization);
      expect(blogPosting(post).publisher.name).toBeTruthy();
    },
  );

  // The image is the card the page already publishes as og:image — a Next file
  // convention beside the root layout. Renaming or deleting the file moves the
  // og:image with it, and would leave this URL a 404 with nothing else noticing.
  it('points its image at the card file the site serves', () => {
    const [post] = BLOG_POSTS;
    const image = blogPosting(post).image;
    expect(image.startsWith(`${SITE_URL}/`)).toBe(true);
    const file = image.slice(SITE_URL.length + 1);
    expect(existsSync(join(__dirname, '..', 'app', file))).toBe(true);
  });
});

// A docs page's article and breadcrumb are read by machines and proofread by
// nobody, so they may only say what the page prints: its H1, the description
// under it, and the group as its eyebrow. And a breadcrumb step is a URL a
// search result links to — one that is not a sitemap URL is a 404 or a 301 under
// the page's own name in the results.
describe('docs TechArticle', () => {
  const listed = new Set(sitemap().map((entry) => entry.url));
  const organization = SITE_GRAPH['@graph'].find((node) => node['@type'] === 'Organization');
  const cases = DOC_GROUPS.flatMap((group) =>
    group.pages.map((page) => [page.slug, page, group] as const),
  );

  it.each(cases)('%s says what the page prints, under its own URL', (slug, page, group) => {
    const [article] = docsArticle(page, group)['@graph'];
    expect(article).toMatchObject({
      '@type': 'TechArticle',
      headline: page.title,
      description: page.description,
      articleSection: group.title,
      url: `${SITE_URL}/docs/${slug}`,
    });
    expect(listed.has(article.url as string)).toBe(true);
    expect(article.publisher).toEqual(organization);
  });

  it.each(cases)('%s has a breadcrumb of sitemap URLs ending at itself', (slug, page, group) => {
    const [, breadcrumb] = docsArticle(page, group)['@graph'];
    const steps = breadcrumb.itemListElement as { position: number; item: string; name: string }[];
    expect(steps.map((step) => step.position)).toEqual(steps.map((_, index) => index + 1));
    for (const step of steps) expect([step.item, listed.has(step.item)]).toEqual([step.item, true]);
    expect(steps.at(-1)).toMatchObject({ name: page.title, item: `${SITE_URL}/docs/${slug}` });
  });
});

describe('JsonLd', () => {
  it('cannot be closed early by a string inside it', () => {
    const { container } = render(<JsonLd data={{ text: '</script><b>x</b>' }} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).not.toContain('</');
    expect(JSON.parse(script?.textContent ?? '')).toEqual({ text: '</script><b>x</b>' });
  });
});
