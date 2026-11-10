import { entitlementsOf, PLAN_LABELS } from '@stxapps/shared';

import {
  formatLinks,
  linksLimitLabel,
  planLimitsLabel,
  storageIncludedLabel,
  storageLimitLabel,
} from './plans';

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

// The storage half of the card's limit line. A ceiling is printed only where it
// is published, and printed from the entitlement, so the two ways it can go
// wrong are the two pinned: a Free card that suddenly quotes "100 MB", and a
// Plus card whose number no longer matches what the server enforces.
describe('storage copy', () => {
  it('prints Plus’s ceiling from the entitlement, beside its links', () => {
    expect(entitlementsOf('plus').maxBytes).toBe(5 * 1024 ** 3);
    expect(storageLimitLabel('plus')).toBe('5 GB of storage');
    expect(planLimitsLabel('plus')).toBe('Unlimited links · 5 GB of storage');
  });

  it('leaves Free’s ceiling off the card — its link cap is the limit that binds', () => {
    expect(storageLimitLabel('free')).toBeNull();
    expect(planLimitsLabel('free')).toBe(linksLimitLabel('free'));
  });

  // The note under the comparison table. Free is IN the list it is given (the
  // table's columns), so the case worth pinning is that Free contributes no
  // clause — a note reading "Free includes …" would publish the ceiling the card
  // leaves off.
  it('names only the plans whose ceiling is published in the table’s note', () => {
    expect(storageIncludedLabel(['free', 'plus'])).toBe(
      `${PLAN_LABELS.plus} includes ${storageLimitLabel('plus')}`,
    );
    expect(storageIncludedLabel(['free'])).toBeNull();
  });
});
