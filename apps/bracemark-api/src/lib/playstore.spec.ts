import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  acknowledgePlaystorePurchase,
  fetchPlaystoreSubscription,
  PLAY_FREE_TRIAL_OFFER_TAG,
  playAccessToken,
  resetPlayAccessTokenCache,
} from './playstore';

// The service-account access-token cache and its 401 retry, plus the free-trial
// normalization. The Play FLOWS are covered end-to-end in routes/iap.spec.ts
// (which now scripts exactly one token exchange per test, pinning "a verify that
// also acknowledges mints one token, not two"); this file pins the edges no
// route test can reach: the expiry window, the refusal to cache a lifetime
// Google didn't state, recovery from a token that dies before that window is up,
// and the offer-tag rules that decide `trialing` (which have no status of their
// own to fold, so a route test could only observe them indirectly).
//
// The JWT signing is real (the test pool provides a throwaway RSA key, see
// vitest.config.ts) — only Google's endpoints are stubbed.

let tokenCalls = 0;
let tokenBody: unknown = { access_token: 'tok-1', expires_in: 3600 };
// Statuses each stub returns, one per call (the last one repeats).
let apiStatuses: number[] = [200];
let apiCalls: string[] = [];
let ackStatuses: number[] = [204];
let ackCalls: string[] = [];
const realFetch = globalThis.fetch;

// The subscriptionsv2 answer the stub returns. A function, not a constant: the
// offer-tag tests below rewrite it per case (and `expiryTime` should be
// relative to the test, not to module load).
function subscriptionBody(
  overrides: { state?: string; offerTags?: string[]; autoRenewEnabled?: boolean } = {},
) {
  return {
    subscriptionState: overrides.state ?? 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [
      {
        productId: 'plus',
        expiryTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: overrides.autoRenewEnabled ?? true },
        ...(overrides.offerTags ? { offerDetails: { offerTags: overrides.offerTags } } : undefined),
      },
    ],
  };
}

// What the stub answers a 200 lookup with; reset in each afterEach.
let apiBody: unknown = subscriptionBody();

