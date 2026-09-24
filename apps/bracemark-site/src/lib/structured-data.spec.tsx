import { render } from '@testing-library/react';

import { JsonLd } from '../components/json-ld';
import { FAQ_GROUPS } from '../content/faq';
import { faqPage, plainText } from './structured-data';

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

describe('JsonLd', () => {
  it('cannot be closed early by a string inside it', () => {
    const { container } = render(<JsonLd data={{ text: '</script><b>x</b>' }} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).not.toContain('</');
    expect(JSON.parse(script?.textContent ?? '')).toEqual({ text: '</script><b>x</b>' });
  });
});
