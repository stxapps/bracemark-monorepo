import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { type Browser, chromium } from '@playwright/test';

import { takeCspViolations, watchCspViolations } from '../web/fixtures/csp';
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

// The journeys' own guard (web/fixtures/csp.ts): a document that violates its
// policy is recorded whichever header carried it, an allowed request is not, and
// a third party's document reporting against its own policy is not ours.
test('the violation watcher records our documents under either header and nothing else', async () => {
  const ours = 'https://csp-fixture.invalid/';
  const theirs = 'https://third-party.invalid/';
  const run = async (url: string, header: string, allow = '') => {
    const context = await browser.newContext({ bypassCSP: false });
    try {
      await watchCspViolations(context, ours);
      const page = await context.newPage();
      await page.route(url, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>CSP fixture</title>',
          headers: { [header]: `default-src 'self'; connect-src 'self'${allow}` },
        }),
      );
      await page.route('https://csp-probe.invalid/**', (route) =>
        route.fulfill({ body: '', headers: { 'access-control-allow-origin': '*' } }),
      );
      await page.goto(url);
      await page.evaluate(() => fetch('https://csp-probe.invalid/connect').catch(() => undefined));
      // The event is queued behind the refused fetch; one more round trip
      // through the page lets the binding deliver it.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      return takeCspViolations();
    } finally {
      await context.close();
    }
  };
  for (const [header, disposition] of [
    ['content-security-policy', 'enforce'],
    ['content-security-policy-report-only', 'report'],
  ]) {
    const violations = await run(ours, header);
    // At least one: a report-only fetch goes on to the network, and Chrome
    // reports it again there.
    assert.ok(violations.length > 0, header);
    for (const violation of violations) {
      assert.deepEqual(
        { ...violation, sourceFile: '' },
        {
          documentURL: ours,
          blockedURI: 'https://csp-probe.invalid/connect',
          directive: 'connect-src',
          disposition,
          sourceFile: '',
        },
      );
    }
  }
  assert.deepEqual(await run(ours, 'content-security-policy', ' https://csp-probe.invalid'), []);
  assert.deepEqual(await run(theirs, 'content-security-policy'), []);
  assert.deepEqual(takeCspViolations(), []);
});
