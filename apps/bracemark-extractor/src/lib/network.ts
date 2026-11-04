import type { Context } from 'hono';

import { networkKeyOf } from '@stxapps/shared';

import type { AppEnv } from './env';

// The caller's network: an IPv4 address as is, an IPv6 address as its /64
// (networkKeyOf, @stxapps/shared net/ip.ts). Keying on the full IPv6 address would
// hand anyone holding a /64 (every VPS, most home lines) 2^64 fresh buckets.
// `cf-connecting-ip` is the real client IP, set by Cloudflare's edge; it is
// absent only off the edge, where every caller shares the 'unknown' key.
export function callerNetworkKey(c: Context<AppEnv>): string {
  return networkKeyOf(c.req.header('cf-connecting-ip') ?? 'unknown');
}
