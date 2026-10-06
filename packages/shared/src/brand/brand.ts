// What the product is called, who publishes it, and where its source lives — the
// three facts every public surface repeats. Not store copy: these are read by
// Settings → About in both apps, the marketing site's footer, /about, /faq,
// /terms and /privacy, the landing screen, the brand lockup and the sync gate,
// and only INCIDENTALLY by the store listings next door in stores/listing-copy.ts.
//
// They lived in that file until this split, under a folder named for one of their
// consumers. The argument for one file is unchanged and is the whole point: a name
// that is right on five surfaces and stale on the sixth is worth nothing, and
// nothing but a single definition enforces the agreement.
//
// It is `platform:agnostic`, so it must stay portable to all three engines
// (browsers, workerd, Hermes) — strings always are, but keep it that way: no
// runtime, no imports beyond this package. See docs/architecture.md.

// ⚠ ONE CONSUMER CAN'T IMPORT THIS. The company site at stxapps.com lives in its
// own repo (stxapps/stxapps-site), and it copies `name`, `descriptor`, `tagline`
// and `slogan` verbatim into its `src/content/bracemark.ts`. When one of those
// lines changes here, change it there too. Nothing checks that the two copies
// agree, and a stale line on the company site renders just as well as a current one.

/** The three brand lines, in the order of how much room the surface has. */
export const BRAND = {
  name: 'Bracemark',

  /** What it is, with no wit, for surfaces that supply no context of their own. */
  descriptor: 'End-to-end encrypted bookmark manager',

  /**
   * The hook. Names the category and the mechanism in one clause, and states it
   * as an inability rather than an intention — which is the whole positioning.
   * Too long (51) for any store's name or subtitle field; those get `SUBTITLE`.
   */
  tagline: 'The bookmark manager that can’t read your bookmarks',

  /** The belief, for sign-offs. Deliberately the shortest thing we say. */
  slogan: 'We don’t promise not to look. We built it so we can’t.',

  /**
   * The store-length mechanism. The listing name already supplies the bookmark
   * category; this uses the product's object noun and says where encryption
   * happens, without the tagline's momentary "…is it broken?" reading.
   */
  subtitle: 'Links encrypted on your device',
} as const;

// The signature panel — what you see, and what we store — as the strings its
// drawings share. The marketing site's hero draws it in JSX
// (apps/bracemark-site/src/app/page.tsx, `HeroPanel`, which argues every value
// below); a picture that draws the same object is composed outside this repo and
// reads these through `tools/scripts/check-assets.ts`. They are here for the
// reason the three lines above are: two drawings of one object is two things to
// keep true, and this panel has already been wrong once in a way a reader could
// check — it showed a path and a size while /privacy inventoried a timestamp as
// well. A second copy typed beside the art would have kept the old inventory.
//
// THE TWO HALVES' OWN STRINGS, AND THE ONE SENTENCE THAT SAYS THEM. `caption` is
// the panel in words — what a surface that cannot show it has to say instead, a
// text alternative above all. It is here because that sentence is the one a
// second copy would get wrong: the stored record read aloud is a bare list, and a
// bare list of what our servers hold is a closed enumeration with its scope gone.
// The paragraph AFTER it on the site — what the shape still tells us — stays in
// page.tsx, on the one surface with room to argue it. So does the plaintext
// half's specimen, which the site draws and a capture photographs.
//
// ILLUSTRATIVE, NOT INVENTED. `links/{id}.enc` is the real path shape
// (`sync/paths`), and a path, a size and when the file last changed are exactly
// what /privacy inventories for one link. `ciphertext` is texture — never read as
// prose, and not the output of anything.
export const SIGNATURE = {
  /** The plaintext half's eyebrow. */
  deviceLabel: 'On your device',

  /** The seam between the halves: the mechanism, named rather than described. */
  cipher: 'AES-256-GCM',

  /** The ciphertext half's eyebrow. */
  serverLabel: 'What our servers store',

  path: 'links/01JD7QK2X8N4WYB3F0.enc',
  size: '2.1 KB',

  /**
   * Relative rather than a date: an illustration with a hard-coded year reads as
   * abandoned two years later.
   */
  changed: 'last changed 2 minutes ago',

  ciphertext:
    'k7QpV0sZ4mL8xR1cGf9tYb2NwJ3hD6aE5uT0iO8pA1sD4fG7hJ2kL5nM8qR3tV6x' +
    'Z9yB2nM5kJ8hG1fD4sA7pO0iU3tE6rW9qY2xC5vB8nM1kL4jH7gF0dS3aP6oI9uY' +
    '2tR5eW8qA1zX4cV7bN0mK3jH6gF9dS2aP5oI8uY1tR4eW7qZ0xC3vB6nM9kJ2hG5',

  /**
   * The panel in one sentence. "no key to open", never the compressed "no key
   * for" — page.tsx argues the verb beside the paragraph that prints this.
   */
  caption:
    'A path, a size, a timestamp, and bytes we hold no key to open. Not the title, not the address, not the tags — there is nowhere for them to be.',
} as const;