function stubGoogle() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify(tokenBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/purchases/subscriptionsv2/tokens/')) {
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      apiCalls.push(auth);
      const status = apiStatuses[Math.min(apiCalls.length - 1, apiStatuses.length - 1)];
      return new Response(JSON.stringify(status === 200 ? apiBody : {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes(':acknowledge')) {
      ackCalls.push(new Headers(init?.headers).get('Authorization') ?? '');
      const status = ackStatuses[Math.min(ackCalls.length - 1, ackStatuses.length - 1)];
      // Google answers a successful acknowledge with 204 No Content.
      return new Response(status === 204 ? null : '{}', { status });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

const HOUR_MS = 60 * 60 * 1000;

describe('playAccessToken', () => {
  beforeAll(stubGoogle);
  afterEach(() => {
    resetPlayAccessTokenCache();
    tokenCalls = 0;
    tokenBody = { access_token: 'tok-1', expires_in: 3600 };
    apiStatuses = [200];
    apiBody = subscriptionBody();
    apiCalls = [];
    ackStatuses = [204];
    ackCalls = [];
    vi.restoreAllMocks();
  });

  it('mints once and reuses the token across calls', async () => {
    const now = Date.now();
    expect(await playAccessToken(env, now)).toBe('tok-1');
    expect(await playAccessToken(env, now + 1000)).toBe('tok-1');
    expect(tokenCalls).toBe(1);
  });

  it('re-mints once the refresh margin is reached', async () => {
    const now = Date.now();
    await playAccessToken(env, now);
    tokenBody = { access_token: 'tok-2', expires_in: 3600 };

    // Still inside the window (5 min of margin on a 1h token → 55 min of use).
    expect(await playAccessToken(env, now + 54 * 60 * 1000)).toBe('tok-1');
    expect(tokenCalls).toBe(1);

    // Past it — re-minted BEFORE Google's own expiry, which is the point of the
    // margin: a token handed out here can't lapse mid-flight.
    expect(await playAccessToken(env, now + 56 * 60 * 1000)).toBe('tok-2');
    expect(tokenCalls).toBe(2);
  });

  it('does not cache when the response states no lifetime', async () => {
    tokenBody = { access_token: 'tok-1' };
    const now = Date.now();
    await playAccessToken(env, now);
    await playAccessToken(env, now + 1000);
    expect(tokenCalls).toBe(2);
  });

  it('does not cache a lifetime shorter than the refresh margin', async () => {
    tokenBody = { access_token: 'tok-1', expires_in: 60 };
    const now = Date.now();
    await playAccessToken(env, now);
    await playAccessToken(env, now + 1000);
    expect(tokenCalls).toBe(2);
  });

  it('shares the cache across callers — the token has no user dimension', async () => {
    // What makes cross-request reuse sound: the JWT's claims name the service
    // account and the androidpublisher scope, never a user, so one token serves
    // every account's lookup.
    const now = Date.now();
    await playAccessToken(env, now);
    await playAccessToken(env, now + HOUR_MS / 2);
    expect(tokenCalls).toBe(1);
  });
});

// The recovery the refresh margin can't provide: a token revoked before its
// stated expiry (key rotation) would otherwise poison the isolate for the rest
// of the window.
describe('playApiFetch (via fetchPlaystoreSubscription)', () => {
  beforeAll(stubGoogle);
  afterEach(() => {
    resetPlayAccessTokenCache();
    tokenCalls = 0;
    tokenBody = { access_token: 'tok-1', expires_in: 3600 };
    apiStatuses = [200];
    apiBody = subscriptionBody();
    apiCalls = [];
    ackStatuses = [204];
    ackCalls = [];
    vi.restoreAllMocks();
  });

  it('drops the cached token on a 401 and retries once with a fresh one', async () => {
    apiStatuses = [401, 200];
    tokenBody = { access_token: 'tok-1', expires_in: 3600 };

    // Warm the cache, then let the API reject that token.
    await playAccessToken(env, Date.now());
    expect(tokenCalls).toBe(1);
    tokenBody = { access_token: 'tok-2', expires_in: 3600 };

    const snapshot = await fetchPlaystoreSubscription(env, 'play-token-1');
    expect(snapshot?.productId).toBe('plus');
    // Retried with a NEWLY minted token, not the rejected one.
    expect(apiCalls).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(tokenCalls).toBe(2);
  });

  it('leaves the fresh token cached for the next caller', async () => {
    apiStatuses = [401, 200];
    await fetchPlaystoreSubscription(env, 'play-token-1');
    const mintsAfterRecovery = tokenCalls;

    apiStatuses = [200];
    await fetchPlaystoreSubscription(env, 'play-token-2');
    expect(tokenCalls).toBe(mintsAfterRecovery);
  });

  it('gives up after one retry — a second 401 is a real auth failure', async () => {
    apiStatuses = [401];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Non-ok, non-404 surfaces as a throw (callers turn it into a 5xx /
    // redelivery), and the retry does NOT become a loop.
    await expect(fetchPlaystoreSubscription(env, 'play-token-1')).rejects.toThrow(
      'Play Developer API 401',
    );
    expect(apiCalls).toHaveLength(2);
    expect(tokenCalls).toBe(2);
    // The fresh token failing the same way is the credential's problem, and
    // says so — that's the line worth alerting on, not the first 401.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('after a fresh token'));
  });

  it('does not retry a 404 — a garbage purchase token is not an auth problem', async () => {
    apiStatuses = [404];
    expect(await fetchPlaystoreSubscription(env, 'play-token-1')).toBeNull();
    expect(apiCalls).toHaveLength(1);
    expect(tokenCalls).toBe(1);
  });
});

// The free-trial normalization. Play has no trial STATE — a trialing
// subscription reads SUBSCRIPTION_STATE_ACTIVE — so the offer tag is the whole
// signal, and these pin both directions of it: marking a trial, and (the
// expensive mistake) NOT marking anything else.
describe('fetchPlaystoreSubscription — trialing', () => {
  beforeAll(stubGoogle);
  afterEach(() => {
    resetPlayAccessTokenCache();
    tokenCalls = 0;
    tokenBody = { access_token: 'tok-1', expires_in: 3600 };
    apiStatuses = [200];
    apiBody = subscriptionBody();
    apiCalls = [];
    ackStatuses = [204];
    ackCalls = [];
    vi.restoreAllMocks();
  });

  it('marks an active line carrying the free-trial offer tag', async () => {
    apiBody = subscriptionBody({ offerTags: [PLAY_FREE_TRIAL_OFFER_TAG] });
    const snapshot = await fetchPlaystoreSubscription(env, 'play-token-1');
    expect(snapshot?.status).toBe('trialing');
    // Entitlement-bearing fields are untouched — 'trialing' is a display
    // distinction, and the fold treats it exactly like 'active'.
    expect(snapshot?.expiresAt).toBeGreaterThan(Date.now());
    expect(snapshot?.canceledAt).toBeNull();
  });

  it('leaves a plain active subscription alone', async () => {
    expect((await fetchPlaystoreSubscription(env, 'play-token-1'))?.status).toBe('active');
  });

  it('ignores an offer that is not the free trial', async () => {
    // A discounted introductory offer is still a PAID period — the user has
    // been charged, so "renews on" is the honest sentence. This is the case
    // `offerId`-based detection would get wrong.
    apiBody = subscriptionBody({ offerTags: ['launch-discount'] });
    expect((await fetchPlaystoreSubscription(env, 'play-token-1'))?.status).toBe('active');
  });

  it('finds the tag among several', async () => {
    apiBody = subscriptionBody({ offerTags: ['launch-discount', PLAY_FREE_TRIAL_OFFER_TAG] });
    expect((await fetchPlaystoreSubscription(env, 'play-token-1'))?.status).toBe('trialing');
  });

  it('does not mark a lapsed trial in dunning — that user is owed past_due', async () => {
    // The offer tag is still on the line item while Google retries the FIRST
    // charge, so an ungated check would tell someone whose payment just failed
    // that they are on a free trial.
    apiBody = subscriptionBody({
      state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      offerTags: [PLAY_FREE_TRIAL_OFFER_TAG],
    });
    expect((await fetchPlaystoreSubscription(env, 'play-token-1'))?.status).toBe('past_due');
  });

  it('keeps trialing when the user cancels mid-trial', async () => {
    // Auto-renew off during the trial: still trialing (still entitled, still
    // never charged), but canceledAt stamps the end so willRenew folds false —
    // the two together are what pick "you won't be charged" over "your first
    // payment is on …" in the subscription sections.
    apiBody = subscriptionBody({
      offerTags: [PLAY_FREE_TRIAL_OFFER_TAG],
      autoRenewEnabled: false,
    });
    const snapshot = await fetchPlaystoreSubscription(env, 'play-token-1');
    expect(snapshot?.status).toBe('trialing');
    expect(snapshot?.canceledAt).toBe(snapshot?.expiresAt);
  });

  it('tolerates a line item with no offerDetails at all', async () => {
    // Base-plan purchases omit the field entirely; a missing offer is not a
    // parse failure.
    apiBody = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      lineItems: [{ productId: 'plus', expiryTime: new Date(Date.now() + 1000).toISOString() }],
    };
    expect((await fetchPlaystoreSubscription(env, 'play-token-1'))?.status).toBe('active');
  });
});

// The acknowledge's 4xx handling. Every 4xx returns false either way — the
// client's finishTransaction is the primary path — so what's pinned here is the
// LOG LEVEL, which is the whole point of the split: an unhealable credential
// failure must not read as the routine already-acknowledged race.
describe('acknowledgePlaystorePurchase', () => {
  beforeAll(stubGoogle);
  afterEach(() => {
    resetPlayAccessTokenCache();
    tokenCalls = 0;
    tokenBody = { access_token: 'tok-1', expires_in: 3600 };
    apiStatuses = [200];
    apiBody = subscriptionBody();
    apiCalls = [];
    ackStatuses = [204];
    ackCalls = [];
    vi.restoreAllMocks();
  });

  it('reports success on Google 204', async () => {
    expect(await acknowledgePlaystorePurchase(env, 'plus', 'play-token-1')).toBe(true);
  });

  it('logs a 403 as an error — the credential cannot acknowledge at all', async () => {
    ackStatuses = [403];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await acknowledgePlaystorePurchase(env, 'plus', 'play-token-1')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(error.mock.calls[0][0]).toContain('service-account credential');
  });

  it('logs a 400 quietly — that is the already-acknowledged race', async () => {
    ackStatuses = [400];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await acknowledgePlaystorePurchase(env, 'plus', 'play-token-1')).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already acknowledged?'));
  });

  it('retries a 401 with a fresh token before calling it a credential failure', async () => {
    ackStatuses = [401];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await acknowledgePlaystorePurchase(env, 'plus', 'play-token-1')).toBe(false);
    // playApiFetch's one retry, THEN the 401 branch — not the benign one.
    expect(ackCalls).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('service-account credential'));
  });

  it('still throws on a 5xx — that one is worth a redelivery', async () => {
    ackStatuses = [503];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(acknowledgePlaystorePurchase(env, 'plus', 'play-token-1')).rejects.toThrow(
      'Play Developer API 503',
    );
  });
});
