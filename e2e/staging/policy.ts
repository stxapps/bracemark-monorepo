// The policy each deployed document must send, as the code needs it
// (docs/hosting.md, _security headers_), compared source by source.
//
// A probe proves one refusal. It cannot see what a policy ALLOWS, and that is
// where the header goes wrong without a symptom: `'unsafe-eval'` added to quiet
// a console message, a wildcard R2 host, the other tier's api in `connect-src`.
// Each of those leaves every journey green. So the whole header is pinned, and a
// deliberate change to the CDN's policy changes this table in the same pass.
export type PolicyKind = 'web' | 'site';

type Source = string | RegExp;
export type ExpectedPolicy = Record<string, Source[]>;

// R2 is addressed by Cloudflare account, and the id stays out of this repo. What
// is pinned is the shape: one exact account host, never the wildcard that would
// authorise every Cloudflare account's bucket as a destination.
const R2 = /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;
// One label under paddle.com covers sandbox and live alike, so the Paddle
// allowances are identical across tiers.
const PADDLE = 'https://*.paddle.com';

export function expectedPolicy(
  kind: PolicyKind,
  origins: { api: string; extractor: string },
): ExpectedPolicy {
  const shared = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'font-src': ["'self'"],
  };
  // The marketing site holds no credentials, runs no crypto and opens no
  // checkout: no wasm, no Paddle, no R2, no extractor.
  if (kind === 'site')
    return {
      ...shared,
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'worker-src': ['blob:'],
      'connect-src': ["'self'", origins.api],
    };
  return {
    ...shared,
    'script-src': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", PADDLE],
    'style-src': ["'self'", "'unsafe-inline'", PADDLE],
    'img-src': ["'self'", 'blob:', 'data:', PADDLE],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'frame-src': [PADDLE],
    'connect-src': ["'self'", origins.api, origins.extractor, R2, PADDLE],
  };
}

// Every way `header` differs from `expected`, in words. Empty means it matches.
export function policyMismatches(header: string | undefined, expected: ExpectedPolicy): string[] {
  if (!header) return ['no Content-Security-Policy header'];
  // Two policies in one response intersect, and the result is neither of them.
  if (header.includes(',')) return ['more than one policy in the header'];
  const mismatches: string[] = [];
  const actual = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    // The browser keeps the first and ignores the rest; a reader does not.
    if (actual.has(name)) mismatches.push(`${name}: declared twice`);
    else actual.set(name, sources);
  }
  for (const name of actual.keys()) {
    if (!(name in expected)) mismatches.push(`${name}: unexpected directive`);
  }
  for (const [name, wanted] of Object.entries(expected)) {
    const sources = actual.get(name);
    if (!sources) {
      mismatches.push(`${name}: missing`);
      continue;
    }
    const unmatched = [...wanted];
    for (const source of sources) {
      const index = unmatched.findIndex((entry) =>
        typeof entry === 'string' ? entry === source : entry.test(source),
      );
      if (index === -1) mismatches.push(`${name}: unexpected source ${source}`);
      else unmatched.splice(index, 1);
    }
    for (const entry of unmatched) mismatches.push(`${name}: missing source ${String(entry)}`);
  }
  return mismatches;
}

// The whole security header set of one response, the CSP included. The values
// and the two deliberate omissions are docs/hosting.md, _security headers_.
export function securityHeaderMismatches(
  headers: Record<string, string | undefined>,
  kind: PolicyKind,
  origins: { api: string; extractor: string },
): string[] {
  const mismatches: string[] = [];
  const fixed: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
  };
  for (const [name, value] of Object.entries(fixed)) {
    if (headers[name] !== value) mismatches.push(`${name}: ${headers[name] ?? 'missing'}`);
  }
  if (!/max-age=[1-9]\d*/.test(headers['strict-transport-security'] ?? ''))
    mismatches.push(
      `strict-transport-security: ${headers['strict-transport-security'] ?? 'missing'}`,
    );
  const permissions = headers['permissions-policy'] ?? '';
  if (!/camera=\(\)/.test(permissions))
    mismatches.push('permissions-policy: camera is not disabled');
  // Named in either direction, `payment` takes the wallets out of Paddle's checkout.
  if (/payment/.test(permissions)) mismatches.push('permissions-policy: names payment');
  // Omitted on purpose; it is in every preset, AWS's managed one included.
  if (headers['x-xss-protection'] !== undefined) mismatches.push('x-xss-protection: present');
  // The ENFORCING header: report-only blocks nothing.
  for (const mismatch of policyMismatches(
    headers['content-security-policy'],
    expectedPolicy(kind, origins),
  ))
    mismatches.push(`content-security-policy: ${mismatch}`);
  return mismatches;
}
