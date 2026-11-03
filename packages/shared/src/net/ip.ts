// IP address parsing, shared by both Workers: bracemark-extractor's SSRF guard
// classifies the bytes of a URL's host, and both Workers' rate limiters key their
// counters on the caller's network (networkKey below). One parser, so the two
// can't disagree about what an address is.

// Parse a canonical dotted-decimal IPv4 string into its 32-bit value, or null if it
// isn't one. Only exactly four 0-255 octets: the callers hand in WHATWG-canonical
// hosts (`url.hostname`) or Cloudflare's `cf-connecting-ip`, both already
// dotted-decimal, so the legacy encodings (octal, hex, a bare integer) are not
// re-parsed here.
export function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;

  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Expand a (bracket-stripped, lowercased) IPv6 string into its 16 bytes, or null if
// it isn't a valid IPv6 literal. Handles `::` compression and a trailing embedded
// IPv4 (`::ffff:1.2.3.4`). We can't lean on the URL parser's canonical form alone,
// because it re-encodes an embedded IPv4 into hex groups (`::ffff:7f00:1`), so we
// parse the bytes ourselves and let callers classify on them.
export function ipv6ToBytes(input: string): Uint8Array | null {
  let str = input;
  // Fold a trailing dotted IPv4 into two hex groups first.
  const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(str);
  if (v4) {
    const ip = parseIpv4(v4[1]);
    if (ip === null) return null;

    const hi = ((ip >>> 16) & 0xffff).toString(16);
    const lo = (ip & 0xffff).toString(16);
    str = `${str.slice(0, v4.index)}:${hi}:${lo}`;
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;

  const toGroups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const g = parseInt(groups[i], 16);
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

// The unit a per-caller limit counts: the caller's NETWORK, not its address.
//
// An IPv4 address is one subscriber line in practice, so it is its own key. An IPv6
// address is not: a home line or a VPS is handed at least a /64, which is 2^64
// addresses the holder can use at will, so a limiter keyed on the full address
// gives one machine as many buckets as it cares to rotate through. The /64 is the
// IPv6 unit that matches an IPv4 address. Coarser (/56, /48) would put a whole
// office or an ISP's customers in one bucket.
//
// - IPv4 → unchanged: `203.0.113.7`.
// - IPv6 → its /64, in a fixed form: `2001:db8:0:1::/64` for any address in it.
// - IPv4-mapped IPv6 (`::ffff:203.0.113.7`) → the IPv4 inside, so a dual-stack
//   edge can't split one caller across two keys.
// - Anything unparseable → unchanged. It still keys a bucket; it just isn't
//   folded, which is the old behaviour rather than a new failure.
export function networkKey(ip: string): string {
  if (parseIpv4(ip) !== null) return ip;

  const bytes = ipv6ToBytes(ip.toLowerCase());
  if (!bytes) return ip;

  // ::ffff:0:0/96 — an IPv4 address carried in IPv6.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }

  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return `${groups.join(':')}::/64`;
}
