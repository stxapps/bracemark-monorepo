import { BRAND } from '../brand/brand';
import * as LISTING_COPY from './listing-copy';
import {
  APP_STORE,
  APP_STORE_SUBSCRIPTION,
  BROWSER_EXTENSION_LISTING,
  FIREFOX_ADDONS_SUMMARY,
  FULL_DESCRIPTION,
  PLAY,
  SCREENSHOT_CAPTIONS,
  STORE_LIMITS,
} from './listing-copy';

// Every constraint a store console enforces is invisible in the editor and lands
// months later, on submission day, as a rejected field. This pins them so the
// failure is a red test in `npx nx test @stxapps/shared` instead.
//
// It does NOT check that the copy is good — only that it fits and is well-formed.

// Walks the whole module rather than a list of names, so an export added later is
// covered without anyone remembering to add it here. Its twin lives in
// brand/brand.spec.ts and does the same for the brand lines, COMPANY and SOURCE.
const everyString = (value: unknown, path: string): [string, string][] => {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => everyString(inner, `${path}.${key}`));
  }
  return [];
};

const EVERY_EXPORTED_STRING = everyString(LISTING_COPY, 'listing-copy');

const offending = (test: (value: string) => boolean) =>
  EVERY_EXPORTED_STRING.filter(([, value]) => test(value)).map(([path]) => path);

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
    [
      'App Store subscription group display name',
      APP_STORE_SUBSCRIPTION.groupDisplayName,
      STORE_LIMITS.appStoreSubscription.groupDisplayName,
    ],
    [
      'App Store Plus display name',
      APP_STORE_SUBSCRIPTION.plus.displayName,
      STORE_LIMITS.appStoreSubscription.displayName,
    ],
    [
      'App Store Plus description',
      APP_STORE_SUBSCRIPTION.plus.description,
      STORE_LIMITS.appStoreSubscription.description,
    ],
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
    // Every caption, found by walking the object rather than listed — a fifth
    // screenshot must not be able to arrive without its line being measured.
    ...Object.entries(SCREENSHOT_CAPTIONS).map(([slug, caption]): [string, string, number] => [
      `screenshot caption \`${slug}\``,
      caption,
      STORE_LIMITS.screenshotCaption.caption,
    ]),
  ];

  // The caption cases are the odd ones out and it is worth knowing which way:
  // every other limit here is a console's and lands as a rejection, while a long
  // caption is accepted by both stores and simply spends the picture's room on
  // itself. This is the only place that number is enforced at all.
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

describe('rules that bind every exported string', () => {
  // The rules below were each written against FULL_DESCRIPTION, which is the one
  // export a human pastes and re-reads. The strings that actually ship UNWATCHED
  // are the other ones: BROWSER_EXTENSION_LISTING is read into manifest.json by
  // wxt.config.ts at build time, and the short fields are pasted once and never
  // opened again — which is how Brace.to v1's copy survived the whole rename. So
  // they range over the module.

  it('never writes "extension" bare (docs/architecture.md — naming)', () => {
    // Two unrelated things carry the name — the browser extension and
    // bracemark-expo's iOS share extension. A store listing is read by people who
    // know about neither, so the qualifier matters more here than anywhere.
    const bare = offending(
      (value) =>
        [...value.matchAll(/(\w+)\s+extension/gi)].some(
          ([, word]) => word.toLowerCase() !== 'browser',
        ) || /^extension\b/im.test(value),
    );
    expect(bare).toEqual([]);
  });

  // The server claims. Nothing else in the workspace can catch these: the tables
  // that make them true or false live in bracemark-api, a different app, and the
  // wording sounds MORE rigorous the more wrong it gets. Each of these spellings
  // reached shipped copy at least once (docs/local-first-sync.md), so they are
  // barred by name rather than by a rule someone has to re-derive.
  const BANNED: [RegExp, string][] = [
    [
      /sees? nothing\b/i,
      'the same host holds the username, public key, sessions and plan in the clear',
    ],
    [
      /only ever sees? ciphertext/i,
      'true of R2 alone, not of the Worker that serves auth and billing',
    ],
    [/ciphertext and nothing else/i, 'an enumeration that closes, and it closes on a subset'],
    [/nothing else (?:on file|about you)/i, 'same closed enumeration, one step quieter'],
    [
      /\bsync server\b/i,
      'there is no separate sync server — inventing one to carry a smaller claim is the same error',
    ],
    [
      /before (?:it|they|anything|any of it) (?:ever )?leaves? (?:your|the) (?:device|browser|phone)/i,
      'bracemark-extractor is handed a plaintext URL by construction — say "before it syncs"',
    ],
  ];

  it.each(BANNED)('makes no claim matching %s (%s)', (pattern) => {
    expect(offending((value) => pattern.test(value))).toEqual([]);
  });

  it('keeps the holdings enumeration scoped to the library', () => {
    // "our servers hold a path, a size, and bytes we have no key for" is true of
    // the LIBRARY and false as a sentence about the servers. Dropping the two
    // scoping words is a plausible edit — it reads tighter — and it turns the
    // sentence into a claim a reader can falsify from /privacy. Asserted on the
    // sentence rather than the whole string so the scope cannot drift into a
    // different paragraph.
    const sentenceWithTheClaim = (value: string) =>
      value.split('.').find((sentence) => /bytes we have no key for/i.test(sentence));

    const unscoped = offending((value) => {
      const sentence = sentenceWithTheClaim(value);
      return sentence !== undefined && !/\bof your library\b/i.test(sentence);
    });
    expect(unscoped).toEqual([]);

    // And the enumeration is load-bearing enough that it has to still be there:
    // the two strings that carry it are the product's whole argument.
    expect(EVERY_EXPORTED_STRING.filter(([, v]) => sentenceWithTheClaim(v)).length).toBe(2);
  });
});

describe('the strings Apple reads', () => {
  // Guideline 2.3.10 binds every Apple-bound field, not just the description —
  // and the promotional text is the likeliest place to trip it, because it is the
  // field for launch notes and "now on Android too" is exactly the note someone
  // would write there. FULL_DESCRIPTION is included: Apple reads it too.
  const appleFields = everyString(APP_STORE, 'APP_STORE').concat([
    ['FULL_DESCRIPTION', FULL_DESCRIPTION],
  ]);

  it.each(appleFields)('%s names no other mobile platform (guideline 2.3.10)', (_path, value) => {
    // "on iPhone, iPad and Android" is the natural line for someone to add to a
    // features list, and it gets the build rejected. Browser names are fine and
    // deliberately not matched — the description says "Chrome and Firefox".
    expect(value).not.toMatch(/\b(android|google play|play store|windows|iphone)\b/i);
  });
});

describe('the long description', () => {
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

  it('is the typographic ’ in every exported string', () => {
    // Between two letters, which is an apostrophe and nothing else. A bare `'` is
    // left alone: no exported string is a quotation today, but one could be.
    expect(offending((value) => /[A-Za-z]'[A-Za-z]/.test(value))).toEqual([]);
  });

  // `“ ”`, never a straight `"` — the same editorial rule, and it matters most
  // exactly here. FULL_DESCRIPTION is the one export long enough to quote
  // anything, `no-restricted-syntax` cannot see a straight `"` inside a
  // single-quoted literal, and the value goes into a store console by hand where
  // a review would be the only other check. Unlike the apostrophe there is no
  // between-two-letters test to write: a `"` in an exported listing string is a
  // quotation mark in every case, so the whole character is barred.
  it('is the typographic “ ” in every exported string', () => {
    expect(offending((value) => value.includes('"'))).toEqual([]);
  });
});
