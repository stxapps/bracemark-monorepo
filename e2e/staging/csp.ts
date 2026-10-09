import { expect, type Page } from '@playwright/test';

import { WEB_URL } from '../web/fixtures/env';

// A DNS/network failure cannot satisfy these checks: the browser must report an
// ENFORCING CSP violation for the deliberately refused URL. Routing the sentinel
// supplies a successful response if a policy accidentally allows it, making that
// regression observable without sending anything to a third party.
export async function probeCsp(
  page: Page,
  kind: 'script' | 'connect',
  documentUrl = `${WEB_URL}/sign-in`,
): Promise<void> {
  const url = `https://csp-probe.invalid/${kind}`;
  let escaped = 0;
  await page.route(url, async (route) => {
    escaped++;
    await route.fulfill({
      contentType: kind === 'script' ? 'application/javascript' : 'text/plain',
      body: '',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  const response = await page.goto(documentUrl);
  if (!response) throw new Error(`${documentUrl} returned no document response`);
  const headers = await response.allHeaders();
  expect(
    headers['content-security-policy'],
    'CloudFront must enforce CSP; report-only does not block',
  ).toBeTruthy();
  const violation = await page.evaluate(
    async ({ url, kind }) => {
      return await new Promise<{ directive: string; disposition: string } | null>((resolve) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 5000);
        // Inline callback: tsx's keepNames helper cannot be serialized into a
        // page.evaluate closure when this runs from the native/Node harness.
        document.addEventListener(
          'securitypolicyviolation',
          (event) => {
            if (
              ![url, new URL(url).origin].includes(event.blockedURI) ||
              event.disposition !== 'enforce'
            )
              return;
            clearTimeout(timeout);
            controller.abort();
            resolve({ directive: event.effectiveDirective, disposition: event.disposition });
          },
          { signal: controller.signal },
        );
        if (kind === 'script') {
          // Namespaced, and appended to whatever root there is: an origin with
          // no build answers CloudFront's XML error, which has no <head> and
          // would make a plain `createElement` an inert XML element.
          const script = document.createElementNS('http://www.w3.org/1999/xhtml', 'script');
          script.setAttribute('src', url);
          (document.head ?? document.documentElement).append(script);
        } else void fetch(url).catch(() => undefined);
      });
    },
    { url, kind },
  );
  expect(violation).not.toBeNull();
  if (!violation) throw new Error('browser emitted no enforcing CSP violation');
  expect(violation.disposition).toBe('enforce');
  expect(violation.directive).toMatch(
    kind === 'script' ? /^script-src(?:-elem)?$/ : /^connect-src$/,
  );
  expect(escaped, 'the disallowed request must never reach the network').toBe(0);
}