// The legal entity behind Bracemark, and the postal address of record.
//
// It moved out of bracemark-site's `lib/site.ts` when a fifth and sixth surface
// needed it: the marketing site's /terms, /privacy and footer, and Settings →
// About in both bracemark-web and bracemark-expo. Site-local was right while the
// site was the only thing that published a company name; an app that names a
// DIFFERENT entity than the store listing does is a review rejection, which is the
// same failure mode the brand lines above are here to prevent.
export const COMPANY = {
  legalName: 'STX Apps Co., Ltd.',
  shortName: 'STX Apps',
  attn: 'Bracemark Team',
  addressLines: ['247 Chan 31 Sathon', 'Bangkok 10120', 'Thailand'],
  /**
   * The company's own website — not Bracemark's, which is the marketing site on
   * the apex. Read by the marketing site's structured data, which names the
   * publisher behind the product.
   */
  url: 'https://stxapps.com',
} as const;

// The public repository, and the licence it is published under. Here for the same
// reason COMPANY is: six surfaces name it — the marketing site's footer, /about,
// /faq and /privacy, Settings → About in both apps — and a URL that is right in
// five of them is worth nothing.
//
// `license` is the SPDX id of the root LICENSE file, and the root package.json
// must agree with it. It said `MIT` for a while against an AGPL-3.0 LICENSE, which
// is not a cosmetic disagreement: a reader is entitled to rely on either, and the
// permissive one is the one they would rely on.
//
// WHAT THIS DOES AND DOES NOT LET US CLAIM (docs/brand-assets.md — _the source_). It lets
// a visitor READ what we do. It does NOT let them verify that the JavaScript their
// browser just ran was built from it — there is no reproducible build and no
// signed release. Every surface below is written to the first claim. "See for
// yourself what we do", never "verify what you are running".
export const SOURCE = {
  url: 'https://github.com/stxapps/bracemark-monorepo',
  /** The URL without its scheme, for surfaces that print it rather than link it. */
  label: 'github.com/stxapps/bracemark-monorepo',
  license: 'AGPL-3.0',
} as const;

// The X account, in the two spellings its surfaces need.
//
// Here rather than in bracemark-site's `lib/site.ts` for the same reason COMPANY
// and SOURCE are: more than one origin names it. Both apps' card metadata sets
// `twitter:site` — and bracemark-web is a separate app on a separate host, which
// cannot read the site's config — while the marketing footer links it.
//
// ⚠ THE FAILURE MODE IS A HANDLE THAT IS WRONG RATHER THAN MISSING. `twitter.site`
// in both layouts sat deliberately EMPTY until this existed, because the value it
// used to hold was `@bracedotto` — Brace.to's handle, from the predecessor — and a
// stale one there credits someone else's account on every card that unfurls, with
// no error anywhere: a card carrying the wrong @ renders exactly as well as a
// right one. That is what makes this worth a constant rather than two literals.
//
// The account is `@bracemarkapp` and not `@bracemark`, which was already taken.
// So the product name is only ever right in the DISPLAY name, which X owns and
// this file cannot pin — one more reason no surface should retype the handle.
//
// `handle` is the `@` form Next's `twitter.site` takes; `url` is for links. The
// two have to agree, and brand.spec.ts asserts that they do.
export const SOCIAL = {
  handle: '@bracemarkapp',
  url: 'https://x.com/bracemarkapp',
} as const;

// The predecessor product, named by two surfaces on the marketing site — the
// landing page's `If we disappear` footnote and /about's _Where it came from_ —
// and by nothing else. It is here rather than in bracemark-site's `lib/site.ts`
// for the same reason SOURCE and SOCIAL are: a URL that two surfaces retype is a
// URL one of them can be wrong about, and this one points off our own origins.
//
// ⚠ IT IS THE MOST CHECKABLE CLAIM ON THE PROPERTY, WHICH IS WHY IT MUST STAY
// CHECKABLE. "A bookmark manager we have run for years" was the weakest form of
// the strongest durability fact we own — three readers in a positioning test went
// looking for something to click and found a bare product name, which reads as a
// track record we would rather not have examined. A year and a link cost nothing
// and are the entire difference between an assertion and a citation.
//
// `since` is the year it launched, printed as "since 2020" rather than as an age.
// An age computed from `new Date()` would be a number that changes under a page
// that was not rebuilt, and it re-opens the arithmetic every reader has to redo;
// a year is stated once and stays true.
//
// ⚠ THE LINK IS A CLAIM THAT IT ANSWERS. Both surfaces sit inside copy that says
// nothing here is retired or dead, so the link is load-bearing prose and not a
// courtesy: a reader who clicks through to a domain that no longer answers has
// been shown the opposite of the point. If brace.to ever stops serving, the link
// comes out of BOTH surfaces and the sentences around it are re-read in the same
// change — the tense of "we have run for years" is the part that goes stale
// first. Nothing catches that: no lint rule, no type error, no test in either
// runner can reach a third-party origin, and a dead link renders exactly as well
// as a live one.
export const PREDECESSOR = {
  name: 'Brace.to',
  url: 'https://brace.to',
  since: 2020,
} as const;
