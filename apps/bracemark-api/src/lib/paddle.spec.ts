import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  fetchPaddleSubscription,
  fetchPaddleTransaction,
  isPaddleTransactionDead,
  isPaddleTransactionUnbilled,
  normalizePaddleStatus,
  paddleTimeToMs,
  verifyPaddleSignature,
} from './paddle';

// The Paddle provider edge in isolation. routes/iap.spec.ts drives the webhook
// end to end (a good signature applies, a bad one and a stale one are refused)
// and the refetch paths through the service; this file covers the parts of the
// edge a route test can't shape: secret ROTATION (two h1s on one header, which
// is the whole reason the header is a list), the malformed-header arms, and the
// two fetchers' null-vs-throw contract — "Paddle doesn't know this id" and
// "we couldn't ask" must not be confused, because one drops an entitlement and
// the other must keep it.

const SECRET = 'test-webhook-secret';
const NOW = 1_760_000_000_000;
const MAX_AGE_MS = 5 * 60 * 1000;

// Sign exactly as Paddle does: HMAC-SHA256 over `${ts}:${rawBody}`, hex.
async function h1For(rawBody: string, ts: number, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}:${rawBody}`)),
  );
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyPaddleSignature', () => {
  const body = JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.updated' });
  const ts = Math.floor(NOW / 1000);

  it('accepts a current, correctly signed header', async () => {
    const header = `ts=${ts};h1=${await h1For(body, ts)}`;

    await expect(verifyPaddleSignature(body, header, SECRET, NOW)).resolves.toBe(true);
  });

  // Paddle sends BOTH secrets' MACs while a notification destination's secret is
  // being rotated. Taking only the first h1 would drop every event for the whole
  // rotation window — and each of those is a subscription state we never see again.
  it('accepts when any h1 matches — the secret-rotation case', async () => {
    const mine = await h1For(body, ts);
    const other = await h1For(body, ts, 'the-other-secret-in-rotation');

    await expect(
      verifyPaddleSignature(body, `ts=${ts};h1=${other};h1=${mine}`, SECRET, NOW),
    ).resolves.toBe(true);
    await expect(
      verifyPaddleSignature(body, `ts=${ts};h1=${mine};h1=${other}`, SECRET, NOW),
    ).resolves.toBe(true);
  });

  it('rejects a header signed with a secret we do not hold', async () => {
    const header = `ts=${ts};h1=${await h1For(body, ts, 'not-our-secret')}`;

    await expect(verifyPaddleSignature(body, header, SECRET, NOW)).resolves.toBe(false);
  });

  // The MAC covers the RAW body: an attacker who replays a valid header against
  // an edited body must fail, which is what makes the raw-bytes discipline in
  // the route (never a re-serialized parse) load-bearing rather than stylistic.
  it('rejects a valid header against a modified body', async () => {
    const header = `ts=${ts};h1=${await h1For(body, ts)}`;

    await expect(verifyPaddleSignature(`${body} `, header, SECRET, NOW)).resolves.toBe(false);
  });

  // The ts is INSIDE the MAC, so moving it to look fresh invalidates the h1 —
  // and leaving it invalidates the age check. Both halves are needed.
  it('rejects a replayed header whose ts was moved forward', async () => {
    const header = `ts=${ts + 60};h1=${await h1For(body, ts)}`;

    await expect(verifyPaddleSignature(body, header, SECRET, NOW)).resolves.toBe(false);
  });

  it('bounds replay by age, symmetrically, at the 5-minute edge', async () => {
    const stale = Math.floor((NOW - MAX_AGE_MS - 1000) / 1000);
    const ahead = Math.floor((NOW + MAX_AGE_MS + 1000) / 1000);
    const edge = Math.floor((NOW - MAX_AGE_MS) / 1000);

    await expect(
      verifyPaddleSignature(body, `ts=${stale};h1=${await h1For(body, stale)}`, SECRET, NOW),
    ).resolves.toBe(false);
    await expect(
      verifyPaddleSignature(body, `ts=${ahead};h1=${await h1For(body, ahead)}`, SECRET, NOW),
    ).resolves.toBe(false);
    await expect(
      verifyPaddleSignature(body, `ts=${edge};h1=${await h1For(body, edge)}`, SECRET, NOW),
    ).resolves.toBe(true);
  });

  it('rejects a missing, incomplete or unparseable header rather than throwing', async () => {
    const h1 = await h1For(body, ts);

    await expect(verifyPaddleSignature(body, undefined, SECRET, NOW)).resolves.toBe(false);
    await expect(verifyPaddleSignature(body, '', SECRET, NOW)).resolves.toBe(false);
    // No ts to age-check against.
    await expect(verifyPaddleSignature(body, `h1=${h1}`, SECRET, NOW)).resolves.toBe(false);
    // No MAC at all — a fresh timestamp must never be enough on its own.
    await expect(verifyPaddleSignature(body, `ts=${ts}`, SECRET, NOW)).resolves.toBe(false);
    // A ts that isn't a number would make the age comparison NaN, which fails
    // every `>` test — i.e. would silently pass the freshness gate.
    await expect(verifyPaddleSignature(body, `ts=soon;h1=${h1}`, SECRET, NOW)).resolves.toBe(false);
    await expect(verifyPaddleSignature(body, 'garbage', SECRET, NOW)).resolves.toBe(false);
  });
});

describe('normalizePaddleStatus', () => {
  it('maps every status we act on', () => {
    expect(normalizePaddleStatus('active')).toBe('active');
    expect(normalizePaddleStatus('trialing')).toBe('trialing');
    expect(normalizePaddleStatus('past_due')).toBe('past_due');
    expect(normalizePaddleStatus('paused')).toBe('paused');
    expect(normalizePaddleStatus('canceled')).toBe('canceled');
  });

  // The map exists so a word Paddle adds later lands as null (log + ignore)
  // instead of being written into a purchase row the fold then reads.
  it('returns null for a status outside the vocabulary', () => {
    expect(normalizePaddleStatus('cancelled')).toBeNull(); // Paddle spells it with one L
    expect(normalizePaddleStatus('')).toBeNull();
    expect(normalizePaddleStatus('constructor')).toBeNull(); // not a prototype hit
  });
});

describe('paddleTimeToMs', () => {
  it('converts an ISO 8601 instant to epoch ms', () => {
    expect(paddleTimeToMs('2026-06-16T08:53:11.000Z')).toBe(Date.parse('2026-06-16T08:53:11.000Z'));
  });

  // Never NaN into the db: a NaN expiry compares false against every clock, so
  // it would read as "already expired" and silently drop the entitlement.
  it('yields null for absent or unparseable input, never NaN', () => {
    expect(paddleTimeToMs(null)).toBeNull();
    expect(paddleTimeToMs(undefined)).toBeNull();
    expect(paddleTimeToMs('')).toBeNull();
    expect(paddleTimeToMs('next tuesday')).toBeNull();
  });
});

describe('transaction status predicates', () => {
  // A dead transaction is dropped on sight; an unbilled one is waited out. The
  // scary case — paid, but no subscription seen — is neither, so it stays
  // pending and keeps being reconciled.
  it('reads canceled as dead and nothing else', () => {
    expect(isPaddleTransactionDead('canceled')).toBe(true);
    for (const status of ['draft', 'ready', 'billed', 'paid', 'completed', 'past_due']) {
      expect(isPaddleTransactionDead(status)).toBe(false);
    }
  });

  it('reads only the pre-payment statuses as unbilled', () => {
    expect(isPaddleTransactionUnbilled('draft')).toBe(true);
    expect(isPaddleTransactionUnbilled('ready')).toBe(true);
    for (const status of ['billed', 'paid', 'completed', 'past_due', 'canceled']) {
      expect(isPaddleTransactionUnbilled(status)).toBe(false);
    }
  });
});

// --- the two fetchers -------------------------------------------------------

let stub: { status: number; body: unknown } = { status: 200, body: null };
let urls: string[] = [];
const realFetch = globalThis.fetch;

const paddleEnv = { ...env, PADDLE_API_BASE: 'https://api.paddle.test', PADDLE_API_KEY: 'pk_test' };

describe('fetchPaddleSubscription / fetchPaddleTransaction', () => {
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://api.paddle.test')) {
        urls.push(url);
        return new Response(stub.status === 200 ? JSON.stringify(stub.body) : '{}', {
          status: stub.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    stub = { status: 200, body: null };
    urls = [];
    vi.restoreAllMocks();
  });

  it('returns the subscription slice, authenticated with the API key', async () => {
    stub = { status: 200, body: { data: { id: 'sub_1', status: 'active' } } };

    await expect(fetchPaddleSubscription(paddleEnv, 'sub_1')).resolves.toMatchObject({
      id: 'sub_1',
      status: 'active',
    });
    expect(urls).toEqual(['https://api.paddle.test/subscriptions/sub_1']);
  });

  // 404 is a fact ("no such subscription"); anything else is us failing to ask.
  // Collapsing the two would let one Paddle outage cancel every subscriber.
  it('returns null for a 404 but THROWS on a transient failure', async () => {
    stub = { status: 404, body: null };
    await expect(fetchPaddleSubscription(paddleEnv, 'sub_gone')).resolves.toBeNull();

    stub = { status: 500, body: null };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fetchPaddleSubscription(paddleEnv, 'sub_1')).rejects.toThrow('Paddle API 500');

    stub = { status: 429, body: null };
    await expect(fetchPaddleTransaction(paddleEnv, 'txn_1')).rejects.toThrow('Paddle API 429');
  });

  it('returns null for a response it cannot parse', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stub = { status: 200, body: { data: { status: 'active' } } }; // no id

    await expect(fetchPaddleSubscription(paddleEnv, 'sub_1')).resolves.toBeNull();
  });

  // The id goes into the URL PATH, so a value carrying `/` or `..` could point
  // the request at a different Paddle endpoint entirely. Rejected before fetch.
  it('refuses an id that could reshape the request path, without calling out', async () => {
    await expect(fetchPaddleSubscription(paddleEnv, '../transactions/txn_1')).resolves.toBeNull();
    await expect(fetchPaddleSubscription(paddleEnv, 'sub_1?include=all')).resolves.toBeNull();
    await expect(fetchPaddleTransaction(paddleEnv, 'txn_1/refund')).resolves.toBeNull();
    expect(urls).toEqual([]);
  });

  it('returns the transaction slice, which is where a subscription id is learned', async () => {
    stub = {
      status: 200,
      body: { data: { id: 'txn_1', status: 'completed', subscription_id: 'sub_9' } },
    };

    await expect(fetchPaddleTransaction(paddleEnv, 'txn_1')).resolves.toMatchObject({
      id: 'txn_1',
      subscription_id: 'sub_9',
    });
    expect(urls).toEqual(['https://api.paddle.test/transactions/txn_1']);
  });
});
