import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { bytesToBase64Url, utf8 } from '@stxapps/shared';

import { fetchAppstoreSubscription } from './appstore';

// The App Store normalization — Apple's status codes and JWS payloads folded
// into a StoreSubscriptionSnapshot. The Apple FLOWS (verify, notification,
// binding) are covered end-to-end in routes/iap.spec.ts; this file pins the
// per-transaction RULES, which that file can only observe through the fold:
// the free-trial marker, the two entitlement clamps (revocation, billing
// grace), and which transaction wins when the response carries several.
//
// Only Apple's endpoint is stubbed — the ES256 JWT minting is real, against the
// test pool's throwaway P-256 key (vitest.config.ts). The JWS blobs carry a
// garbage signature on purpose: the code decodes payloads it fetched from Apple
// over TLS without chain verification (the call-back trust model, lib/appstore.ts).

const DAY_MS = 24 * 60 * 60 * 1000;
const OTID = '2000000000000001';

let apiStatuses: number[] = [200];
let apiBody: unknown = null;
let apiUrls: string[] = [];
const realFetch = globalThis.fetch;

// A compact-JWS-shaped blob whose payload decodes to `payload`. Encoded through
// the same shared base64url as production, over utf8 BYTES rather than `btoa`
// on the JSON string, so a fixture carrying non-ASCII still matches Apple.
function fakeJws(payload: unknown): string {
  const segment = (value: unknown) => bytesToBase64Url(utf8(JSON.stringify(value)));
  return `${segment({ alg: 'ES256' })}.${segment(payload)}.sig`;
}

type TransactionOptions = {
  originalTransactionId?: string;
  status?: number;
  productId?: string;
  expiresDate?: number;
  revocationDate?: number;
  offerDiscountType?: string;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  omitRenewalInfo?: boolean;
};

function transaction(options: TransactionOptions = {}) {
  return {
    originalTransactionId: options.originalTransactionId ?? OTID,
    status: options.status ?? 1,
    signedTransactionInfo: fakeJws({
      productId: options.productId ?? 'com.bracemark.plus.yearly',
      originalTransactionId: options.originalTransactionId ?? OTID,
      expiresDate: options.expiresDate ?? Date.now() + 30 * DAY_MS,
      ...(options.offerDiscountType !== undefined
        ? { offerDiscountType: options.offerDiscountType }
        : undefined),
      ...(options.revocationDate !== undefined
        ? { revocationDate: options.revocationDate }
        : undefined),
    }),
    ...(options.omitRenewalInfo
      ? undefined
      : {
          signedRenewalInfo: fakeJws({
            autoRenewStatus: options.autoRenewStatus ?? 1,
            ...(options.gracePeriodExpiresDate !== undefined
              ? { gracePeriodExpiresDate: options.gracePeriodExpiresDate }
              : undefined),
          }),
        }),
  };
}

// One subscription group holding `transactions` — the shape of the
// subscription-statuses response.
function statusBody(...transactions: ReturnType<typeof transaction>[]) {
  return { data: [{ lastTransactions: transactions }] };
}

