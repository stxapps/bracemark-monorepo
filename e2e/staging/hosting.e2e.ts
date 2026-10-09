import { expect, test } from '@playwright/test';

import { API_URL, EXTRACTOR_URL, SITE_URL, WEB_URL } from '../web/fixtures/env';
import { probeCsp } from './csp';

test(
  'deployed documents carry security headers and the app build identity',
  {
    tag: ['@STAGING-HOSTING-001', '@smoke', '@online', '@security'],
  },
  async ({ page, request }, testInfo) => {
    const observed = [];
    for (const url of [SITE_URL, `${WEB_URL}/create-account`, `${WEB_URL}/sign-in`]) {
      const response = await page.goto(url);
      if (!response) throw new Error(`${url} returned no document response`);
      expect(response?.ok(), url).toBe(true);
      expect(new URL(page.url()).origin).toBe(new URL(url).origin);
      const headers = await response.allHeaders();
      observed.push({ url, status: response.status(), headers });
      expect(headers['content-type']).toContain('text/html');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['strict-transport-security']).toMatch(/max-age=[1-9]\d*/);
      expect(
        headers['content-security-policy'] || headers['content-security-policy-report-only'],
      ).toBeTruthy();
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
