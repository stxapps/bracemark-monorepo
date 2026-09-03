import { SECURITY_EMAIL, SITE_URL } from '../../../lib/site';

// /.well-known/security.txt — RFC 9116. The first URL a security researcher
// fetches, and it 404'd for the whole of this site's public life while
// SECURITY.md in the repository already carried every fact it needs.
//
// A ROUTE rather than a file in `public/`, for one field: `Expires`. RFC 9116
// makes it mandatory and recommends under a year, so a hand-written file dated
// today is a document that silently becomes invalid — an EXPIRED security.txt is
// read as an abandoned one, which is worse than none at all, and nothing in this
// repo would catch the day it turned. Deriving it from the build date means every
// deploy renews it and the failure mode is bounded by how long we go without
// shipping. This is the opposite call from TERMS_UPDATED/PRIVACY_UPDATED in
// lib/site.ts, which are typed by hand on purpose: those DATE A CLAIM and must
// only move when a human decides the document changed. This dates nothing — it is
// a freshness marker on a contact address — so automatic is right here and wrong
// there.
//
// Every value below is published somewhere already: the address is SECURITY_EMAIL
// (/support, /faq `security-report`), and Policy points at /security, whose
// reporting section prints the three-and-ten windows and the no-bounty statement
// and links on to SECURITY.md for the scope. Nothing here is a new commitment.
//
// POLICY POINTS AT OUR OWN ORIGIN, not straight at SECURITY.md on GitHub. It did
// point at the file, because for a while the file was the only policy document
// there was. An on-origin target is the better one for the same reason Canonical
// exists: a researcher who fetched this file is holding a claim about
// bracemark.com, and resolving it should not require trusting that a link off to
// a third-party host still points where it did. /security carries the windows
// itself and links the repository for the parts that belong there, so nothing is
// lost by the extra hop and the authority stays on the domain the report is
// about.
//
// `Canonical` takes SITE_URL, which is hard-coded to production for the reason
// lib/site.ts gives — so a staging build publishes production's canonical. That
// is the same cosmetic mismatch as og:url there, and it costs nothing: staging is
// `Disallow: /` (app/robots.ts) and nobody fetches this file from it.

// Required by `output: 'export'`, same as app/robots.ts — a route handler under a
// static export has to declare itself static or the build fails outright.
export const dynamic = 'force-static';

// RFC 9116 recommends "less than a year"; a year less a day keeps it inside that
// on the pedantic reading and still only asks for one deploy every twelve months.
const EXPIRY_DAYS = 364;

export function GET(): Response {
  const expires = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const body = [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expires}`,
    `Policy: ${SITE_URL}/security`,
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    'Preferred-Languages: en',
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
