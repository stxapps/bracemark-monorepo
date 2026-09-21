/**
 * The rule table in `rewrite-url.js`, pinned.
 *
 *   npm run test:cloudfront
 *
 * NOT part of `npm run test` — that is `nx run-many -t test` over the projects in
 * the graph, and `tools/` is not one (docs/testing.md). Node's own runner is enough
 * here: the function under test is pure string logic with no dependencies.
 *
 * WHAT THIS CANNOT CATCH, so it is never the last word before a publish:
 *   - runtime compatibility. Node is not cloudfront-js-2.0, which is ES 5.1 plus a
 *     documented subset of ES 6-12 — `for...of`, destructuring and spread all run
 *     fine here and are absent there.
 *   - compute utilization, the edge's real budget.
 *   - whether the rewritten key actually exists in the bucket.
 *   - whether CloudFront resolves the default root object before or after the
 *     function, which is the whole reason `/index.html` is exempt below.
 * `aws cloudfront test-function` runs the real runtime and reports the real
 * utilization; this file just means a rule change fails in 200ms rather than in a
 * browser (docs/hosting.md, _clean URLs — the CloudFront function_).
 *
 * It EVALUATES the source rather than importing it, on purpose. CloudFront wants a
 * bare global `function handler(event)` and gives the file no module system, so
 * adding an `export` to make this tidier would break the deploy. The eval is in
 * strict mode because the edge runtime is, unconditionally.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'rewrite-url.js');
const source = readFileSync(SOURCE_PATH, 'utf8');
const handler = new Function(`'use strict';\n${source}\nreturn handler;`)();

/** Parse 'a=1&b=2' into the shape CloudFront hands the function, multiValue included. */
function querystring(raw) {
  const parsed = {};
  if (!raw) return parsed;
  for (const pair of raw.split('&')) {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    const value = at < 0 ? '' : pair.slice(at + 1);
    if (parsed[name]) {
      parsed[name].multiValue = parsed[name].multiValue ?? [{ value: parsed[name].value }];
      parsed[name].multiValue.push({ value });
    } else {
      parsed[name] = { value };
    }
  }
  return parsed;
}

/** `pass:<rewritten uri>` or `<status>:<location>`, whichever the function returned. */
function run(host, uri, raw) {
  const event = {
    request: {
      method: 'GET',
      uri,
      querystring: querystring(raw),
      headers: host === null ? {} : { host: { value: host } },
    },
  };
  const result = handler(event);
  return result.statusCode
    ? `${result.statusCode}:${result.headers.location.value}`
    : `pass:${result.uri}`;
}

const SITE = 'bracemark.com';
const APP = 'app.bracemark.com';

