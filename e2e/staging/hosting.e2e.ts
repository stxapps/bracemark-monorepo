import { expect, test } from '@playwright/test';

import { takeCspViolations, watchCspViolations } from '../web/fixtures/csp';
import { API_URL, EXTRACTOR_URL, SITE_URL, WEB_URL } from '../web/fixtures/env';
import { probeCsp } from './csp';
import { type PolicyKind, securityHeaderMismatches } from './policy';

// What every response from either CloudFront origin must carry. The CSP has to
// be the ENFORCING header, and the whole policy the code is designed around
// (./policy.ts): report-only blocks nothing, and a widened policy blocks less
// than it appears to.
function expectSecurityHeaders(
  headers: Record<string, string>,
  kind: PolicyKind,
  url: string,
): void {
  expect(
    securityHeaderMismatches(headers, kind, { api: API_URL, extractor: EXTRACTOR_URL }),
    `${url} must send the designed security headers`,
  ).toEqual([]);
}

test(
  'deployed documents carry security headers and the app build identity',
  {
    tag: ['@STAGING-HOSTING-001', '@smoke', '@online', '@security'],
  },
  async ({ page, request }, testInfo) => {
    const observed = [];
    const documents: Array<[string, PolicyKind]> = [
      [SITE_URL, 'site'],
      [`${WEB_URL}/create-account`, 'web'],
      [`${WEB_URL}/sign-in`, 'web'],
    ];
    for (const [url, kind] of documents) {
      const response = await page.goto(url);
      if (!response) throw new Error(`${url} returned no document response`);
      expect(response?.ok(), url).toBe(true);
      expect(new URL(page.url()).origin).toBe(new URL(url).origin);
      const headers = await response.allHeaders();
      observed.push({ url, status: response.status(), headers });
      expect(headers['content-type']).toContain('text/html');
      expectSecurityHeaders(headers, kind, url);
    }
    // The 404 page is a document that runs the same scripts, served through
    // CloudFront's custom error response. A headers policy that reached only the
    // 200s would leave it bare.
    const missing: Array<[string, PolicyKind]> = [
      [`${SITE_URL}/e2e-no-such-page`, 'site'],
      [`${WEB_URL}/e2e-no-such-page`, 'web'],
    ];
    for (const [url, kind] of missing) {
      const response = await request.get(url);
      observed.push({ url, status: response.status(), headers: response.headers() });
      expect(response.status(), url).toBe(404);
      expect(response.headers()['content-type'], url).toContain('text/html');
      expectSecurityHeaders(response.headers(), kind, url);
    }
    const buildResponse = await request.get(`${WEB_URL}/build.json`);
    expect(buildResponse.ok()).toBe(true);
    expect(buildResponse.headers()['content-type']).toContain('application/json');
    const build = (await buildResponse.json()) as { id: string };
    expect(build.id).toBeTruthy();
    await expect(page.locator('html')).toHaveAttribute('data-build', build.id);
    await testInfo.attach('deployment', {
      body: JSON.stringify({ build, observed }, null, 2),
      contentType: 'application/json',
    });
  },
);

test(
  'CSP blocks an unapproved external script',
  {
    tag: ['@STAGING-CSP-001', '@smoke', '@online', '@security'],
  },
  async ({ page }) => {
    await probeCsp(page, 'script');
  },
);

test(
  'CSP blocks an unapproved connection',
  {
    tag: ['@STAGING-CSP-002', '@smoke', '@online', '@security'],
  },
  async ({ page }) => {
    await probeCsp(page, 'connect');
  },
);

// The marketing site has its own, smaller policy on its own distribution, so the
// app's two refusals above say nothing about it.
test(
  'marketing site CSP blocks an unapproved script and connection',
  {
    tag: ['@STAGING-CSP-003', '@smoke', '@online', '@security'],
  },
  async ({ page }) => {
    await probeCsp(page, 'script', SITE_URL);
    await probeCsp(page, 'connect', SITE_URL);
  },
);

// The one allowance the site's policy makes beyond `'self'` is `worker-src
// blob:`, for the bookmark converter: Turbopack starts its worker from a blob
// bootstrap (docs/hosting.md, _security headers_). Without it the tool answers
// every file with "Could not check this file" and the rest of the site looks
// fine, so the conversion itself is the assertion. The pages around it are
// walked under the same watcher the app's journeys run under — an anonymous
// visitor has no fixture to do it for them.
test(
  'marketing site pages and the bookmark converter run with no CSP violation',
  {
    tag: ['@STAGING-CSP-005', '@smoke', '@online', '@security'],
  },
  async ({ page }) => {
    await watchCspViolations(page.context(), SITE_URL);
    for (const path of ['/', '/pricing', '/faq', '/docs', '/blog', '/tools/bookmark-converter']) {
      const response = await page.goto(`${SITE_URL}${path}`);
      expect(response?.ok(), path).toBe(true);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    await page.getByLabel('1. Open a bookmark export').setInputFiles({
      name: 'bookmarks.html',
      mimeType: 'text/html',
      buffer: Buffer.from(
        [
          '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
          '<TITLE>Bookmarks</TITLE>',
          '<H1>Bookmarks</H1>',
          '<DL><p>',
          '<DT><A HREF="https://one.example.invalid/" ADD_DATE="1700000000">One</A>',
          '<DT><A HREF="https://two.example.invalid/" ADD_DATE="1700000001">Two</A>',
          '</DL><p>',
        ].join('\n'),
      ),
    });
    // Screen-reader-only, so attached rather than visible.
    await expect(
      page.getByRole('status').filter({ hasText: /^Ready: 2 web links in / }),
    ).toBeAttached({ timeout: 30_000 });
    expect(takeCspViolations(), 'the marketing site violated its deployed CSP').toEqual([]);
  },
);

test(
  'Workers answer browser CORS requests only for the allowed staging origin',
  {
    tag: ['@STAGING-CORS-001', '@smoke', '@online', '@security'],
  },
  async ({ page, request }) => {
    await page.goto(`${WEB_URL}/sign-in`);
    for (const origin of [API_URL, EXTRACTOR_URL]) {
      const health = await page.evaluate(async (origin) => {
        const response = await fetch(`${origin}/health`);
        return { status: response.status, body: (await response.json()) as { status: string } };
      }, origin);
      expect(health).toEqual({ status: 200, body: { status: 'ok' } });
      const endpoint = origin === API_URL ? '/v1/auth/password-door' : '/v1/extract';
      const preflight = async (from: string) =>
        request.fetch(`${origin}${endpoint}`, {
          method: 'OPTIONS',
          headers: {
            origin: from,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,authorization',
          },
        });
      const allowed = await preflight(WEB_URL);
      expect(allowed.ok()).toBe(true);
      expect(allowed.headers()['access-control-allow-origin']).toBe(WEB_URL);
      expect(allowed.headers()['access-control-allow-methods']).toMatch(/\bPOST\b/);
      const denied = await preflight('https://unapproved.invalid');
      expect(denied.headers()['access-control-allow-origin']).toBeUndefined();
    }
  },
);
