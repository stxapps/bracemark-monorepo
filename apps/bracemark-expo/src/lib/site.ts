// The marketing site's origin, for the pages that live there rather than in this
// app: its landing page, About, FAQ, Support, Terms, Privacy (bracemark-site —
// docs/hosting.md). The RN peer of bracemark-web's `src/lib/site.ts`, same
// exports, same reasoning.
//
// Env-configured rather than hard-coded, because it differs per tier
// (`bracemark.com`, the staging apex, or the local site dev server on :3001) and
// a staging build must not link into production's site. EXPO_PUBLIC_ is what
// Metro inlines from `.env.<mode>` — the same convention as lib/api-client.ts.
//
// It exists as a file because Settings → About links to five of these at once.
// The one earlier caller (the links topbar's Support item) built its own
// `${siteUrl}/support` from an inlined copy of this check, which is one copy per
// caller of a string that has to agree with the site's routes.
const siteUrl = process.env.EXPO_PUBLIC_SITE_URL;
if (!siteUrl) throw new Error('EXPO_PUBLIC_SITE_URL is not set');

export const SITE_URL = siteUrl;
export const ABOUT_URL = `${siteUrl}/about`;
export const FAQ_URL = `${siteUrl}/faq`;
export const SUPPORT_URL = `${siteUrl}/support`;
export const TERMS_URL = `${siteUrl}/terms`;
export const PRIVACY_URL = `${siteUrl}/privacy`;
