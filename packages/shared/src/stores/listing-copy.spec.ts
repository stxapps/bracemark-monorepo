import {
  APP_STORE,
  BRAND,
  BROWSER_EXTENSION_LISTING,
  FIREFOX_ADDONS_SUMMARY,
  FULL_DESCRIPTION,
  PLAY,
  SOURCE,
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

describe('the source repository', () => {
  // `label` exists so a surface can PRINT the repo without a scheme in front of
  // it — the About colophon does. Two strings that have to say the same thing is
  // the drift this file exists to prevent, so it is asserted rather than trusted.
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