// [host, uri, query, expected]
const CASES = [
  // 1. www folds onto the apex, carrying path and query with it.
  ['www.bracemark.com', '/', '', `301:https://${SITE}/`],
  ['www.bracemark.com', '/faq', 'utm_source=x', `301:https://${SITE}/faq?utm_source=x`],
  // Hosts are case-insensitive, so a shouted one matches rather than 404ing...
  ['WWW.Bracemark.com', '/faq', '', `301:https://${SITE}/faq`],
  // ...and `app.` has no www alias, so nothing fires there.
  [APP, '/links', '', 'pass:/links.html'],
  // A bare `www.` Host header must not produce `https:///faq`.
  ['www.', '/faq', '', 'pass:/faq.html'],

  // 2. Trailing slashes, however many, in one hop.
  [SITE, '/support/', '', `301:https://${SITE}/support`],
  [SITE, '/support///', '', `301:https://${SITE}/support`],
  [SITE, '/favicon.ico/', '', `301:https://${SITE}/favicon.ico`],

  // 3. The `.html` the S3 keys carry is not the canonical URL for the page...
  [SITE, '/support.html', '', `301:https://${SITE}/support`],
  [SITE, '/.html', '', `301:https://${SITE}/`],
  // ...except at the root. If a default root object is ever configured, CloudFront
  // may hand this function `/index.html` for a request to `/`; redirecting it back
  // to `/` would be an infinite loop. Deleting this exemption is silent until then.
  [SITE, '/index.html', '', 'pass:/index.html'],

  // 1-3 are one redirect, not three.
  ['www.bracemark.com', '/support/', 'a=1', `301:https://${SITE}/support?a=1`],

  // 4. The root, without depending on a default root object.
  [SITE, '/', '', 'pass:/index.html'],
  [APP, '/', 'compact', 'pass:/index.html'],

  // 5. A dot in the last segment is a real file. The `.txt` payloads are Next 16's
  // RSC prefetches — the client router fetches them on every in-app navigation, so
  // appending `.html` here would break navigation, not one asset.
  [APP, '/favicon.ico', '', 'pass:/favicon.ico'],
  [APP, '/sw.js', '', 'pass:/sw.js'],
  [APP, '/manifest.json', '', 'pass:/manifest.json'],
  [APP, '/_next/static/chunks/4bd1b696.js', '', 'pass:/_next/static/chunks/4bd1b696.js'],
  [APP, '/links.txt', '', 'pass:/links.txt'],
  [
    APP,
    '/settings/__next.!KGFwcCk.settings.txt',
    '',
    'pass:/settings/__next.!KGFwcCk.settings.txt',
  ],
  [SITE, '/robots.txt', '', 'pass:/robots.txt'],
  // The dot that matters here is the one in the LAST segment; the leading dot on
  // `.well-known` is incidental and must stay that way. RFC 9116 fixes this path
  // exactly, so a rule that grew a dotfolder case would take security.txt off the
  // air with a 404 that nobody on our side ever requests.
  [SITE, '/.well-known/security.txt', '', 'pass:/.well-known/security.txt'],
  // The one real file with no dot, matched by exact path. Apple's servers fetch it
  // to verify the domain for Apple Pay (Paddle checkout); rewritten to `.html` it
  // 404s, and the only symptom is a failed Verify in Paddle's dashboard.
  [
    APP,
    '/.well-known/apple-developer-merchantid-domain-association',
    '',
    'pass:/.well-known/apple-developer-merchantid-domain-association',
  ],
  // Exact, not a prefix: any other extensionless path there is still a page.
  [APP, '/.well-known/nope', '', 'pass:/.well-known/nope.html'],

  // 6. A page, nested or not. A path matching no key 404s at S3 and the
  // distribution's custom error response takes it from there.
  [SITE, '/support', '', 'pass:/support.html'],
  [APP, '/settings/misc', '', 'pass:/settings/misc.html'],
  [APP, '/sign-in', 'next=%2Flinks%3Flist%3Dinbox', 'pass:/sign-in.html'],
  [SITE, '/nope', '', 'pass:/nope.html'],

  // A missing Host header falls through to a 404 instead of throwing — a function
  // error would be a 500 on a request that is merely malformed.
  [null, '/faq', '', 'pass:/faq.html'],
];

for (const [host, uri, raw, expected] of CASES) {
  const label = `${host ?? '(no host)'}${uri}${raw ? `?${raw}` : ''}`;
  test(label, () => assert.equal(run(host, uri, raw), expected));
}

test('a redirect location is absolute, so it can never leave the distribution', () => {
  // `Location: //evil.com` — what a location built from the request path alone
  // would emit here — is scheme-relative, and browsers follow it off-site.
  assert.equal(run(SITE, '//evil.com/', ''), `301:https://${SITE}//evil.com`);
});

test('a redirect preserves the query string verbatim, repeats included', () => {
  // Re-encoding these would turn a legitimate %20 into %2520; dropping the repeat
  // would lose a tag. Both are how a redirect quietly loses the user's place.
  assert.equal(
    run(APP, '/links/', 'q=hello%20world&tag=a&tag=b'),
    `301:https://${APP}/links?q=hello%20world&tag=a&tag=b`,
  );
});

test('a 301 is not cached forever, so a wrong rule stays recoverable', () => {
  const response = handler({
    request: { method: 'GET', uri: '/faq/', querystring: {}, headers: { host: { value: SITE } } },
  });
  assert.equal(response.headers['cache-control'].value, 'max-age=3600');
});

test('the source fits CloudFront’s 10 KB function-size quota', () => {
  // Not adjustable, and comments count. This file exists partly so that a long new
  // comment fails here rather than at `aws cloudfront create-function`.
  const bytes = Buffer.byteLength(source);
  assert.ok(bytes < 10 * 1024, `rewrite-url.js is ${bytes} bytes, over the 10 KB limit`);
});
