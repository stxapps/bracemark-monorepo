// The marketing site's own configuration: where it lives, where the app lives, and
// the two nav structures the header and footer render from.
//
// The app URL is env-configured (`.env.*`), not hard-coded, for the same reason
// bracemark-web's API URL is: it differs per tier (`app.bracemark.com` vs
// `app.dryrunbase.com` vs `localhost:3000`) and is baked at build time.
// The site's OWN apex is the deliberate exception — see SITE_URL below.
// See docs/env-files.md — _bracemark-site_.

// Imported rather than re-exported blind (the way COMPANY is, below) because
// FOOTER_LINKS needs the repo URL in scope.
import { SOCIAL, SOURCE } from '@stxapps/shared';

// Throws rather than falling back to production, matching bracemark-web's
// lib/site.ts and lib/api-client.ts. A fallback here would mean a build that
// forgot the var links every "Sign in" into production from whatever tier it is
// — silently, since a plausible URL renders fine. `.env.test` is what makes the
// throw affordable: without it, jest sees no NEXT_PUBLIC_* at all and this line
// takes the suite down at import time (docs/env-files.md, _the test env_).
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set');
export const APP_URL = appUrl;

/**
 * The apex this site is served from, for the absolute OG URLs in `app/layout.tsx`
 * (`metadataBase` and `og:url` — the only two readers).
 *
 * Hard-coded to production on purpose, unlike APP_URL above. Env-driving it would
 * put `https://bracemark.com` in the deploy script's forbidden-origin list for
 * staging, where the substring match hits the `https://bracemark.com/extractor`
 * User-Agent that /extractor publishes verbatim — a tier-independent string by
 * design — and `deploy:site:staging` would refuse every build
 * (tools/scripts/deploy-static.sh, _the tier check_). The cost is that a staging
 * page unfurls with production's og:url and card image; the card image is the
 * same file in both tiers, and staging is `Disallow: /` to crawlers anyway
 * (`app/robots.ts`). Revisit if this ever feeds a canonical tag or a sitemap,
 * which would make it SEO-load-bearing rather than cosmetic.
 */
export const SITE_URL = 'https://bracemark.com';

/** Deep links into bracemark-web. The site never renders auth UI itself. */
export const SIGN_IN_URL = `${APP_URL}/sign-in`;
export const CREATE_ACCOUNT_URL = `${APP_URL}/create-account`;
// Checkout lives in the app, not here: a Paddle transaction is minted per ACCOUNT
// (POST /v1/iap/checkout stamps the account binding), so there is nothing this
// origin — which has no session — can start. /pricing therefore sends new visitors
// to create-account and returning ones to the settings section that owns the flow.
export const UPGRADE_URL = `${APP_URL}/settings/subscription`;

// The published support address, and the contact of record for App Store, Play,
// and Paddle review.
export const SUPPORT_EMAIL = 'support@bracemark.com';

// The inbound-only alias for vulnerability reports. Published
// separately from support@ so a security report doesn't queue behind "how do I
// import from Raindrop".
export const SECURITY_EMAIL = 'security@bracemark.com';

// The two disclosure windows, and the only typed copy of them left on this site.
// They are a COMMITMENT to a researcher rather than a description of anything, and
// they were published on four surfaces at once with nothing checking that the four
// agreed: SECURITY.md in the repository, the reporting block on /support, the
// reporting section on /security, and — indirectly — the `Policy:` line in
// app/.well-known/security.txt/route.ts, which decides which of the others a
// researcher's tooling reads first. Moving one and missing another does not fail a
// build; it publishes two different promises to the one audience that reads a
// missed window as a stall and goes public.
//
// Word forms rather than numerals because that is how the surfaces render them and
// a constant should not quietly restyle published copy. SECURITY.md cannot import
// this file, so it stays typed and `app/security/reporting-terms.spec.tsx` holds it
// against these values instead — the same move brand.spec.ts makes for the third
// copy of the licence (docs/brand-assets.md, _the source — what we may claim_).
// See docs/hosting.md, _/.well-known/security.txt_.
export const SECURITY_ACK_WINDOW = 'three working days';
export const SECURITY_TRIAGE_WINDOW = 'ten';

// The inbound-only alias for network-abuse reports about bracemark-extractor, and
// the reason that alias has to exist at all: the extractor names /extractor in the
// User-Agent of every outbound fetch, so its contact page is read by operators of
// sites we fetched rather than by users. RFC 2142 is what an operator guesses when
// a page gives them nothing, so guessing it should reach us — and a "your bot is
// hammering me" mail is time-critical in a way the support queue is not.
export const ABUSE_EMAIL = 'abuse@bracemark.com';

// The legal entity behind Bracemark. Re-exported, not defined: it lives in
// @stxapps/shared beside the brand lines, because the two apps' Settings → About
// name the same company and a store listing that disagrees with the app is a
// review rejection. Re-exported rather than imported at each call site so this
// file stays the one import the site's pages need for "who and where we are".
export { COMPANY } from '@stxapps/shared';

// The public repository — same argument as COMPANY, same file it comes from: four
// of this site's surfaces name it (the footer below, /about, /faq, /privacy) and
// Settings → About in both apps names it too.
export { SOURCE };

// The X account — same file, same argument, and the sharper version of it: both
// apps' card metadata publishes the handle as `twitter:site`, so a copy of it
// living here would be a second definition of a string that names an account.
export { SOCIAL };

