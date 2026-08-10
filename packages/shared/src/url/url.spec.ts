import { canonicalUrlKey, normalizeUrl } from './url';

describe('normalizeUrl', () => {
  it('prepends https:// to a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('keeps a path/query/fragment on a bare domain untouched but for the scheme', () => {
    expect(normalizeUrl('example.com/a/b?q=1&r=2#x')).toBe('https://example.com/a/b?q=1&r=2#x');
  });

  it('trusts an explicit http(s):// scheme as typed', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path/');
  });

  it('does NOT canonicalize beyond the scheme (no added trailing slash, no re-encoding)', () => {
    // new URL(...).href would have produced "https://example.com/" — we don't.
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/A B')).toBe('https://example.com/A B');
  });

  it('trims surrounding whitespace before coercing', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
  });

  it('returns null for empty/whitespace input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('returns null for schemeless prose with no dotted host', () => {
    expect(normalizeUrl('note to self')).toBeNull();
    expect(normalizeUrl('localhost')).toBeNull();
  });

  it('trusts an explicit http(s) scheme even when the host is dotless', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects explicit non-http(s) schemes (incl. javascript: bookmarklets)', () => {
    expect(normalizeUrl('ftp://example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('tel:+123')).toBeNull();
  });

  it('rejects a schemeless host:port (indistinguishable from a scheme)', () => {
    // The user can disambiguate by prefixing http(s):// or confirming raw.
    expect(normalizeUrl('example.com:8080')).toBeNull();
    expect(normalizeUrl('https://example.com:8080')).toBe('https://example.com:8080');
  });
});

describe('canonicalUrlKey', () => {
  it('folds the http/https scheme', () => {
    expect(canonicalUrlKey('http://example.com')).toBe(canonicalUrlKey('https://example.com'));
  });

  it('drops a leading www.', () => {
    expect(canonicalUrlKey('https://www.example.com')).toBe(canonicalUrlKey('https://example.com'));
  });

  it('drops a trailing slash', () => {
    expect(canonicalUrlKey('https://example.com/')).toBe(canonicalUrlKey('https://example.com'));
    expect(canonicalUrlKey('https://example.com/a/')).toBe(
      canonicalUrlKey('https://example.com/a'),
    );
  });

  it('drops the default port but keeps a non-default one', () => {
    expect(canonicalUrlKey('https://example.com:443')).toBe(canonicalUrlKey('https://example.com'));
    expect(canonicalUrlKey('https://example.com:8443')).not.toBe(
      canonicalUrlKey('https://example.com'),
    );
  });

  it('sorts the query string but keeps every param', () => {
    expect(canonicalUrlKey('https://example.com/?b=2&a=1')).toBe(
      canonicalUrlKey('https://example.com/?a=1&b=2'),
    );
  });

  it('drops the fragment', () => {
    expect(canonicalUrlKey('https://example.com/p#section')).toBe(
      canonicalUrlKey('https://example.com/p'),
    );
  });

  it('coerces a bare domain the same way normalizeUrl does', () => {
    expect(canonicalUrlKey('example.com')).toBe(canonicalUrlKey('https://example.com'));
  });

  it('preserves path case (paths can be case-sensitive)', () => {
    expect(canonicalUrlKey('https://example.com/A')).not.toBe(
      canonicalUrlKey('https://example.com/a'),
    );
  });

  it('distinguishes different hosts', () => {
    expect(canonicalUrlKey('https://a.com')).not.toBe(canonicalUrlKey('https://b.com'));
  });

  it('produces the expected concrete key', () => {
    expect(canonicalUrlKey('https://www.Example.com:443/Path/?b=2&a=1#frag')).toBe(
      'example.com/Path?a=1&b=2',
    );
  });

  it('returns null for input that cannot be coerced to a URL', () => {
    expect(canonicalUrlKey('note to self')).toBeNull();
    expect(canonicalUrlKey('')).toBeNull();
    expect(canonicalUrlKey('mailto:a@b.com')).toBeNull();
  });
});
