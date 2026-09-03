import { describe, expect, it } from 'vitest';

import { assertPublicHttpUrl, SsrfError } from './ssrf';

// The SSRF guard is the load-bearing security check, so it gets the densest tests.
// The key cases are the BYPASS attempts — encoded IPs, IPv6 forms, redirects-shaped
// inputs — that a naive string check would miss but WHATWG canonicalization +
// classification must catch.
describe('assertPublicHttpUrl', () => {
  it('allows ordinary public http(s) URLs', () => {
    expect(assertPublicHttpUrl('https://example.com/a/b?c=d').hostname).toBe('example.com');
    expect(assertPublicHttpUrl('http://1.1.1.1/').hostname).toBe('1.1.1.1');
  });

  it('rejects non-http(s) schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'data:text/html,x', 'ftp://h/']) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects loopback and localhost in every form', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://sub.localhost/',
      'http://[::1]/',
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects the cloud metadata IP (169.254.169.254) and link-local range', () => {
    expect(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      SsrfError,
    );
    expect(() => assertPublicHttpUrl('http://169.254.0.1/')).toThrow(SsrfError);
  });

  it('rejects RFC 1918 / CGNAT private ranges', () => {
    for (const url of [
      'http://10.0.0.5/',
      'http://172.16.3.4/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects ENCODED IPv4 that canonicalizes to a private address', () => {
    // WHATWG URL parsing normalizes these to 127.0.0.1 before we classify.
    for (const url of [
      'http://2130706433/', // decimal
      'http://0x7f000001/', // hex
      'http://0177.0.0.1/', // octal
      'http://127.1/', // short form
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects IPv4-mapped IPv6 pointing at a private address', () => {
    expect(() => assertPublicHttpUrl('http://[::ffff:127.0.0.1]/')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://[::ffff:169.254.169.254]/')).toThrow(SsrfError);
  });

  it('rejects unique-local and link-local IPv6', () => {
    expect(() => assertPublicHttpUrl('http://[fc00::1]/')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://[fd12:3456::1]/')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://[fe80::1]/')).toThrow(SsrfError);
  });

  it('rejects credentials in the authority', () => {
    expect(() => assertPublicHttpUrl('http://user:pass@example.com/')).toThrow(SsrfError);
  });

  it('rejects intranet short names and private TLDs', () => {
    for (const url of ['http://intranet/', 'http://db.internal/', 'http://printer.local/']) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });
  // The inverse of every case above: over-blocking is a silent outage (a whole
  // address family of legitimate sites stops extracting), and nothing else here
  // would catch it — the IPv6 classifier fails CLOSED on anything it can't parse.
  it('allows a public IPv6 literal', () => {
    expect(assertPublicHttpUrl('https://[2606:4700:4700::1111]/').hostname).toBe(
      '[2606:4700:4700::1111]',
    );
    expect(assertPublicHttpUrl('https://[2001:db8::1]/').hostname).toBe('[2001:db8::1]');
  });

  it('canonicalizes an ENCODED PUBLIC address rather than rejecting it', () => {
    // Same normalization the private-IP cases rely on, proven not to be a blanket
    // "encoded means hostile" rule.
    expect(assertPublicHttpUrl('http://0x08080808/').hostname).toBe('8.8.8.8');
    expect(assertPublicHttpUrl('http://134744072/').hostname).toBe('8.8.8.8');
  });

  it('rejects "this network", multicast and reserved ranges', () => {
    for (const url of [
      'http://0.0.0.0/',
      'http://0.1.2.3/',
      'http://224.0.0.1/', // multicast
      'http://240.0.0.1/', // reserved
      'http://255.255.255.255/', // broadcast
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects documentation/benchmarking ranges', () => {
    for (const url of [
      'http://192.0.2.5/', // TEST-NET-1
      'http://198.51.100.5/', // TEST-NET-2
      'http://203.0.113.5/', // TEST-NET-3
      'http://198.18.0.5/', // benchmarking
      'http://192.0.0.8/', // IETF protocol assignments
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('rejects input that is not a URL at all', () => {
    for (const url of ['', 'not a url', '//example.com/', 'example.com']) {
      expect(() => assertPublicHttpUrl(url)).toThrow(SsrfError);
    }
  });

  it('returns the parsed URL with its path and query intact', () => {
    // The return value is what safeFetch actually requests and what an og:image is
    // later resolved against, so it must be the whole URL, not just the host.
    const url = assertPublicHttpUrl('https://Example.test/a/b?c=d#e');
    expect(url.toString()).toBe('https://example.test/a/b?c=d#e');
  });
});
