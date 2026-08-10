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
});
