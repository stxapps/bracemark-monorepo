import { chromium } from '@playwright/test';

import { STAGING_ORIGINS } from '../runner/environment';
import { CHROME_PATH } from '../web/fixtures/env';
import { probeCsp } from './csp';
import { type PolicyKind, securityHeaderMismatches } from './policy';

// The deployed security headers of one tier, read from outside it:
//
//   npx nx check:headers @stxapps/e2e                  # staging
//   npx nx check:headers @stxapps/e2e -- production
//
// WHY THIS IS NOT A CASE. Production is not an E2E target — a journey creates
// accounts and data, and the runner refuses to point one there
// (runner/environment.ts). But production has its own two CloudFront policies,
// and nothing else in the repo can say what they send. This creates nothing: it
// reads response headers, then asks a real browser to make one connection and
// load one script that the policy must refuse, and neither leaves the browser.
// It is the same comparison (./policy.ts) and the same probe (./csp.ts) that
// STAGING-HOSTING-001 and STAGING-CSP-001..003 run.
//
// It needs no build behind the CDN. CloudFront attaches the policy to its own
// 403 as well, so a tier whose buckets are still empty is checked on that.
// What it cannot say is that a real build WORKS under the policy — only the
// staging journeys and their violation guard say that.
const TIERS = {
  staging: STAGING_ORIGINS,
  production: {
    web: 'https://app.bracemark.com',
    api: 'https://api.bracemark.com',
    extractor: 'https://extractor.bracemark.com',
    site: 'https://bracemark.com',
  },
} as const;

async function main(): Promise<void> {
  const tier = process.argv[2] ?? 'staging';
  if (tier !== 'staging' && tier !== 'production') {
    throw new Error('usage: check:headers [staging|production]');
  }
  const origins = TIERS[tier];
  const hosts: Array<[PolicyKind, string]> = [
    ['web', origins.web],
    ['site', origins.site],
  ];
  const failures: string[] = [];

  for (const [kind, origin] of hosts) {
    // A page, and a path nothing serves: the error response is a document too.
    for (const url of [`${origin}/`, `${origin}/e2e-no-such-page`]) {
      const response = await fetch(url, { redirect: 'manual' });
      const headers = Object.fromEntries(response.headers);
      const mismatches = securityHeaderMismatches(headers, kind, origins);
      // Not a failure: a trial policy may sit beside the enforcing one.
      const trial = headers['content-security-policy-report-only'] ? ', plus a report-only' : '';
      console.log(`${mismatches.length ? 'FAIL' : 'ok  '} ${response.status} ${url}${trial}`);
      for (const mismatch of mismatches) failures.push(`${url}: ${mismatch}`);
    }
  }

  const browser = await chromium.launch({ executablePath: CHROME_PATH });
  try {
    for (const [, origin] of hosts) {
      for (const kind of ['script', 'connect'] as const) {
        const context = await browser.newContext({ bypassCSP: false });
        try {
          await probeCsp(await context.newPage(), kind, `${origin}/`);
          console.log(`ok   ${origin} refuses an unapproved ${kind}`);
        } catch (error) {
          console.log(`FAIL ${origin} refuses an unapproved ${kind}`);
          failures.push(`${origin}: ${kind} probe: ${(error as Error).message.split('\n')[0]}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${tier}: ${failures.length} problem(s)\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log(`\n${tier}: security headers are as designed, and enforced`);
}

await main();
