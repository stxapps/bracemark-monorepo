import { ipv6ToBytes, isIpv6Network, networkKeyOf, parseIpv4 } from './ip';

describe('parseIpv4', () => {
  it('reads four octets', () => {
    expect(parseIpv4('203.0.113.7')).toBe(0xcb007107);
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('refuses anything else', () => {
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('0x7f.0.0.1')).toBeNull();
    expect(parseIpv4('2001:db8::1')).toBeNull();
  });
});

describe('ipv6ToBytes', () => {
  it('expands :: compression and an embedded IPv4', () => {
    expect(Array.from(ipv6ToBytes('::1')!)).toEqual([...Array<number>(15).fill(0), 1]);
    expect(Array.from(ipv6ToBytes('::ffff:1.2.3.4')!.slice(10))).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });

  it('refuses malformed literals', () => {
    expect(ipv6ToBytes('1::2::3')).toBeNull();
    expect(ipv6ToBytes('1:2:3:4:5:6:7')).toBeNull();
    expect(ipv6ToBytes('g::1')).toBeNull();
  });
});

describe('networkKeyOf', () => {
  it('keeps an IPv4 address as its own key', () => {
    expect(networkKeyOf('203.0.113.7')).toBe('203.0.113.7');
  });

  // The point of the function: rotating the low 64 bits must not buy a new bucket.
  it('folds every address in an IPv6 /64 to one key', () => {
    const a = networkKeyOf('2001:db8:0:1::1');
    expect(a).toBe('2001:db8:0:1::/64');
    expect(networkKeyOf('2001:db8:0:1:ffff:ffff:ffff:ffff')).toBe(a);
    expect(networkKeyOf('2001:0DB8:0000:0001:abcd::9')).toBe(a);
  });

  it('keeps neighbouring /64s apart', () => {
    expect(networkKeyOf('2001:db8:0:2::1')).not.toBe(networkKeyOf('2001:db8:0:1::1'));
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 inside', () => {
    expect(networkKeyOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(networkKeyOf('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('passes an unparseable value through unchanged', () => {
    expect(networkKeyOf('unknown')).toBe('unknown');
    expect(networkKeyOf('')).toBe('');
  });
});

describe('isIpv6Network', () => {
  it('is true of a /64 and false of everything else networkKeyOf returns', () => {
    expect(isIpv6Network(networkKeyOf('2001:db8:0:1::1'))).toBe(true);
    expect(isIpv6Network(networkKeyOf('::1'))).toBe(true);
    expect(isIpv6Network(networkKeyOf('203.0.113.7'))).toBe(false);
    expect(isIpv6Network(networkKeyOf('::ffff:203.0.113.7'))).toBe(false);
    expect(isIpv6Network(networkKeyOf('unknown'))).toBe(false);
  });
});
