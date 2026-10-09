import { type BrowserContext } from '@playwright/test';

import { SITE_URL, WEB_URL } from './env';

// Every journey doubles as a CSP check. The deployed policy has no `report-uri`,
// so a violation is written to the console of whichever browser hit it and
// nowhere else, and the paths most likely to be left out of a policy are the
// ones a journey passes through without asserting on: omit the R2 host from
// `connect-src` and the app still signs in and still lists links, with every
// image silently missing (docs/hosting.md, _security headers_). Recording the
// browser's own `securitypolicyviolation` events turns each of those into a
// failure of the journey that walked into it.
//
// Local runs never fire: `next dev` and `nx start` send no CSP. The record only
// fills against a deployed origin, which is where the app fixture asserts it is
// empty after each test (./app.ts).
//
// Two limits. A violation raised inside a worker's own global scope fires
// there, not on a document, so it is not seen — the refusal to START a worker
// is. And a report-only policy's violations count too: a trial policy that
// reports during a journey is one that would break it once enforced, which is
// the thing the trial exists to find out.
export interface CspViolation {
  documentURL: string;
  blockedURI: string;
  directive: string;
  disposition: string;
  sourceFile: string;
}

const BINDING = '__e2eCspViolation';

// One record per process: a Playwright worker runs its tests serially, and the
// contexts a test opens beyond the fixture's (a second profile, a second device)
// have to land in the same place without each spec threading a handle through.
const recorded: CspViolation[] = [];

export async function watchCspViolations(
  context: BrowserContext,
  baseURL: string = WEB_URL,
): Promise<void> {
  // Ours only. Paddle's checkout is a document on *.paddle.com under Paddle's
  // own policy, and what that policy reports is not this repo's finding.
  const origins = new Set([WEB_URL, SITE_URL, baseURL].map((url) => new URL(url).origin));
  await context.exposeBinding(BINDING, ({ frame }, violation: CspViolation) => {
    if (origins.has(new URL(frame.url()).origin)) recorded.push(violation);
  });
  // Injected by the driver, so the page's own `script-src` does not apply to it.
  // Inline callback only: tsx's keepNames helper cannot be serialized into a
  // browser closure (see staging/csp.ts).
  await context.addInitScript((binding) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as Record<string, (violation: unknown) => void>)[binding];
      report?.({
        documentURL: event.documentURI,
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective,
        disposition: event.disposition,
        sourceFile: event.sourceFile,
      });
    });
  }, BINDING);
}

// Empties the record, so one test's violations are not charged to the next.
export function takeCspViolations(): CspViolation[] {
  return recorded.splice(0);
}
