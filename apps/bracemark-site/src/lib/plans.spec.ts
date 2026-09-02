import { entitlementsOf } from '@stxapps/shared';

import { formatLinks, linksLimitLabel } from './plans';

// Two things worth pinning, and only two. Both helpers are one line, so the
// value here is not the arithmetic — it is that the strings a buyer reads stay
// attached to the entitlement they claim to describe.
describe('link-limit copy', () => {
  // `maxLinks` is `null` on the paid plans, which is a number's absence, not a
  // number: interpolate it without the branch and the pricing card reads
  // "null links" — rendered, deployed, and caught by nobody.
  it('renders an absent cap as "Unlimited", never the null', () => {
    expect(entitlementsOf('plus').maxLinks).toBeNull();
    expect(formatLinks('plus')).toBe('Unlimited');
    expect(linksLimitLabel('plus')).toBe('Unlimited links');
  });

  // The whole point of the helper: a cap that IS a number comes from the
  // entitlements table rather than the copy. Asserted against `entitlementsOf`
  // and not against 200, so tuning the free cap moves the expectation with the
  // product instead of failing this file.
  it('reads a real cap off the plan', () => {
    const cap = entitlementsOf('free').maxLinks;
    expect(cap).not.toBeNull();
    expect(linksLimitLabel('free')).toBe(`${cap} links`);
  });
});
