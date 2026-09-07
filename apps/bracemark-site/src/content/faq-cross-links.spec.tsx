import { render } from '@testing-library/react';

import FaqPage from '../app/faq/page';
import PricingPage from '../app/pricing/page';
import { FAQ_GROUPS, type FaqItem, PRICING_FAQ_IDS } from './faq';

// An FAQ answer that points at a SIBLING answer points at a place, and the place
// depends on which page is rendering it — /faq renders every group, /pricing
// renders the six ids in `PRICING_FAQ_IDS`. `HashLink` resolves that per surface
// by emitting a bare `#id`, which is correct on both and checkable on neither:
//
//   - a fragment with no matching element on the page scrolls NOWHERE. The
//     browser reports nothing, the console stays clean, and the reader gets a
//     link that visibly does nothing when clicked;
//   - nothing in the type system connects a link inside `monthly`'s answer to
//     `refunds` being in `PRICING_FAQ_IDS`. Removing an id from that list is a
//     one-line edit that compiles, lints, builds and ships;
//   - `/pricing` grows the anchors from the same list, so deleting `id={id}` from
//     the grid cell breaks every such link at once, silently.
//
// Which is three ways to publish a dead link and no way to notice. This file is
// the notice. It is the same move `app/security/reporting-terms.spec.tsx` makes
// for the disclosure windows: assert the INVARIANT against the data, never
// against a hand-written list of ids, so retargeting a link is legitimate and
// stranding one is a failure.

const ALL_ITEMS: FaqItem[] = FAQ_GROUPS.flatMap((group) => group.items);
const ALL_IDS = new Set(ALL_ITEMS.map((item) => item.id));
const PRICING_IDS = new Set<string>(PRICING_FAQ_IDS);

/** The fragments one answer aims at another, read from the rendered anchors. */
function hashTargets(item: FaqItem): string[] {
  const { container } = render(<div>{item.a}</div>);
  return Array.from(container.querySelectorAll('a[href^="#"]')).map((a) =>
    (a.getAttribute('href') ?? '').slice(1),
  );
}

/** Every answer paired with what it links to — most pair with nothing. */
const LINKS: [string, string][] = ALL_ITEMS.flatMap((item) =>
  hashTargets(item).map((target): [string, string] => [item.id, target]),
);

describe('FAQ answers that link to other FAQ answers', () => {
  // Guards the guard: if the links are ever rewritten back to the absolute
  // `/faq#…` form, `LINKS` empties and every assertion below passes vacuously.
  it('exist at all, so the cases below are not vacuous', () => {
    expect(LINKS.length).toBeGreaterThan(0);
  });

  it.each(LINKS)('%s → #%s points at an answer that exists', (_source, target) => {
    expect(ALL_IDS.has(target)).toBe(true);
  });

  // The pricing-page half, and the one a content edit actually threatens: an
  // answer rendered on /pricing may only point at another answer rendered on
  // /pricing, because that is the page the fragment resolves against there.
  it.each(LINKS)('%s → #%s resolves on /pricing as well as /faq', (source, target) => {
    if (!PRICING_IDS.has(source)) return;
    expect(PRICING_IDS.has(target)).toBe(true);
  });

  // Asserted against the RENDERED page rather than the source, so the anchor
  // surviving a refactor of the grid is what passes — not the string `id={id}`.
  it('/pricing gives every question it renders an anchor to land on', () => {
    const { container } = render(<PricingPage />);
    for (const id of PRICING_FAQ_IDS) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  // The absolute form is correct from a surface that is NOT the FAQ (/security
  // points at `compelled` that way) and wrong between two answers, where it
  // throws a /pricing reader off the page they are deciding on.
  it.each(ALL_ITEMS.map((item): [string, FaqItem] => [item.id, item]))(
    '%s uses a fragment, not an absolute /faq link, for a sibling answer',
    (_id, item) => {
      const { container } = render(<div>{item.a}</div>);
      const absolute = Array.from(container.querySelectorAll('a[href*="/faq#"]'));
      expect(absolute).toHaveLength(0);
    },
  );

  // ⚠ THE /faq HALF, AND THE ONE JSDOM CAN ONLY HALF-SEE. Every answer there is
  // inside a <details> that is CLOSED on load, and a browser reveals a closed
  // <details> only when the fragment lands on a node inside its collapsed part.
  // Measured in Chromium and WebKit, which agree: an id on the <details> leaves it
  // shut, an id on the <summary> leaves it shut, an id on the answer body opens it.
  // So a link that passes every assertion above can still deliver the reader to a
  // question with the answer folded away.
  //
  // jsdom has no fragment navigation, so that behaviour cannot be asserted here —
  // what can is the STRUCTURE it depends on, which is the part an ordinary edit
  // breaks: moving the id back up to the <details> for tidiness, or onto the
  // <summary> because that is where the question is. The real behaviour is pinned
  // by measurement in the page's own comment; this keeps the shape that earns it.
  describe('the /faq anchors those fragments land on', () => {
    // Rendered inside each case, not once for the describe: testing-library
    // unmounts everything after every test, so a container captured out here is
    // an empty node by the time the second case reads it — and every assertion
    // below would then fail loudly rather than pass quietly, which is the only
    // reason this is a comment and not a bug.
    const faqDom = () => render(<FaqPage />).container;

    it.each(ALL_ITEMS.map((item): [string] => [item.id]))(
      '#%s sits inside the collapsed part of its <details>, not on the row or its summary',
      (id) => {
        const target = faqDom().querySelector(`#${id}`);
        expect(target).not.toBeNull();

        const details = target?.closest('details');
        expect(details).not.toBeNull();
        // Both of these render fine and scroll fine, and both leave the row shut.
        expect(target?.tagName).not.toBe('DETAILS');
        expect(target?.tagName).not.toBe('SUMMARY');
        expect(details?.querySelector('summary')?.contains(target ?? null)).toBe(false);
      },
    );

    // The margin, not its value: 12rem is a measurement against today's header and
    // today's longest question, and re-tuning it is a legitimate edit. Losing it
    // is not — the answer would land correctly and the question above it would sit
    // under the sticky header, which is the failure the value exists to prevent.
    it.each(ALL_ITEMS.map((item): [string] => [item.id]))(
      '#%s carries a scroll margin to clear the sticky header',
      (id) => {
        expect(faqDom().querySelector(`#${id}`)?.className).toMatch(/\bscroll-mt-/);
      },
    );
  });
});
