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
   * The tagline's positive inversion, for the ~30-character store fields. Says
   * the same thing without the momentary "…is it broken?" reading that "can't
   * read" carries when it appears with no supporting copy around it.
   */
  subtitle: 'Bookmarks only you can read',
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
