// The marketing site's own configuration: where it lives, where the app lives, and
// the two nav structures the header and footer render from.
//
// The app URL is env-configured (`.env.*`), not hard-coded, for the same reason
// bracemark-web's API URL is: it differs per tier (`app.bracemark.com` vs
// `app.dryrunbase.com` vs `localhost:3000`) and is baked at build time.
// See docs/env-files.md — _bracemark-site_.

// Imported rather than re-exported blind (the way COMPANY is, below) because
// FOOTER_LINKS needs the repo URL in scope.
import { SOURCE } from '@stxapps/shared';

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.bracemark.com';

/** The apex this site is served from — used for canonical/OG absolute URLs. */
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

// The "last updated" line each policy carries. Dates live here rather than inline
// so the two documents can never claim different vintages of the same rewrite —
// and so bumping one after an edit is a deliberate act, not a forgotten one.
export const TERMS_UPDATED = '21 August 2026';
export const PRIVACY_UPDATED = '21 August 2026';

export const HEADER_LINKS = [
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
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/terms', label: 'Terms' },
      { href: '/privacy', label: 'Privacy' },
    ],
  },
];
