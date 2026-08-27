import * as BRAND_MODULE from './brand';
import { SOCIAL, SOURCE } from './brand';

// The facts in brand.ts are repeated on more surfaces than anything else in the
// workspace, and every one of them is a claim a reader is entitled to rely on.
// These pin the two that go stale silently.
//
// The sibling suite for the store-listing copy — character budgets, the keyword
// field, the long description — is stores/listing-copy.spec.ts.

describe('the source repository', () => {
  // `label` exists so a surface can PRINT the repo without a scheme in front of
  // it — the About colophon does. Two strings that have to say the same thing is
  // the drift these files exist to prevent, so it is asserted rather than trusted.
  it('prints the same repository it links to', () => {
    expect(`https://${SOURCE.label}`).toBe(SOURCE.url);
  });

  // The one that a licence change would otherwise leave stale on four pages. The
  // root LICENSE file and the root package.json are the other two copies of this
  // fact; they cannot be read from here, so this pins the third.
  it('names an SPDX licence id', () => {
    expect(SOURCE.license).toBe('AGPL-3.0');
  });
});

describe('the X account', () => {
  // Same drift as SOURCE.label/url next door, and a worse one to get wrong: the
  // `@` form is what `twitter:site` publishes on every card, so a handle that has
  // stopped matching the URL credits an account that is not ours (brand.ts).
  it('links the same account it prints', () => {
    expect(SOCIAL.url).toBe(`https://x.com/${SOCIAL.handle.slice(1)}`);
  });

  // `twitter:site` is specified as the @-prefixed handle. Next passes the string
  // through untouched, so a bare one ships a meta tag no unfurler resolves.
  it('is the @-prefixed form the card metadata needs', () => {
    expect(SOCIAL.handle).toMatch(/^@[A-Za-z0-9_]{1,15}$/);
  });
});

describe('the apostrophe and the quotation marks', () => {
  // The typographic ’, never a straight ' (docs/brand-assets.md — _mechanics_).
  // `no-restricted-syntax` in the root eslint config catches the straight one in
  // SOURCE TEXT; this catches it in an exported VALUE, which is what actually
  // reaches a store console or a rendered page. The tagline and the slogan are
  // the two most-printed strings in the product, so they are worth both guards.
  //
  // Walks the whole module rather than a list of names, so an export added later
  // is covered without anyone remembering to add it here. Its twin lives in
  // stores/listing-copy.spec.ts and does the same for the listing copy.
  const everyString = (value: unknown, path: string): [string, string][] => {
    if (typeof value === 'string') return [[path, value]];
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, inner]) => everyString(inner, `${path}.${key}`));
    }
    return [];
  };

  it('is the typographic ’ in every exported string', () => {
    const offenders = everyString(BRAND_MODULE, 'brand')
      .filter(([, value]) => /[A-Za-z]'[A-Za-z]/.test(value))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  // The quotation mark is `“ ”` by the same editorial rule, and it is asserted
  // in the same walk because the cost is one line. No brand line quotes anything
  // today; the tagline or a future descriptor easily could, and the store console
  // half of that is pinned next door rather than here.
  it('is the typographic “ ” in every exported string', () => {
    const offenders = everyString(BRAND_MODULE, 'brand')
      .filter(([, value]) => value.includes('"'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
