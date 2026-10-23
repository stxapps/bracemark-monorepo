// The marketing site's origin, for the pages that live there rather than here:
// support, terms, privacy, about, contact (bracemark-site — docs/hosting.md).
//
// Env-configured rather than a relative path, because those pages are on a
// DIFFERENT ORIGIN — the apex, while this app serves `app.*`. A bare `/support`
// resolves against this app and 404s; it never worked, it just used to point at a
// route that was planned and never built.
//
// Per-tier like every other origin here (`bracemark.com`, `dryrunbase.com` — staging
// is its own registrable domain, docs/hosting.md — or the local site dev server on
// :3001), so a staging build can't link into production's site.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
if (!siteUrl) throw new Error('NEXT_PUBLIC_SITE_URL is not set');

// SITE_URL is the landing page itself, which two surfaces navigate TO: Settings →
// About links to it, and AuthGuard sends a deliberate sign-out there (there is no
// signed-out page on this origin worth landing on). The rest are the site's pages
// that this app points at; Settings → About is the index of all of them.
export const SITE_URL = siteUrl;
export const ABOUT_URL = `${siteUrl}/about`;
export const FAQ_URL = `${siteUrl}/faq`;
export const PRICING_URL = `${siteUrl}/pricing`;
export const SUPPORT_URL = `${siteUrl}/support`;
export const TERMS_URL = `${siteUrl}/terms`;
export const PRIVACY_URL = `${siteUrl}/privacy`;
