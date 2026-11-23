import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';

import { JsonLd } from '../components/json-ld';
import { BLOG_POSTS } from '../content/blog';
import { FAQ_GROUPS } from '../content/faq';
import { SITE_URL } from './site';
import { blogPosting, faqPage, plainText, SITE_GRAPH } from './structured-data';

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

describe('JsonLd', () => {
  it('cannot be closed early by a string inside it', () => {
    const { container } = render(<JsonLd data={{ text: '</script><b>x</b>' }} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).not.toContain('</');
    expect(JSON.parse(script?.textContent ?? '')).toEqual({ text: '</script><b>x</b>' });
  });
});
