/**
 * @jest-environment node
 *
 * A route handler returns a `Response`, which jsdom does not define — hence the
 * environment override rather than folding these into
 * app/security/reporting-terms.spec.tsx, which renders React and needs jsdom.
 */
import { SECURITY_EMAIL, SITE_URL } from '../../../lib/site';
import { GET } from './route';

// Nobody proofreads this file. That is the point of it — a scanner fetches it before
// a human is involved — and it is also why nothing here is caught by looking: every
// field is a plausible string, so a wrong one serves a 200 and routes reports into a
// mailbox nobody reads, or to a policy page that no longer exists.
describe('/.well-known/security.txt', () => {
  it('routes a researcher to the published address and to our own policy page', async () => {
    const body = await GET().text();

    expect(body).toContain(`Contact: mailto:${SECURITY_EMAIL}`);
    // On-origin on purpose: a researcher holding this file is holding a claim about
    // bracemark.com, and resolving it should not depend on a link to a third-party
    // host still pointing where it did (route.ts, _POLICY POINTS AT OUR OWN ORIGIN_).
    // The windows themselves live on the page this points at, pinned there.
    expect(body).toContain(`Policy: ${SITE_URL}/security`);
  });

  // RFC 9116 makes `Expires` mandatory and recommends under a year, and an EXPIRED
  // security.txt reads as an abandoned one — worse than none at all. Deriving it from
  // the build date renews it on every deploy, which is what makes the field safe; what
  // that leaves unheld is the recommendation itself, one edit to EXPIRY_DAYS away.
  it('expires ahead of now and inside the year RFC 9116 recommends', async () => {
    const expires = (await GET().text()).match(/^Expires: (.+)$/m)?.[1];
    expect(expires).toBeDefined();

    const ahead = new Date(expires as string).getTime() - Date.now();
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThan(365 * 24 * 60 * 60 * 1000);
  });
});