// The predecessor product. Same argument as COMPANY: it lives in @stxapps/shared
// because it is a fact about who we are rather than about this site, and it is
// re-exported here so a page still takes "who and where we are" from one import.
// Two surfaces name it — the landing page's `If we disappear` footnote and
// /about's _Where it came from_ — and brand.ts carries the rule about what
// happens to the link if the domain ever stops answering.
export { PREDECESSOR } from '@stxapps/shared';

// Paddle's buyer refund policy — the one web purchases are refunded under, since
// Paddle is the merchant of record. Linked, not paraphrased: Paddle's seller
// review asks for either a link to it or a refund policy of our own with a
// 14–90-day window, and restating theirs would be a copy that drifts. Three
// surfaces name it — /terms (_Refunds_), /faq (`refunds`) and the footer's Legal
// column (FOOTER_LINKS below).
export const PADDLE_REFUND_POLICY_URL = 'https://www.paddle.com/legal/refund-policy';

// The "last updated" line each policy carries. Dates live here rather than inline
// so the two documents can never claim different vintages of the same rewrite —
// and so bumping one after an edit is a deliberate act, not a forgotten one.
export const TERMS_UPDATED = '18 September 2026';
export const PRIVACY_UPDATED = '23 September 2026';

// How long a backup outlives what it copies — the window /privacy (_Backups_,
// and the key-blob line above it) and /delete-account (_What is deleted_, _What
// is kept_) promise. It is not free to change in either direction. This line is
// the only copy of the number: what prunes our own off-Cloudflare copies reads
// it from here, so keep it a bare integer literal. Cloudflare's own history (D1
// Time Travel, Durable Object point-in-time recovery) is fixed at 30 days, so a
// smaller number here would be false the day it shipped (docs/server-backups.md,
// _Retention is a public promise_).
export const BACKUP_RETENTION_DAYS = 30;

// `/about` earns a slot despite the header being the scarcest space on the site:
// it was footer-only, and it is where the writing that actually moves a sceptic
// ended up — the stakes paragraph, the reproducible-builds caveat, the Brace.to
// lineage. Readers who found it named a sentence from it as the best thing on
// the property; the ones who didn't were the ones still asking who we are.
// The landing page has since pulled three of those lines forward, which lowers
// the cost of NOT finding this page but doesn't remove it: /about is still the
// only surface that answers "who is this and what do they concede".
//
// Placed first because it is the least transactional of the four, and last-place
// "Support" stays adjacent to the "Sign in" button, where a returning visitor
// looks. Four items plus a button is the ceiling for the narrow layout — the nav
// does not collapse to a menu, so a fifth would have to earn its way in by
// replacing one of these.
export const HEADER_LINKS = [
  { href: '/about', label: 'About' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'FAQ' },
  { href: '/support', label: 'Support' },
] as const;

// `external` marks a link that leaves this origin, which the footer renders as a
// plain <a> rather than a next/link — the same split the header's app links
// already make. Typed explicitly instead of `as const` for it: under `as const`
// the entries become a union, and only some members carry the flag, so reading it
// in the map is a type error.
export type FooterLink = { href: string; label: string; external?: boolean };

export const FOOTER_LINKS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: 'Product',
    links: [
      { href: '/pricing', label: 'Pricing' },
      { href: '/faq', label: 'FAQ' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/support', label: 'Support' },
      // Under Company rather than Product: it is a fact about who builds this and
      // how, not a thing you can buy. Developers look in the footer for it, which
      // is the whole reason it is here as well as on /about.
      { href: SOURCE.url, label: 'Source code', external: true },
      // Labelled with the handle rather than "X": the letter alone names nothing,
      // and the handle is not the product name — `@bracemark` was taken — so a
      // visitor who is going to search for us needs to read the string we actually
      // hold. The only link on this site to a property we do not control.
      { href: SOCIAL.url, label: SOCIAL.handle, external: true },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/terms', label: 'Terms' },
      { href: '/privacy', label: 'Privacy' },
      // Paddle's, not a page of ours — see PADDLE_REFUND_POLICY_URL. It has to be
      // in the navigation, not only inside /terms: Paddle's domain review wants
      // terms, refund policy and privacy policy "clearly accessible via
      // navigation", and a reviewer scanning this column for all three should
      // find all three.
      { href: PADDLE_REFUND_POLICY_URL, label: 'Refund policy', external: true },
      // Under Legal rather than Company, and it is the weaker fit of the two on
      // the merits: /security is a mechanism page, not a document anyone signed.
      // It sits here because of who goes looking for it. The reader who wants the
      // key hierarchy and the breach surface is the same reader who opens Terms
      // and Privacy to see what is promised in writing, and they scan this column
      // for exactly that; under Company it would sit beside About and the X
      // handle, which is not a neighbourhood anyone searches for a threat model
      // in. /extractor is deliberately NOT here for the mirror-image reason — its
      // readers arrive from a User-Agent string in an access log, never from our
      // footer.
      { href: '/security', label: 'Security' },
      // The page Play's Data safety form links as the "Delete account URL", and
      // listed for the same reason the refund policy is: a reviewer opening the
      // site looks for it in this column, beside the privacy policy whose
      // retention list it restates. Last, because it is the one a visitor looks
      // for rather than browses to.
      { href: '/delete-account', label: 'Delete account' },
    ],
  },
];
