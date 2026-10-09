import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expectedPolicy, policyMismatches, securityHeaderMismatches } from './policy';

const origins = {
  api: 'https://api.fixture.invalid',
  extractor: 'https://extractor.fixture.invalid',
};
const r2 = `https://${'0123456789abcdef'.repeat(2)}.r2.cloudflarestorage.com`;
const paddle = 'https://*.paddle.com';
const web = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${paddle}`,
  `style-src 'self' 'unsafe-inline' ${paddle}`,
  `img-src 'self' blob: data: ${paddle}`,
  "font-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  `frame-src ${paddle}`,
  `connect-src 'self' ${origins.api} ${origins.extractor} ${r2} ${paddle}`,
].join('; ');
const site = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  'worker-src blob:',
  `connect-src 'self' ${origins.api}`,
].join('; ');

test('the designed policies match, in any source order and with a trailing semicolon', () => {
  assert.deepEqual(policyMismatches(web, expectedPolicy('web', origins)), []);
  assert.deepEqual(policyMismatches(site, expectedPolicy('site', origins)), []);
  const reordered = web.replace("worker-src 'self' blob:", "worker-src blob: 'self'");
  assert.deepEqual(policyMismatches(`${reordered};`, expectedPolicy('web', origins)), []);
});

// Each of these leaves every journey green, which is why the header is pinned.
test('a policy that allows more, or less, than the design is named', () => {
  const widened: Array<[string, string, RegExp]> = [
    [
      "'wasm-unsafe-eval'",
      "'wasm-unsafe-eval' 'unsafe-eval'",
      /script-src: unexpected source 'unsafe-eval'/,
    ],
    [r2, 'https://*.r2.cloudflarestorage.com', /connect-src: unexpected source https:\/\/\*\.r2/],
    [
      origins.api,
      'https://api.other-tier.invalid',
      /connect-src: unexpected source https:\/\/api\.other-tier/,
    ],
    [`${origins.extractor} `, '', /connect-src: missing source https:\/\/extractor\.fixture/],
    ["worker-src 'self' blob:", "worker-src 'self'", /worker-src: missing source blob:/],
    ["frame-ancestors 'none'; ", '', /frame-ancestors: missing/],
    ["font-src 'self'", "font-src 'self'; media-src https:", /media-src: unexpected directive/],
    ["font-src 'self'", "font-src 'self'; font-src https:", /font-src: declared twice/],
  ];
  for (const [from, to, expected] of widened) {
    const changed = web.replace(from, to);
    assert.notEqual(changed, web, from);
    assert.match(policyMismatches(changed, expectedPolicy('web', origins)).join('\n'), expected);
  }
  // The two apps' policies are not interchangeable in either direction.
  assert.notDeepEqual(policyMismatches(web, expectedPolicy('site', origins)), []);
  assert.notDeepEqual(policyMismatches(site, expectedPolicy('web', origins)), []);
  assert.deepEqual(policyMismatches(undefined, expectedPolicy('web', origins)), [
    'no Content-Security-Policy header',
  ]);
  assert.deepEqual(policyMismatches(`${web}, ${site}`, expectedPolicy('web', origins)), [
    'more than one policy in the header',
  ]);
});

test('the header set is held whole, and a report-only CSP does not count', () => {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'permissions-policy': 'camera=(), microphone=()',
    'content-security-policy': web,
  };
  assert.deepEqual(securityHeaderMismatches(headers, 'web', origins), []);
  const { 'content-security-policy': policy, ...rest } = headers;
  assert.deepEqual(
    securityHeaderMismatches(
      { ...rest, 'content-security-policy-report-only': policy },
      'web',
      origins,
    ),
    ['content-security-policy: no Content-Security-Policy header'],
  );
  const changed: Array<[Record<string, string>, RegExp]> = [
    [{ 'x-frame-options': 'SAMEORIGIN' }, /x-frame-options: SAMEORIGIN/],
    [{ 'x-xss-protection': '1; mode=block' }, /x-xss-protection: present/],
    [{ 'permissions-policy': 'camera=(), payment=()' }, /permissions-policy: names payment/],
    [{ 'strict-transport-security': 'max-age=0' }, /strict-transport-security: max-age=0/],
    [{ 'content-security-policy': site }, /content-security-policy: manifest-src: missing/],
  ];
  for (const [override, expected] of changed) {
    assert.match(
      securityHeaderMismatches({ ...headers, ...override }, 'web', origins).join('\n'),
      expected,
    );
  }
});
