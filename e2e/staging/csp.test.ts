import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { type Browser, chromium } from '@playwright/test';

import { CHROME_PATH } from '../web/fixtures/env';
import { probeCsp } from './csp';

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ executablePath: CHROME_PATH });
});
after(async () => {
  await browser?.close();
});

// Synthetic documents test the detector's two halves without changing any CDN
// policy. These are harness checks, not evidence about deployed staging.
for (const kind of ['script', 'connect'] as const) {
  test(`${kind} probe distinguishes enforced refusal from report-only and an allowed destination`, async () => {
    for (const policy of ['enforce', 'report-only', 'allow'] as const) {
      const context = await browser.newContext({ bypassCSP: false });
      try {
        const page = await context.newPage();
        const url = 'https://csp-fixture.invalid/';
        const header =
          policy === 'report-only'
            ? 'content-security-policy-report-only'
            : 'content-security-policy';
        const allow = policy === 'allow' ? ' https://csp-probe.invalid' : '';
        await page.route(url, (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>CSP fixture</title>',
            headers: {
              [header]: `default-src 'none'; script-src 'self'${allow}; connect-src 'self'${allow}`,
            },
          }),
        );
        if (policy === 'enforce') await probeCsp(page, kind, url);
        else await assert.rejects(probeCsp(page, kind, url));
      } finally {
        await context.close();
      }
    }
  });
}
