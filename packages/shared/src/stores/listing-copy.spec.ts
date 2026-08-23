import { BRAND } from '../brand/brand';
import * as LISTING_COPY from './listing-copy';
import {
  APP_STORE,
  BROWSER_EXTENSION_LISTING,
  FIREFOX_ADDONS_SUMMARY,
  FULL_DESCRIPTION,
  PLAY,
  STORE_LIMITS,
} from './listing-copy';

// Every constraint a store console enforces is invisible in the editor and lands
// months later, on submission day, as a rejected field. This pins them so the
// failure is a red test in `npx nx test @stxapps/shared` instead.
//
// It does NOT check that the copy is good — only that it fits and is well-formed.

describe('store listing copy — character budgets', () => {
  const cases: [string, string, number][] = [
    ['App Store name', APP_STORE.name, STORE_LIMITS.appStore.name],
    ['App Store subtitle', APP_STORE.subtitle, STORE_LIMITS.appStore.subtitle],
    ['App Store keywords', APP_STORE.keywords, STORE_LIMITS.appStore.keywords],
    [
      'App Store promotional text',
      APP_STORE.promotionalText,
      STORE_LIMITS.appStore.promotionalText,
    ],
    ['App Store description', FULL_DESCRIPTION, STORE_LIMITS.appStore.description],
    ['Play title', PLAY.title, STORE_LIMITS.play.title],
    ['Play short description', PLAY.shortDescription, STORE_LIMITS.play.shortDescription],
    ['Play full description', FULL_DESCRIPTION, STORE_LIMITS.play.fullDescription],
    [
      'browser extension manifest name',
      BROWSER_EXTENSION_LISTING.name,
      STORE_LIMITS.browserExtension.name,
    ],
    [
      'browser extension manifest description',
      BROWSER_EXTENSION_LISTING.description,
      STORE_LIMITS.browserExtension.description,
    ],
    ['Firefox Add-ons summary', FIREFOX_ADDONS_SUMMARY, STORE_LIMITS.firefoxAddons.summary],
  ];

  it.each(cases)('%s fits its field', (_label, value, limit) => {
    // Stores count UTF-16 code units, which is what .length gives — the copy is
    // BMP-only (curly quotes and em dashes are single units), so no surrogate
    // pairs make this disagree with the console.
    expect(value.length).toBeLessThanOrEqual(limit);
  });

  it('leaves the tagline out of the ~30-character fields (it does not fit)', () => {
    // The guard behind BRAND.subtitle existing at all: someone tidying "duplicate"
    // copy would reach for the tagline here, and it is 51 characters.
    expect(BRAND.tagline.length).toBeGreaterThan(STORE_LIMITS.appStore.subtitle);
    expect(APP_STORE.subtitle).toBe(BRAND.subtitle);
  });
});

describe('App Store keyword field', () => {
  const keywords = APP_STORE.keywords.split(',');

  it('has no spaces — every one is an indexed character', () => {
    expect(APP_STORE.keywords).not.toMatch(/\s/);
  });

  it('has no empty or duplicated terms', () => {
    expect(keywords).not.toContain('');
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('never repeats a word already in the name or subtitle', () => {
    // Apple indexes name and subtitle separately from this field, so a word in
    // both is budget spent twice on one term. Exact-token match only: Apple's own
    // plural handling is inconsistent enough that "bookmark" vs "bookmarks" is a
    // judgement call, not a rule a test should make.
    const indexedElsewhere = new Set(
      `${APP_STORE.name} ${APP_STORE.subtitle}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    expect(keywords.filter((k) => indexedElsewhere.has(k))).toEqual([]);
  });

  it('names no competitor — a trademark here is a 2.3.7 rejection', () => {
    for (const mark of ['pocket', 'raindrop', 'pinboard', 'instapaper', 'evernote', 'notion']) {
      expect(keywords).not.toContain(mark);
    }
  });
});

describe('the long description', () => {
  it('names no other mobile platform (App Store guideline 2.3.10)', () => {
    // "on iPhone, iPad and Android" is the natural line for someone to add to a
    // features list, and it gets the build rejected. Browser names are fine and
    // deliberately not matched here — the description says "Chrome and Firefox".
    expect(FULL_DESCRIPTION).not.toMatch(/\b(android|google play|play store|windows|iphone)\b/i);
  });

  it('never writes "extension" bare (docs/architecture.md — naming)', () => {
    // Two unrelated things carry the name; a store listing is read by people who
    // know about neither, so the qualifier matters most here.
    const bare = [...FULL_DESCRIPTION.matchAll(/(\w+)\s+extension/gi)].filter(
      ([, word]) => word.toLowerCase() !== 'browser',
    );
    expect(bare).toEqual([]);
    expect(FULL_DESCRIPTION).not.toMatch(/^extension\b/im);
  });

  it('quotes no price, cap or trial length (they change without a review)', () => {
    // Numbers belong in APP_STORE.promotionalText, which Apple lets us edit
    // outside the review cycle. Anything here goes stale on the storefront for as
    // long as a review takes. Bullets are "•", so no digit is legitimate.
    expect(FULL_DESCRIPTION).not.toMatch(/\d/);
  });
});

describe('the apostrophe and the quotation marks', () => {
  // The apostrophe is an editorial choice, not a consequence of the quote character
  // the literal happens to sit in (docs/brand-assets.md — _mechanics_). Prettier
  // picks whichever quote needs fewer escapes, so a straight `'` in prose quietly
  // flips its literal to double quotes and the next sentence gets written to match
  // — which is how the same recovery-code sentence ended up existing in both forms.
  //
  // This is asserted HERE rather than left to review because these strings are the
  // ones that leave the repo: BROWSER_EXTENSION_LISTING and FIREFOX_ADDONS_SUMMARY
  // are read into the browser extension's manifest at build time, and the rest are
  // pasted into a store console. The budget cases above cannot catch it — U+2019 is
  // one UTF-16 code unit, exactly like `'`, so no length moves.
  //
  // Walks the whole module rather than a list of names, so an export added later
  // is covered without anyone remembering to add it here. Its twin lives in
  // brand/brand.spec.ts and does the same for the brand lines, COMPANY and SOURCE.
  const everyString = (value: unknown, path: string): [string, string][] => {
    if (typeof value === 'string') return [[path, value]];
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, inner]) => everyString(inner, `${path}.${key}`));
    }
    return [];
  };

  it('is the typographic ’ in every exported string', () => {
    // Between two letters, which is an apostrophe and nothing else. A bare `'` is
    // left alone: no exported string is a quotation today, but one could be.
    const offenders = everyString(LISTING_COPY, 'listing-copy')
      .filter(([, value]) => /[A-Za-z]'[A-Za-z]/.test(value))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  // `“ ”`, never a straight `"` — the same editorial rule, and it matters most
  // exactly here. FULL_DESCRIPTION is the one export long enough to quote
  // anything, `no-restricted-syntax` cannot see a straight `"` inside a
  // single-quoted literal, and the value goes into a store console by hand where
  // a review would be the only other check. Unlike the apostrophe there is no
  // between-two-letters test to write: a `"` in an exported listing string is a
  // quotation mark in every case, so the whole character is barred.
  it('is the typographic “ ” in every exported string', () => {
    const offenders = everyString(LISTING_COPY, 'listing-copy')
      .filter(([, value]) => value.includes('"'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
