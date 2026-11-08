// SSRF guard — the load-bearing security check for an endpoint whose entire job is
// to `fetch` arbitrary, user-supplied URLs. See docs/link-extraction-server.md: the guard's
// teeth are REDIRECT HANDLING (re-validate every hop),
// not just the host check — a public URL can 30x → 127.0.0.1 / 169.254.169.254, and
// decimal/hex/octal-encoded IPs or non-http(s) schemes slip naive checks.
//
// Defense in depth, three layers:
//   1. This guard — scheme allowlist + private/reserved-IP host blocking, run on
//      the INITIAL url AND on every redirect Location (see lib/safe-fetch.ts).
//   2. WHATWG URL canonicalization — `new URL()` (workerd's ada parser) normalizes
//      every legal IPv4 encoding (octal `0177.0.0.1`, hex `0x7f.1`, decimal
//      `2130706433`) to canonical dotted-decimal BEFORE we classify it, so the
//      blocklist can't be bypassed by re-encoding the address.
//   3. The Workers sandbox itself — it can't open a connection to a private network
//      or cloud IMDS, so even a DNS-rebinding host (public name → A record
//      127.0.0.1) fails to connect rather than reaching an internal service. That's
//      why Workers is the right runtime for this (docs: the sandbox "neutralizes the
//      classic server-side-fetch SSRF").

import { ipv6ToBytes, parseIpv4 } from '@stxapps/shared';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

// Is a 32-bit IPv4 in a private/reserved/non-globally-routable range? We allowlist
// nothing and block every special-use block (RFC 5735/6598 + multicast/reserved),
// because the extractor only ever has a legitimate reason to fetch GLOBAL addresses.
function isBlockedIpv4(ip: number): boolean {
  const inRange = (base: string, prefixLen: number): boolean => {
    const baseIp = parseIpv4(base) ?? 0; // bases are constant, always-valid literals
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    return (ip & mask) === (baseIp & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this network"
    inRange('10.0.0.0', 8) || // RFC 1918 private
    inRange('100.64.0.0', 10) || // RFC 6598 CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local — INCLUDES IMDS 169.254.169.254
    inRange('172.16.0.0', 12) || // RFC 1918 private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.0.2.0', 24) || // TEST-NET-1
    inRange('192.168.0.0', 16) || // RFC 1918 private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // TEST-NET-2
    inRange('203.0.113.0', 24) || // TEST-NET-3
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved (incl. 255.255.255.255 broadcast)
  );
}

// Classify the 16 IPv6 bytes: block loopback/unspecified, unique-local (fc00::/7),
// link-local (fe80::/10), multicast (ff00::/8), and any embedded IPv4 (mapped
// ::ffff:0:0/96 or compatible ::/96) that classifies as private.
function isBlockedIpv6(host: string): boolean {
  const b = ipv6ToBytes(host);
  if (!b) return true; // unparseable as IPv6 → fail closed

  const allZeroExceptLastOne = b.every((x, i) => (i < 15 ? x === 0 : x === 1));
  if (allZeroExceptLastOne) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast

  const embeddedIpv4 = ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0;
  const first10Zero = b.subarray(0, 10).every((x) => x === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(embeddedIpv4); // ::ffff:a.b.c.d (IPv4-mapped)
  }

  const first12Zero = b.subarray(0, 12).every((x) => x === 0);
  if (first12Zero && embeddedIpv4 > 1) {
    return isBlockedIpv4(embeddedIpv4); // ::a.b.c.d (IPv4-compatible, deprecated)
  }
  return false;
}

// Hostnames that name an intranet host rather than a public site. A no-dot host is
// an intranet/short name (a public URL always has a dotted FQDN or an IP literal),
// and the mDNS/private TLDs never resolve to a global address.
function isBlockedName(host: string): boolean {
  if (host === '' || host === 'localhost') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || host.endsWith('.intranet')) return true;
  return !host.includes('.'); // single-label / short name
}

// Validate a single URL string and return the parsed, canonicalized URL — or throw
// SsrfError. Call this on the initial input AND on every redirect Location, since a
// public URL can redirect into private space (lib/safe-fetch.ts does the per-hop
// loop). Pure + side-effect free, so it's cheap to call on each hop.
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('unparseable url');
  }

  // Scheme allowlist — never follow into file:, gopher:, data:, blob:, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('non-http(s) scheme');
  }

  // Credentials in the authority (user:pass@host) are an obfuscation/credential-
  // leak vector and never needed for a public page fetch.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('credentials in url');
  }

  // `hostname` is WHATWG-canonical: IPv4 in dotted-decimal, IPv6 in `[...]`.
  const host = url.hostname.toLowerCase();
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) {
    if (isBlockedIpv4(ipv4)) throw new SsrfError('blocked ipv4');
    return url;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    if (isBlockedIpv6(host.slice(1, -1))) throw new SsrfError('blocked ipv6');
    return url;
  }
  if (isBlockedName(host)) throw new SsrfError('blocked host');

  return url;
}