function stubApple() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/inApps/v1/subscriptions/')) {
      apiUrls.push(url);
      const status = apiStatuses[Math.min(apiUrls.length - 1, apiStatuses.length - 1)];
      return new Response(
        JSON.stringify(status === 200 ? (apiBody ?? statusBody(transaction())) : {}),
        {
          status,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

describe('fetchAppstoreSubscription', () => {
  beforeAll(stubApple);
  afterEach(() => {
    apiStatuses = [200];
    apiBody = null;
    apiUrls = [];
    vi.restoreAllMocks();
  });

  it('normalizes an active subscription', async () => {
    const expiresDate = Date.now() + 30 * DAY_MS;
    apiBody = statusBody(transaction({ expiresDate }));

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot).toEqual({
      externalId: OTID,
      productId: 'com.bracemark.plus.yearly',
      status: 'active',
      expiresAt: expiresDate,
      canceledAt: null,
    });
  });

  it('marks a FREE_TRIAL offer as trialing', async () => {
    apiBody = statusBody(transaction({ offerDiscountType: 'FREE_TRIAL' }));

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot?.status).toBe('trialing');
    // Display distinction only — the entitlement-bearing fields are what an
    // active subscription's would be, which is what lets the fold ignore it.
    expect(snapshot?.expiresAt).toBeGreaterThan(Date.now());
    expect(snapshot?.canceledAt).toBeNull();
  });

  it('leaves a PAID introductory offer as active', async () => {
    // PAY_AS_YOU_GO / PAY_UP_FRONT are DISCOUNTED intro offers: the user has
    // already been charged, so "renews on" is the truthful sentence and
    // "your first payment is on …" would be a lie. Checking `offerDiscountType`
    // for truthiness rather than for FREE_TRIAL exactly would get this wrong.
    apiBody = statusBody(transaction({ offerDiscountType: 'PAY_AS_YOU_GO' }));
    expect((await fetchAppstoreSubscription(env, OTID))?.status).toBe('active');
  });

  it('does not mark a lapsed trial in billing retry — that user is owed past_due', async () => {
    // Status 3 with the trial's offer type still on the transaction: the first
    // charge FAILED. Telling them they're on a free trial buries the one thing
    // they need to act on.
    apiBody = statusBody(transaction({ status: 3, offerDiscountType: 'FREE_TRIAL' }));
    expect((await fetchAppstoreSubscription(env, OTID))?.status).toBe('past_due');
  });

  it('keeps trialing when the user turns auto-renew off mid-trial', async () => {
    // Still trialing (still entitled, still never charged), but canceledAt
    // stamps the end so willRenew folds false — together they pick "you won't
    // be charged" over "your first payment is on …" in the settings sections.
    const expiresDate = Date.now() + 10 * DAY_MS;
    apiBody = statusBody(
      transaction({ expiresDate, offerDiscountType: 'FREE_TRIAL', autoRenewStatus: 0 }),
    );

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot?.status).toBe('trialing');
    expect(snapshot?.canceledAt).toBe(expiresDate);
  });

  it('clamps entitlement to revocationDate on a refund', async () => {
    // An annual plan refunded in month one keeps its originally paid-through
    // expiresDate; without the clamp it would go on entitling for eleven months.
    const revocationDate = Date.now() - DAY_MS;
    // Status 5 — revoked (refund / Family Sharing revocation).
    apiBody = statusBody(
      transaction({ status: 5, expiresDate: Date.now() + 300 * DAY_MS, revocationDate }),
    );

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot?.status).toBe('canceled');
    expect(snapshot?.expiresAt).toBe(revocationDate);
  });

  it('honors Apple’s billing grace period as the period end', async () => {
    // Status 4: Apple keeps the user entitled through the window configured in
    // App Store Connect, past the expiry the transaction carries.
    const expiresDate = Date.now() - DAY_MS;
    const gracePeriodExpiresDate = Date.now() + 5 * DAY_MS;
    apiBody = statusBody(transaction({ status: 4, expiresDate, gracePeriodExpiresDate }));

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot?.status).toBe('past_due');
    expect(snapshot?.expiresAt).toBe(gracePeriodExpiresDate);
  });

  it('prefers the transaction whose originalTransactionId was looked up', async () => {
    // The response spans every subscription group, so "the first parseable"
    // would be an arbitrary subscription once a second group exists.
    apiBody = statusBody(
      transaction({ originalTransactionId: 'other-group', productId: 'com.bracemark.pro.yearly' }),
      transaction({ originalTransactionId: OTID }),
    );

    const snapshot = await fetchAppstoreSubscription(env, OTID);
    expect(snapshot?.externalId).toBe(OTID);
    expect(snapshot?.productId).toBe('com.bracemark.plus.yearly');
  });

  it('falls back to the first parseable transaction when nothing matches', async () => {
    // The common case the fallback exists for: the app sent a LATER transaction
    // id of the same subscription, which no originalTransactionId equals.
    apiBody = statusBody(transaction({ originalTransactionId: 'otid-original' }));
    expect((await fetchAppstoreSubscription(env, '9999999999'))?.externalId).toBe('otid-original');
  });

  it('skips a transaction whose status code is unknown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    apiBody = statusBody(
      transaction({ originalTransactionId: 'unknown-code', status: 99 }),
      transaction({ originalTransactionId: OTID }),
    );

    expect((await fetchAppstoreSubscription(env, OTID))?.externalId).toBe(OTID);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown status code 99'));
  });

  it('returns null for an id Apple does not know', async () => {
    apiStatuses = [404];
    expect(await fetchAppstoreSubscription(env, OTID)).toBeNull();
    // No production-first-then-sandbox retry: this env's base IS the sandbox
    // host, and the fallback is gated on the production one.
    expect(apiUrls).toHaveLength(1);
  });

  it('throws on a non-404 failure — "couldn’t ask" is not "gone"', async () => {
    apiStatuses = [500];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fetchAppstoreSubscription(env, OTID)).rejects.toThrow('App Store Server API 500');
  });

  it('rejects an id that could reshape the request path', async () => {
    expect(await fetchAppstoreSubscription(env, '../../transactions/1')).toBeNull();
    expect(apiUrls).toHaveLength(0);
  });
});
