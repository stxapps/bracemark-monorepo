import { canonicalUrlKey, displayUrl, hostFromText, hostFromUrl, normalizeUrl } from './url';

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

  it('sorts repeated keys by value, so param ORDER never splits an identity', () => {
    // A repeated key is ordinary (?tag=a&tag=b). Sorting on the key alone leaves
    // those two entries in input order — a stable sort keeps them where they were
    // — so the same page reached from two links would key differently and
    // dedup would miss it. The tie-break on the value is what closes that.
    expect(canonicalUrlKey('https://example.com/?tag=b&tag=a')).toBe(
      canonicalUrlKey('https://example.com/?tag=a&tag=b'),
    );
  });

  it('keeps a param whose value differs, and one that is empty', () => {
    // The sort must not become a dedup: ?a=1&a=2 is not ?a=1.
    expect(canonicalUrlKey('https://example.com/?a=1&a=2')).toBe('example.com?a=1&a=2');
    expect(canonicalUrlKey('https://example.com/?a=')).toBe('example.com?a=');
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

describe('hostFromUrl / hostFromText', () => {
  // The DISPLAY host — the provisional title, the secondary line, the favicon
  // domain. Every surface renders this string, and the extractor's server-side
  // title fallback has to produce the same one, so the www rule is asserted on
  // its own rather than only through canonicalUrlKey.
  it('strips a leading www. and nothing else', () => {
    expect(hostFromUrl(new URL('https://www.example.com/a?b=1#c'))).toBe('example.com');
    expect(hostFromUrl(new URL('https://news.ycombinator.com/item?id=1'))).toBe(
      'news.ycombinator.com',
    );
    // Only LEADING, and only as a label: "wwwx." and an inner "www." both stay.
    expect(hostFromUrl(new URL('https://wwwx.example.com'))).toBe('wwwx.example.com');
    expect(hostFromUrl(new URL('https://a.www.example.com'))).toBe('a.www.example.com');
  });

  it('reads the host out of raw text the same way', () => {
    expect(hostFromText('https://www.example.com/a/b')).toBe('example.com');
  });

  it('falls back to the raw string when the text will not parse', () => {
    // The stored url comes from user input and normalizeUrl's null is a SOFT
    // result — the user can confirm-and-save prose — so this receives text that
    // is not a URL by design. A slightly-off label beats a crashed list row.
    expect(hostFromText('note to self')).toBe('note to self');
    expect(hostFromText('')).toBe('');
  });
});

describe('displayUrl', () => {
  // The title-line fallback for an untitled link. Unlike hostFromText it KEEPS
  // the path, so three untitled articles from one site stay distinguishable
  // instead of collapsing to a single repeated host.
  it('keeps the path, query and fragment', () => {
    expect(displayUrl('https://example.com/a/b?q=1#x')).toBe('example.com/a/b?q=1#x');
  });

  it('hides https:// but KEEPS http:// — the insecure scheme stays visible', () => {
    expect(displayUrl('https://example.com')).toBe('example.com');
    expect(displayUrl('http://example.com')).toBe('http://example.com');
  });

  it('strips only a LEADING scheme', () => {
    // A redirector carries a whole URL in its query. An unanchored strip would
    // eat that inner scheme instead (or as well), rewriting the link the user
    // reads into one that no longer says where it goes.
    expect(displayUrl('https://example.com/r?to=https://other.com')).toBe(
      'example.com/r?to=https://other.com',
    );
    expect(displayUrl('http://example.com/r?to=https://other.com')).toBe(
      'http://example.com/r?to=https://other.com',
    );
  });

  it('leaves text it cannot recognize alone', () => {
    // Same soft-null path as hostFromText: unparseable text still has to render.
    expect(displayUrl('note to self')).toBe('note to self');
  });
});
