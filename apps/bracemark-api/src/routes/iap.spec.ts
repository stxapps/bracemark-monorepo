import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bytesToBase64Url,
  iapCheckoutEndpoint,
  iapPortalEndpoint,
  iapPricesEndpoint,
  type IapPricesResponse,
  iapStatusEndpoint,
  iapVerifyEndpoint,
  STORE_PRODUCT_IDS,
  type SubscriptionStatus,
  utf8,
} from '@stxapps/shared';

import { app } from '../app';
import { purchasesRepo } from '../db/repositories/purchases';
import { PAST_DUE_GRACE_MS } from '../lib/dunning';
import { newId } from '../lib/ids';
import { resetPlayAccessTokenCache } from '../lib/playstore';
import { issueSession } from '../services/session';
import { APPSTORE_NOTIFY_PATH, PADDLE_WEBHOOK_PATH, PLAYSTORE_NOTIFY_PATH } from './iap';

// The IAP surface through the real Hono app + real (miniflare) D1: the status
// fold, the store verifiers, and the provider webhooks — Paddle signature
// verification (against the test-pool's PADDLE_WEBHOOK_SECRET, see
// vitest.config.ts), the event → purchase-row application, and the out-of-order
// guard. The Paddle events here are the SLICE bracemark-api consumes (lib/paddle.ts
// paddleEventSchema is deliberately loose), signed exactly as Paddle signs:
// HMAC-SHA256 over `${ts}:${rawBody}` in a `ts=…;h1=…` header.
//
// The STORE flows (verify + notify) run against a `globalThis.fetch` stub
// standing in for the App Store Server API / Play Developer API — the JWT
// minting and outbound calls are real (the test pool provides real throwaway
// signing keys, see vitest.config.ts); only the store's answer is scripted.
// (A stub, not vitest-pool-workers' old fetchMock — that export is gone from
// current versions.) The JWS blobs in Apple's responses carry an unverifiable
// signature on purpose: the code decodes payloads it fetched from Apple over
// TLS without chain verification (the call-back trust model —
// lib/appstore.ts), and these tests pin that.

const DAY_MS = 24 * 60 * 60 * 1000;

// One-shot outbound stubs, matched by URL substring in order. Anything
// unmatched fails loudly (tests must never hit the real network), and each
// test asserts its stubs were consumed (assertNoPendingStubs).
let fetchStubs: { match: string; status: number; body: unknown }[] = [];
const realFetch = globalThis.fetch;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function stubOutboundFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // app.request() dispatches the app's own routes through fetch too — only
    // intercept absolute external URLs our stubs know.
    const i = fetchStubs.findIndex((s) => url.includes(s.match));
    if (i >= 0) {
      const [stub] = fetchStubs.splice(i, 1);
      // A null-body status must carry no body — `new Response(json, { status:
      // 204 })` THROWS. Play's `:acknowledge` answers 204 on success, so
      // building one here would blow up inside the code under test (swallowed
      // by its catch) instead of returning the success the stub scripts.
      const nullBody = NULL_BODY_STATUSES.has(stub.status);
      return new Response(nullBody ? null : JSON.stringify(stub.body), {
        status: stub.status,
        headers: nullBody ? undefined : { 'content-type': 'application/json' },
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

// Per-test teardown: every scripted stub must have been consumed, and the Play
// access-token cache (module state in lib/playstore.ts, which outlives a single
// test) is dropped so each test starts cold and scripts its own exchange.
function assertNoPendingStubs() {
  const pending = fetchStubs.map((s) => s.match);
  fetchStubs = [];
  playTokenStubbed = false;
  resetPlayAccessTokenCache();
  expect(pending).toEqual([]);
}

// Capture console for one test. Several tests below deliberately EXERCISE a
// path the server logs on — a store 5xx, a webhook it can't apply, a
// supersession it retired — so the log line is part of the behavior under test,
// not noise. Spying keeps the suite's output clean AND turns the message into
// an assertion, so a silent regression (the branch taken without its log, or
// an error logged where the code promises a quiet log) fails. Restored by the
// outer afterEach.
function captureConsole() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
  };
}

// Drop a stub that must NOT have been consumed (proving no outbound call),
// keeping afterEach's assertNoPendingStubs meaningful.
function takeUnusedStub(match: string) {
  const i = fetchStubs.findIndex((s) => s.match === match);
  expect(i, `expected NO outbound call matching ${match}`).toBeGreaterThanOrEqual(0);
  fetchStubs.splice(i, 1);
}

// A compact-JWS-shaped blob whose payload decodes to `payload` (signature is
// garbage — see the trust-model note above). Encoded through the same shared
// base64url as production, over utf8 BYTES rather than `btoa` on the JSON
// string, so a fixture carrying non-ASCII (a product name, say) still matches
// what Apple would actually send.
function fakeJws(payload: unknown): string {
  const segment = (value: unknown) => bytesToBase64Url(utf8(JSON.stringify(value)));
  return `${segment({ alg: 'ES256' })}.${segment(payload)}.sig`;
}

// Script the App Store Server API's subscription-statuses answer for one GET.
function mockAppstoreStatuses(options: {
  originalTransactionId: string;
  status?: number;
  productId?: string;
  expiresDate?: number;
  revocationDate?: number;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  offerDiscountType?: string;
}) {
  const body = {
    data: [
      {
        lastTransactions: [
          {
            originalTransactionId: options.originalTransactionId,
            status: options.status ?? 1,
            signedTransactionInfo: fakeJws({
              productId: options.productId ?? STORE_PRODUCT_IDS.plus,
              originalTransactionId: options.originalTransactionId,
              expiresDate: options.expiresDate ?? Date.now() + 30 * DAY_MS,
              offerDiscountType: options.offerDiscountType ?? null,
              ...(options.revocationDate !== undefined
                ? { revocationDate: options.revocationDate }
                : undefined),
            }),
            signedRenewalInfo: fakeJws({
              autoRenewStatus: options.autoRenewStatus ?? 1,
              ...(options.gracePeriodExpiresDate !== undefined
                ? { gracePeriodExpiresDate: options.gracePeriodExpiresDate }
                : undefined),
            }),
          },
        ],
      },
    ],
  };
  fetchStubs.push({ match: '/inApps/v1/subscriptions/', status: 200, body });
}

// Script the Play token exchange + subscriptionsv2 answer for one lookup.
// `acknowledgementState` defaults to PENDING — the realistic state for a fresh
// lookup, since verify runs BEFORE the client's finishTransaction; tests whose
// lookup stands in for an already-settled purchase (notifications, refreshes)
// pass ACKNOWLEDGED so no acknowledge call fires.
// The service-account token is cached per isolate (lib/playstore.ts), so a test
// makes exactly ONE token exchange however many Play calls it drives. Both Play
// helpers below route through here, and only the first actually scripts it —
// otherwise the second helper's stub would sit unconsumed and trip
// assertNoPendingStubs, which resets this flag alongside the cache itself.
let playTokenStubbed = false;
function mockPlayToken() {
  if (playTokenStubbed) return;
  playTokenStubbed = true;
  fetchStubs.push({
    match: 'oauth2.googleapis.com/token',
    status: 200,
    body: { access_token: 'test-access-token', expires_in: 3600 },
  });
}

function mockPlaySubscription(options: {
  state?: string;
  productId?: string;
  expiryTime?: number;
  autoRenewEnabled?: boolean;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  // Overrides the single default line entirely (the deferred-plan-change case).
  lineItems?: { productId: string; expiryTime: number; autoRenewEnabled?: boolean }[];
}) {
  mockPlayToken();
  const lines = options.lineItems ?? [
    {
      productId: options.productId ?? STORE_PRODUCT_IDS.plus,
      expiryTime: options.expiryTime ?? Date.now() + 30 * DAY_MS,
      autoRenewEnabled: options.autoRenewEnabled,
    },
  ];
  fetchStubs.push({
    match: '/purchases/subscriptionsv2/tokens/',
    status: 200,
    body: {
      subscriptionState: options.state ?? 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: options.acknowledgementState ?? 'ACKNOWLEDGEMENT_STATE_PENDING',
      ...(options.linkedPurchaseToken
        ? { linkedPurchaseToken: options.linkedPurchaseToken }
        : undefined),
      lineItems: lines.map((line) => ({
        productId: line.productId,
        expiryTime: new Date(line.expiryTime).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: line.autoRenewEnabled ?? true },
      })),
    },
  });
}

// Script the token exchange + the `:acknowledge` POST that follows recording a
// PLAY purchase Google still reports unacknowledged (the 3-day auto-refund
// deadline — lib/playstore.ts). Both the verify path and the notification/
// refresh retry acknowledge, gated on the lookup's acknowledgementState (see
// mockPlaySubscription's default).
// `status` 204 is Google's success; a 4xx stands in for "already acknowledged".
function mockPlayAcknowledge(status = 204) {
  mockPlayToken();
  fetchStubs.push({ match: ':acknowledge', status, body: {} });
}

async function authFor(userId: string): Promise<{ userId: string; auth: Record<string, string> }> {
  const { token } = await issueSession(env, { id: userId, accountDbId: '1' });
  return { userId, auth: { authorization: `Bearer ${token}` } };
}

async function getStatus(auth: Record<string, string>): Promise<SubscriptionStatus> {
  const res = await app.request(iapStatusEndpoint.path, { headers: auth }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as SubscriptionStatus;
}

// Sign a raw body the way Paddle does. `tsSeconds` overridable to test the
// stale-timestamp rejection.
async function paddleSignature(
  rawBody: string,
  secret: string,
  tsSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${tsSeconds}:${rawBody}`)),
  );
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return `ts=${tsSeconds};h1=${hex}`;
}

async function postWebhook(
  body: unknown,
  options: { tsSeconds?: number; signature?: string } = {},
) {
  const rawBody = JSON.stringify(body);
  const signature =
    options.signature ??
    (await paddleSignature(rawBody, env.PADDLE_WEBHOOK_SECRET, options.tsSeconds));
  return app.request(
    PADDLE_WEBHOOK_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Paddle-Signature': signature },
      body: rawBody,
    },
    env,
  );
}

// A subscription.* event carrying the fields applyPaddleEvent consumes. The
// plan's price id comes from the same env var the server maps with, so the test
// tracks the config instead of duplicating a literal.
function subscriptionEvent(overrides: {
  eventType?: string;
  occurredAt?: number;
  subscriptionId: string;
  status?: string;
  userId?: string;
  priceId?: string;
  endsAt?: number | null;
  canceledAt?: number | null;
  scheduledChange?: { action: string; effective_at?: string } | null;
  // The checkout transaction Paddle carries back on `subscription.created` only
  // — omitted everywhere else, which is also what GET /subscriptions/{id}
  // returns (mockPaddleSubscription builds off this same fixture).
  transactionId?: string;
}) {
  const occurredAt = overrides.occurredAt ?? Date.now();
  const endsAt = overrides.endsAt === undefined ? Date.now() + 30 * DAY_MS : overrides.endsAt;
  return {
    event_id: `evt_${newId()}`,
    event_type: overrides.eventType ?? 'subscription.activated',
    occurred_at: new Date(occurredAt).toISOString(),
    data: {
      id: overrides.subscriptionId,
      status: overrides.status ?? 'active',
      customer_id: 'ctm_test',
      custom_data: overrides.userId === undefined ? null : { userId: overrides.userId },
      items: [{ price: { id: overrides.priceId ?? env.PADDLE_PRICE_ID_PLUS } }],
      current_billing_period: endsAt === null ? null : { ends_at: new Date(endsAt).toISOString() },
      canceled_at:
        overrides.canceledAt == null ? null : new Date(overrides.canceledAt).toISOString(),
      scheduled_change: overrides.scheduledChange ?? null,
      transaction_id: overrides.transactionId ?? null,
    },
  };
}

// Script Paddle's GET /subscriptions/{id}. Built from the SAME event builder as
// the webhook tests — deliberately: the whole design rests on Paddle's event
// `data` and its subscription-read `data` being one entity, so the test would
// rather fail than let those drift apart. Shared by both pull-side suites
// (staleness refresh and pending-checkout reconciliation), which reach the same
// applyPaddleSubscription by different routes.
function mockPaddleSubscription(overrides: Parameters<typeof subscriptionEvent>[0]) {
  fetchStubs.push({
    match: `/subscriptions/${overrides.subscriptionId}`,
    status: 200,
    body: { data: subscriptionEvent(overrides).data },
  });
}

describe('iap', () => {
  // Undo captureConsole's spies (every nested describe's own afterEach runs
  // first, so assertions still see them).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe(`GET ${iapStatusEndpoint.path}`, () => {
    it('requires auth', async () => {
      const res = await app.request(iapStatusEndpoint.path, {}, env);
      expect(res.status).toBe(401);
    });

    it('folds an account with no purchases to free/none', async () => {
      const { auth } = await authFor('iap-free-1');
      expect(await getStatus(auth)).toEqual({
        plan: 'free',
        status: 'none',
        source: null,
        expiresAt: null,
        willRenew: false,
      });
    });

    it('folds a non-expiring manual grant to its plan, never renewing', async () => {
      const { userId, auth } = await authFor('iap-manual-1');
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId,
        source: 'manual',
        externalId: `grant-${userId}`,
        plan: 'pro',
        status: 'active',
        providerCustomerId: null,
        expiresAt: null,
        canceledAt: null,
        eventOccurredAt: Date.now(),
      });
      expect(await getStatus(auth)).toEqual({
        plan: 'pro',
        status: 'active',
        source: 'manual',
        expiresAt: null,
        willRenew: false,
      });
    });
  });

  // Display data for the web client's price preview: which catalog id each
  // on-sale plan is being SOLD at, so bracemark-web can ask Paddle what that
  // price costs THIS buyer instead of printing the USD base price from
  // iap/plans.ts. What makes it worth a test is that the answer has to be the
  // same id the checkout will bill — a preview that quotes a different price
  // than the transaction charges is the exact drift this endpoint exists to
  // prevent (it is why the id is served rather than duplicated into a
  // NEXT_PUBLIC_ var).
  describe(`GET ${iapPricesEndpoint.path}`, () => {
    async function getPrices(auth: Record<string, string>): Promise<IapPricesResponse> {
      const res = await app.request(iapPricesEndpoint.path, { headers: auth }, env);
      expect(res.status).toBe(200);
      return (await res.json()) as IapPricesResponse;
    }

    it('requires auth', async () => {
      const res = await app.request(iapPricesEndpoint.path, {}, env);
      expect(res.status).toBe(401);
    });

    it('reports the id checkout sells — the FRONT of the list, not a retired price', async () => {
      const onSale = env.PADDLE_PRICE_ID_PLUS;
      const retired = 'pri_plus_retired_launch_price';
      // Same list the fold still recognizes (see the webhook suite): a retired
      // price keeps entitling its existing subscribers, and must never be
      // quoted to a new one.
      env.PADDLE_PRICE_ID_PLUS = `${onSale},${retired}`;
      try {
        const { auth } = await authFor('iap-prices-1');
        expect(await getPrices(auth)).toEqual({ prices: [{ plan: 'plus', priceId: onSale }] });
      } finally {
        env.PADDLE_PRICE_ID_PLUS = onSale;
      }
    });

    it('omits a plan with no price configured rather than reporting an empty id', async () => {
      // The client's fallback for an absent plan is the base price from
      // plans.ts — the same path it takes when Paddle.js hasn't answered — so
      // an unconfigured env degrades to "shows dollars" rather than "shows an
      // empty price". The operator still hears about it: /iap/checkout 500s.
      const onSale = env.PADDLE_PRICE_ID_PLUS;
      env.PADDLE_PRICE_ID_PLUS = '';
      try {
        const { auth } = await authFor('iap-prices-2');
        expect(await getPrices(auth)).toEqual({ prices: [] });
      } finally {
        env.PADDLE_PRICE_ID_PLUS = onSale;
      }
    });
  });

  describe(`POST ${iapVerifyEndpoint.path}`, () => {
    beforeAll(stubOutboundFetch);
    afterEach(assertNoPendingStubs);

    async function postVerify(
      auth: Record<string, string>,
      body: { source: 'appstore' | 'playstore'; productId?: string; token: string },
    ) {
      return app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ productId: STORE_PRODUCT_IDS.plus, ...body }),
        },
        env,
      );
    }

    it('requires auth', async () => {
      const res = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'appstore', productId: 'p', token: 't' }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('verifies an App Store purchase: fetches Apple, records the row, returns the fold', async () => {
      const { auth } = await authFor('iap-verify-as-1');
      const expiresDate = Date.now() + 30 * DAY_MS;
      mockAppstoreStatuses({ originalTransactionId: 'otid-as-1', expiresDate });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000001' });
      expect(res.status).toBe(200);
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.status).toBe('active');
      expect(status.source).toBe('appstore');
      expect(status.willRenew).toBe(true);
      expect(status.expiresAt).toBe(expiresDate);

      // The fold every device reads agrees.
      expect((await getStatus(auth)).plan).toBe('plus');
    });

    it('verifies a Play purchase through the token exchange + subscriptionsv2', async () => {
      const { auth } = await authFor('iap-verify-ps-1');
      mockPlaySubscription({});
      mockPlayAcknowledge();

      const res = await postVerify(auth, { source: 'playstore', token: 'play-token-ps-1' });
      expect(res.status).toBe(200);
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.source).toBe('playstore');
      expect(status.willRenew).toBe(true);
    });

    // Google auto-refunds and REVOKES an initial subscription purchase left
    // unacknowledged for 3 days. The app acknowledges too (finishTransaction),
    // but only once this call has returned — so the server closes the window
    // between "entitlement recorded" and "client got the response".
    it('acknowledges a Play purchase once the entitlement is recorded', async () => {
      const { auth } = await authFor('iap-verify-ack-1');
      mockPlaySubscription({});
      mockPlayAcknowledge();

      const res = await postVerify(auth, { source: 'playstore', token: 'play-token-ack-1' });
      expect(res.status).toBe(200);
      // assertNoPendingStubs proves the `:acknowledge` POST was actually made.
    });

    it('still returns the fold when acknowledgement fails', async () => {
      const { auth } = await authFor('iap-verify-ack-2');
      const logs = captureConsole();
      mockPlaySubscription({});
      // A 4xx is the "already acknowledged" race (the client's own
      // finishTransaction landing between our fetch and the acknowledge) —
      // benign, and swallowed.
      mockPlayAcknowledge(400);

      const res = await postVerify(auth, { source: 'playstore', token: 'play-token-ack-2' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubscriptionStatus).plan).toBe('plus');
      // …and logged as the non-event it is: the quiet log, never an error.
      expect(logs.log).toHaveBeenCalledWith(expect.stringContaining('already acknowledged?'));
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('skips the acknowledge when Google already reports it acknowledged (a restore)', async () => {
      const { auth } = await authFor('iap-verify-ack-4');
      // A restore re-verifies a purchase Google settled long ago — the gate on
      // acknowledgementState means no acknowledge round-trip at all.
      mockPlaySubscription({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' });
      fetchStubs.push({ match: ':acknowledge', status: 204, body: {} });

      const res = await postVerify(auth, { source: 'playstore', token: 'play-token-ack-4' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubscriptionStatus).plan).toBe('plus');
      takeUnusedStub(':acknowledge');
    });

    it('does not acknowledge an App Store purchase (no such concept)', async () => {
      const { auth } = await authFor('iap-verify-ack-3');
      mockAppstoreStatuses({ originalTransactionId: 'otid-ack-3' });
      // Apple has no acknowledge endpoint — finishTransaction is client-only and
      // an unfinished transaction just replays, with no deadline attached.
      fetchStubs.push({ match: ':acknowledge', status: 204, body: {} });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000003' });
      expect(res.status).toBe(200);
      takeUnusedStub(':acknowledge');
    });

    it('maps auto-renew OFF to a scheduled cancel (entitled, not renewing)', async () => {
      const { auth } = await authFor('iap-verify-as-2');
      mockAppstoreStatuses({ originalTransactionId: 'otid-as-2', autoRenewStatus: 0 });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000002' });
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.willRenew).toBe(false);
    });

    it("keeps an account inside Apple's billing grace period entitled", async () => {
      const { auth } = await authFor('iap-verify-grace-1');
      const expiresDate = Date.now() - 2 * DAY_MS;
      // Status 4: the renewal lapsed but the account is inside the grace window
      // configured in App Store Connect — Apple says entitled through
      // gracePeriodExpiresDate, even though expiresDate is already past. A
      // 28-day grace outruns the fold's own past_due window, so the expiry moves
      // just far enough for the fold to end at Apple's date (lib/appstore.ts).
      const graceEndsAt = expiresDate + 28 * DAY_MS;
      mockAppstoreStatuses({
        originalTransactionId: 'otid-grace-1',
        status: 4,
        expiresDate,
        gracePeriodExpiresDate: graceEndsAt,
      });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000005' });
      expect(res.status).toBe(200);
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.status).toBe('grace');
      expect(status.expiresAt).toBe(graceEndsAt - PAST_DUE_GRACE_MS);
      expect(status.willRenew).toBe(true); // dunning: collection retries are scheduled
    });

    it('prefers the transaction matching the looked-up id over other subscription groups', async () => {
      const { auth } = await authFor('iap-verify-match-1');
      const matchExpiry = Date.now() + 30 * DAY_MS;
      // The statuses response spans EVERY subscription group. "First parseable"
      // would record the other group's pro subscription instead of the one the
      // app actually asked about.
      fetchStubs.push({
        match: '/inApps/v1/subscriptions/',
        status: 200,
        body: {
          data: [
            {
              lastTransactions: [
                {
                  originalTransactionId: 'otid-match-other',
                  status: 1,
                  signedTransactionInfo: fakeJws({
                    productId: STORE_PRODUCT_IDS.pro,
                    originalTransactionId: 'otid-match-other',
                    expiresDate: Date.now() + 300 * DAY_MS,
                  }),
                  signedRenewalInfo: fakeJws({ autoRenewStatus: 1 }),
                },
              ],
            },
            {
              lastTransactions: [
                {
                  originalTransactionId: 'otid-match-mine',
                  status: 1,
                  signedTransactionInfo: fakeJws({
                    productId: STORE_PRODUCT_IDS.plus,
                    originalTransactionId: 'otid-match-mine',
                    expiresDate: matchExpiry,
                  }),
                  signedRenewalInfo: fakeJws({ autoRenewStatus: 1 }),
                },
              ],
            },
          ],
        },
      });

      const res = await postVerify(auth, { source: 'appstore', token: 'otid-match-mine' });
      expect(res.status).toBe(200);
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.expiresAt).toBe(matchExpiry);
    });

    it('takes the line item with the latest expiry on a deferred Play plan change', async () => {
      const { auth } = await authFor('iap-verify-lines-1');
      const laterExpiry = Date.now() + 35 * DAY_MS;
      // A deferred change carries two lines: the expiring current item and the
      // incoming one. The latest expiry is the line that governs where the
      // subscription is headed; [0] would be order-of-response luck.
      mockPlaySubscription({
        lineItems: [
          { productId: STORE_PRODUCT_IDS.pro, expiryTime: Date.now() + 5 * DAY_MS },
          { productId: STORE_PRODUCT_IDS.plus, expiryTime: laterExpiry },
        ],
      });
      mockPlayAcknowledge();

      const res = await postVerify(auth, { source: 'playstore', token: 'play-token-lines-1' });
      expect(res.status).toBe(200);
      const status = (await res.json()) as SubscriptionStatus;
      expect(status.plan).toBe('plus');
      expect(status.expiresAt).toBe(laterExpiry);
    });

    it('422s a token the store does not recognize', async () => {
      const { auth } = await authFor('iap-verify-as-3');
      fetchStubs.push({
        match: '/inApps/v1/subscriptions/',
        status: 404,
        body: { errorCode: 4040010 },
      });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000003' });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_receipt');
    });

    it('422s a verified purchase for a product we never sold', async () => {
      const { auth } = await authFor('iap-verify-as-4');
      const logs = captureConsole();
      mockAppstoreStatuses({ originalTransactionId: 'otid-as-4', productId: 'bracemark.unknown' });

      const res = await postVerify(auth, { source: 'appstore', token: '2000000000000004' });
      expect(res.status).toBe(422);
      // A product the store sold but this server doesn't map is a CONFIG bug —
      // it must land in the logs, not just in the client's 422.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('unknown product "bracemark.unknown"'),
      );
    });

    it('409s a subscription already bound to another account (first sight is for life)', async () => {
      const first = await authFor('iap-verify-bind-1');
      mockAppstoreStatuses({ originalTransactionId: 'otid-bind-1' });
      expect(
        (await postVerify(first.auth, { source: 'appstore', token: '3000000000000001' })).status,
      ).toBe(200);

      // A second account replays the same token — Apple answers the same
      // subscription; the stored binding must win.
      const second = await authFor('iap-verify-bind-2');
      mockAppstoreStatuses({ originalTransactionId: 'otid-bind-1' });
      const res = await postVerify(second.auth, { source: 'appstore', token: '3000000000000001' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('purchase_bound');
      expect((await getStatus(second.auth)).plan).toBe('free');
    });

    it('records a store purchase made while a Paddle sub is live, and alerts on it', async () => {
      // The store side has no pre-payment refusal to give: unlike
      // `POST /iap/checkout`, by the time verify is called the customer has
      // ALREADY been charged. 409-ing would leave them paid-for-nothing — the
      // app never reaches finishTransaction, so Apple replays the transaction
      // forever with nothing refunded and Play's 3-day fuse revokes it. So the
      // purchase is honored; what the alert buys is VISIBILITY, since the fold
      // takes the best row and would otherwise make the second charge invisible.
      const { userId, auth } = await authFor('iap-verify-double-1');
      expect(
        (await postWebhook(subscriptionEvent({ subscriptionId: 'sub_double_1', userId }))).status,
      ).toBe(200);
      expect((await getStatus(auth)).plan).toBe('plus');

      const logs = captureConsole();
      mockAppstoreStatuses({ originalTransactionId: 'otid-double-1' });
      const res = await postVerify(auth, { source: 'appstore', token: '4000000000000001' });

      expect(res.status).toBe(200);
      expect(((await res.json()) as SubscriptionStatus).plan).toBe('plus');
      // Names both sides, because the fix is an operator refunding one of them.
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('IAP_DOUBLE_SUBSCRIPTION'));
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('via paddle'));
    });

    it('stays quiet when the same store re-keys a subscription (a plan change is not two)', async () => {
      // The scoping that makes the alert usable: Play mints a NEW token on a
      // plan change, so the replacement's verify necessarily sees the
      // superseded row still entitled. Firing there would put the alert on
      // every single Play upgrade and drown the case it exists for.
      const { auth } = await authFor('iap-verify-double-2');
      mockPlaySubscription({});
      mockPlayAcknowledge();
      expect(
        (await postVerify(auth, { source: 'playstore', token: 'play-double-old' })).status,
      ).toBe(200);

      const logs = captureConsole();
      mockPlaySubscription({
        productId: STORE_PRODUCT_IDS.pro,
        linkedPurchaseToken: 'play-double-old',
      });
      mockPlayAcknowledge();
      expect(
        (await postVerify(auth, { source: 'playstore', token: 'play-double-new' })).status,
      ).toBe(200);

      expect((await getStatus(auth)).plan).toBe('pro');
      expect(logs.error).not.toHaveBeenCalledWith(
        expect.stringContaining('IAP_DOUBLE_SUBSCRIPTION'),
      );
    });

    // --- Play's linkedPurchaseToken supersession (lib/playstore.ts) ----------
    // Play RE-KEYS a subscription on an upgrade/downgrade/re-signup: the new
    // purchase token is a new identity, so a new row, and the old token goes on
    // resolving as valid at Google. Unless the server retires it, the old row
    // keeps entitling — and nothing else can notice (the staleness refresh
    // ignores a row that reads active with a future expiry).

    it('retires the token a Play downgrade replaced (no free ride on the old plan)', async () => {
      const { auth } = await authFor('iap-verify-link-1');
      const logs = captureConsole();

      // On pro.
      mockPlaySubscription({ productId: STORE_PRODUCT_IDS.pro });
      mockPlayAcknowledge();
      expect((await postVerify(auth, { source: 'playstore', token: 'play-link-pro' })).status).toBe(
        200,
      );
      expect((await getStatus(auth)).plan).toBe('pro');

      // Downgrades to plus → a NEW token, linked back to the pro one. The pro
      // row still has a year to run, and the fold takes the best PLAN — so
      // without supersession the user pays plus and keeps pro.
      mockPlaySubscription({
        productId: STORE_PRODUCT_IDS.plus,
        linkedPurchaseToken: 'play-link-pro',
      });
      mockPlayAcknowledge();
      const res = await postVerify(auth, { source: 'playstore', token: 'play-link-plus' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubscriptionStatus).plan).toBe('plus');
      expect((await getStatus(auth)).plan).toBe('plus');
      // Retiring a row the user paid for is worth a trail — this is the line to
      // reach for when a support ticket says "my pro just vanished".
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('retired playstore play-link-pro'),
      );
    });

    it('retires a replaced token bound to ANOTHER account (one payment, one entitlement)', async () => {
      // The duplicate-subscription hole: re-signup while signed into a second
      // Bracemark account. `purchase_bound` cannot catch it — the tokens differ —
      // so both accounts would be entitled on a single payment.
      const first = await authFor('iap-verify-link-a');
      const logs = captureConsole();
      mockPlaySubscription({});
      mockPlayAcknowledge();
      expect(
        (await postVerify(first.auth, { source: 'playstore', token: 'play-link-acct-a' })).status,
      ).toBe(200);
      expect((await getStatus(first.auth)).plan).toBe('plus');

      const second = await authFor('iap-verify-link-b');
      mockPlaySubscription({ linkedPurchaseToken: 'play-link-acct-a' });
      mockPlayAcknowledge();
      expect(
        (await postVerify(second.auth, { source: 'playstore', token: 'play-link-acct-b' })).status,
      ).toBe(200);

      expect((await getStatus(second.auth)).plan).toBe('plus');
      expect((await getStatus(first.auth)).plan).toBe('free');
      // The cross-account retirement names the OLD token and its user — the
      // only record of why that account lost its plan.
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('retired playstore play-link-acct-a (user iap-verify-link-a'),
      );
    });

    it('walks a replacement chain across a hop it never recorded', async () => {
      // X was verified; Y's verify never landed (so there is no Y row); Z now
      // arrives linked to Y. One hop would stop at the missing Y row and leave
      // X entitled forever, so the walk bridges Y by asking Google what IT
      // replaced.
      const { auth } = await authFor('iap-verify-link-chain');
      const logs = captureConsole();
      mockPlaySubscription({ productId: STORE_PRODUCT_IDS.pro });
      mockPlayAcknowledge();
      expect((await postVerify(auth, { source: 'playstore', token: 'play-chain-x' })).status).toBe(
        200,
      );
      expect((await getStatus(auth)).plan).toBe('pro');

      // Stubs are consumed in push order: Z's own lookup, then the bridging
      // lookup of Y, then the acknowledge.
      mockPlaySubscription({
        productId: STORE_PRODUCT_IDS.plus,
        linkedPurchaseToken: 'play-chain-y',
      });
      mockPlaySubscription({ linkedPurchaseToken: 'play-chain-x' }); // the Y bridge
      mockPlayAcknowledge();
      const res = await postVerify(auth, { source: 'playstore', token: 'play-chain-z' });
      expect(res.status).toBe(200);
      expect((await getStatus(auth)).plan).toBe('plus');
      // X — the far end of the chain — is what got retired, not the bridged Y.
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('retired playstore play-chain-x'),
      );
    });
  });

  describe(`store notifications`, () => {
    beforeAll(stubOutboundFetch);
    afterEach(assertNoPendingStubs);

    it('playstore: rejects a bad push token before any outbound work', async () => {
      const res = await app.request(
        `${PLAYSTORE_NOTIFY_PATH}?token=wrong`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('playstore: re-fetches Google and applies the newer state to the bound row', async () => {
      // Bind the subscription first via verify (notifications carry no account).
      const { auth } = await authFor('iap-notify-ps-1');
      mockPlaySubscription({});
      mockPlayAcknowledge();
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'playstore',
            productId: STORE_PRODUCT_IDS.plus,
            token: 'play-token-notify-1',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200);
      expect((await getStatus(auth)).willRenew).toBe(true);

      // The user cancels in the Play app → an RTDN arrives; the route must
      // re-read Google's (now canceled) state, never the pushed payload. Long
      // since acknowledged, so the notification path makes no acknowledge call.
      mockPlaySubscription({
        state: 'SUBSCRIPTION_STATE_CANCELED',
        autoRenewEnabled: false,
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      });
      const push = {
        message: {
          data: btoa(
            JSON.stringify({
              version: '1.0',
              packageName: 'com.bracemark.app',
              subscriptionNotification: {
                notificationType: 3, // SUBSCRIPTION_CANCELED — advisory only
                purchaseToken: 'play-token-notify-1',
                subscriptionId: STORE_PRODUCT_IDS.plus,
              },
            }),
          ),
        },
      };
      const res = await app.request(
        `${PLAYSTORE_NOTIFY_PATH}?token=${env.PLAY_NOTIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(push),
        },
        env,
      );
      expect(res.status).toBe(200);

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus'); // entitled through the paid period
      expect(status.willRenew).toBe(false);
    });

    it('playstore: retires a replaced token even when the REPLACEMENT is unbound', async () => {
      // The upgrade RTDN can beat the app's `iap/verify`, so the new token has
      // no account yet and the notification drops out at the binding check.
      // Supersession must still happen: it is a fact about the OLD token, whose
      // row is bound and entitled, and dropping it there would leave the user
      // on the higher plan for free until the old period ran out.
      const { auth } = await authFor('iap-notify-ps-link');
      const logs = captureConsole();
      mockPlaySubscription({ productId: STORE_PRODUCT_IDS.pro });
      mockPlayAcknowledge();
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'playstore',
            productId: STORE_PRODUCT_IDS.pro,
            token: 'play-notify-link-old',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200);
      expect((await getStatus(auth)).plan).toBe('pro');

      mockPlaySubscription({
        productId: STORE_PRODUCT_IDS.plus,
        linkedPurchaseToken: 'play-notify-link-old',
      });
      const res = await app.request(
        `${PLAYSTORE_NOTIFY_PATH}?token=${env.PLAY_NOTIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              data: btoa(
                JSON.stringify({
                  version: '1.0',
                  packageName: 'com.bracemark.app',
                  subscriptionNotification: {
                    notificationType: 4, // SUBSCRIPTION_PURCHASED — advisory only
                    purchaseToken: 'play-notify-link-new',
                    subscriptionId: STORE_PRODUCT_IDS.plus,
                  },
                }),
              ),
            },
          }),
        },
        env,
      );
      expect(res.status).toBe(200); // ACKed despite the unbound replacement

      // The old row is retired; the new one isn't ours yet, so the account
      // falls to free until the app's verify lands and binds it.
      expect((await getStatus(auth)).plan).toBe('free');
      // Both halves are logged: the retirement happened, and the drop-out that
      // followed is the benign unbound case rather than an error.
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('retired playstore play-notify-link-old'),
      );
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('no binding yet for playstore play-notify-link-new'),
      );
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('playstore: retries the acknowledge when both purchase-time acks failed', async () => {
      const { auth } = await authFor('iap-notify-ack-1');
      const logs = captureConsole();
      // Purchase-time: the entitlement records, but the server-side acknowledge
      // 5xxes (and the client, say, dies before its finishTransaction).
      mockPlaySubscription({});
      mockPlayAcknowledge(500);
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'playstore',
            productId: STORE_PRODUCT_IDS.plus,
            token: 'play-token-ack-retry-1',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200); // a recorded purchase never fails over the ack
      expect((await getStatus(auth)).plan).toBe('plus');
      // The 5xx throws (it's the one status worth a redelivery) and is caught
      // at the call site — logged, never fatal to the purchase.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('acknowledge failed for play-token-ack-retry-1'),
        expect.any(Error),
      );
      logs.error.mockClear();

      // The purchase RTDN re-fetches, sees the purchase still PENDING on a row
      // we HAVE recorded, and closes Google's 3-day auto-refund fuse.
      mockPlaySubscription({});
      mockPlayAcknowledge();
      const res = await app.request(
        `${PLAYSTORE_NOTIFY_PATH}?token=${env.PLAY_NOTIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              data: btoa(
                JSON.stringify({
                  version: '1.0',
                  packageName: 'com.bracemark.app',
                  subscriptionNotification: {
                    notificationType: 4, // SUBSCRIPTION_PURCHASED — advisory only
                    purchaseToken: 'play-token-ack-retry-1',
                    subscriptionId: STORE_PRODUCT_IDS.plus,
                  },
                }),
              ),
            },
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      // assertNoPendingStubs proves the second `:acknowledge` was actually made,
      // and the silent error channel proves THAT one landed on Google's 204.
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('appstore: extracts the transaction id, re-fetches Apple, applies to the bound row', async () => {
      const { auth } = await authFor('iap-notify-as-1');
      mockAppstoreStatuses({ originalTransactionId: 'otid-notify-1' });
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'appstore',
            productId: STORE_PRODUCT_IDS.plus,
            token: '4000000000000001',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200);

      // Auto-renew turned off → DID_CHANGE_RENEWAL_STATUS notification; facts
      // come from the re-fetch (autoRenewStatus 0), not the notification body.
      mockAppstoreStatuses({ originalTransactionId: 'otid-notify-1', autoRenewStatus: 0 });
      const res = await app.request(
        APPSTORE_NOTIFY_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            signedPayload: fakeJws({
              notificationType: 'DID_CHANGE_RENEWAL_STATUS',
              data: {
                signedTransactionInfo: fakeJws({ originalTransactionId: 'otid-notify-1' }),
              },
            }),
          }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus');
      expect(status.willRenew).toBe(false);
    });

    it('appstore: a refund (revocation) claws back entitlement at revocationDate', async () => {
      const { auth } = await authFor('iap-notify-refund-1');
      mockAppstoreStatuses({ originalTransactionId: 'otid-refund-1' });
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'appstore',
            productId: STORE_PRODUCT_IDS.plus,
            token: '5000000000000001',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200);
      expect((await getStatus(auth)).plan).toBe('plus');

      // Apple refunds mid-period: status 5 arrives with the ORIGINAL
      // expiresDate still months out — entitlement must end at revocationDate,
      // not ride the paid-through date to its end.
      mockAppstoreStatuses({
        originalTransactionId: 'otid-refund-1',
        status: 5,
        expiresDate: Date.now() + 300 * DAY_MS,
        revocationDate: Date.now() - 1000,
      });
      const res = await app.request(
        APPSTORE_NOTIFY_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            signedPayload: fakeJws({
              notificationType: 'REFUND',
              data: {
                signedTransactionInfo: fakeJws({ originalTransactionId: 'otid-refund-1' }),
              },
            }),
          }),
        },
        env,
      );
      expect(res.status).toBe(200);

      expect((await getStatus(auth)).plan).toBe('free');
    });

    it('appstore: ACKs a notification for a never-verified subscription (no binding yet)', async () => {
      const logs = captureConsole();
      mockAppstoreStatuses({ originalTransactionId: 'otid-notify-unbound' });
      const res = await app.request(
        APPSTORE_NOTIFY_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            signedPayload: fakeJws({
              data: {
                signedTransactionInfo: fakeJws({ originalTransactionId: 'otid-notify-unbound' }),
              },
            }),
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      // An unbound notification is expected (the RTDN can beat iap/verify), so
      // it's the quiet log — an error here would page someone for nothing.
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('no binding yet for appstore otid-notify-unbound'),
      );
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('appstore: ACKs the TEST ping (no transaction to look up)', async () => {
      const res = await app.request(
        APPSTORE_NOTIFY_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signedPayload: fakeJws({ notificationType: 'TEST' }) }),
        },
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  // "Manage billing". The stub is keyed on Paddle's real path — the customer
  // is a path segment, `/customers/{ctm_…}/portal-sessions` — so a regression
  // to any other URL leaves it unconsumed and fails the suite rather than
  // shipping a button that 502s for every subscriber.
  describe(`POST ${iapPortalEndpoint.path}`, () => {
    beforeAll(stubOutboundFetch);
    afterEach(assertNoPendingStubs);

    async function postPortal(auth: Record<string, string>) {
      return app.request(
        iapPortalEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: '{}',
        },
        env,
      );
    }

    it('mints a session for the stored ctm_… and returns its overview url', async () => {
      const { userId, auth } = await authFor('iap-portal-1');
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId,
        source: 'paddle',
        externalId: 'sub_portal_1',
        plan: 'plus',
        status: 'active',
        providerCustomerId: 'ctm_portal_1',
        expiresAt: Date.now() + 30 * DAY_MS,
        canceledAt: null,
        eventOccurredAt: Date.now(),
      });
      const url = 'https://sandbox-customer-portal.paddle.com/cpl_x?action=overview&token=pga_x';
      fetchStubs.push({
        match: '/customers/ctm_portal_1/portal-sessions',
        status: 201,
        body: { data: { urls: { general: { overview: url }, subscriptions: [] } } },
      });

      const res = await postPortal(auth);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url });
    });

    it('404s an account with no Paddle customer, without asking Paddle', async () => {
      const { auth } = await authFor('iap-portal-2');
      const res = await postPortal(auth);
      expect(res.status).toBe(404);
    });
  });

  describe(`POST ${PADDLE_WEBHOOK_PATH}`, () => {
    it('rejects a bad signature and a stale timestamp', async () => {
      const event = subscriptionEvent({ subscriptionId: 'sub_bad', userId: 'iap-x' });

      const badSig = await postWebhook(event, { signature: 'ts=1;h1=deadbeef' });
      expect(badSig.status).toBe(401);

      // Correctly signed but 10 minutes old — outside the replay window.
      const stale = await postWebhook(event, {
        tsSeconds: Math.floor((Date.now() - 10 * 60 * 1000) / 1000),
      });
      expect(stale.status).toBe(401);
    });

    it('applies a signed activation: the account flips to the plan of the priced item', async () => {
      const { userId, auth } = await authFor('iap-hook-1');
      const endsAt = Date.now() + 30 * DAY_MS;

      const res = await postWebhook(
        subscriptionEvent({ subscriptionId: 'sub_hook_1', userId, endsAt }),
      );
      expect(res.status).toBe(200);

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus');
      expect(status.status).toBe('active');
      expect(status.source).toBe('paddle');
      expect(status.willRenew).toBe(true);
      // toISOString keeps milliseconds, so the period end round-trips exactly.
      expect(status.expiresAt).toBe(endsAt);
    });

    it('folds a trialing subscription to trialing + entitled + renewing', async () => {
      const { userId, auth } = await authFor('iap-hook-trial-1');
      const endsAt = Date.now() + 14 * DAY_MS; // trial end

      await postWebhook(
        subscriptionEvent({ subscriptionId: 'sub_hook_t1', userId, status: 'trialing', endsAt }),
      );

      const status = await getStatus(auth);
      // Fully entitled — a trialing account gets exactly its plan.
      expect(status.plan).toBe('plus');
      // But NOT reported as 'active'. The two are identical in entitlement and
      // different in what the UI owes the user: `expiresAt` here is the FIRST
      // CHARGE, so a section rendering "Renews on <date>" off an 'active' would
      // imply they had already paid.
      expect(status.status).toBe('trialing');
      expect(status.willRenew).toBe(true);
      expect(status.expiresAt).toBe(endsAt);
    });

    it('does NOT entitle a provider row with a null expiry (missing period ≠ lifetime)', async () => {
      const { userId, auth } = await authFor('iap-hook-nullexp-1');

      // A trialing event that arrived without a current_billing_period: null expiry
      // is a MISSING period for a provider sub, not a lifetime grant — it must fold
      // to free, never entitle forever (only source:'manual' grants may be lifetime).
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_hook_ne1',
          userId,
          status: 'trialing',
          endsAt: null,
        }),
      );

      expect(await getStatus(auth)).toEqual({
        plan: 'free',
        status: 'none',
        source: null,
        expiresAt: null,
        willRenew: false,
      });
    });

    it('a scheduled cancellation keeps the plan but stops renewal', async () => {
      const { userId, auth } = await authFor('iap-hook-cancel-1');
      const endsAt = Date.now() + 20 * DAY_MS;

      await postWebhook(subscriptionEvent({ subscriptionId: 'sub_hook_c1', userId, endsAt }));
      await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.updated',
          occurredAt: Date.now() + 1000,
          subscriptionId: 'sub_hook_c1',
          userId,
          endsAt,
          scheduledChange: { action: 'cancel', effective_at: new Date(endsAt).toISOString() },
        }),
      );

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus'); // entitled through the paid period
      expect(status.willRenew).toBe(false);
    });

    it('an immediate cancellation (refund/chargeback) ends entitlement now, not at period end', async () => {
      const { userId, auth } = await authFor('iap-hook-refund-1');
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_hook_r1',
          userId,
          endsAt: Date.now() + 30 * DAY_MS,
        }),
      );
      expect((await getStatus(auth)).plan).toBe('plus');

      // Paddle cancels immediately: canceled_at = now and the billing period is
      // GONE from the payload — without the clamp, the upsert's COALESCE would
      // keep the stale period end and entitle the refunded user for the rest of
      // the month.
      await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.canceled',
          occurredAt: Date.now() + 1000,
          subscriptionId: 'sub_hook_r1',
          userId,
          status: 'canceled',
          endsAt: null,
          canceledAt: Date.now() - 1000,
        }),
      );
      expect((await getStatus(auth)).plan).toBe('free');
    });

    it('drops an out-of-order older event instead of regressing state', async () => {
      const { userId, auth } = await authFor('iap-hook-order-1');
      const now = Date.now();

      // Newest state first: an active subscription…
      await postWebhook(
        subscriptionEvent({ subscriptionId: 'sub_hook_o1', userId, occurredAt: now }),
      );
      // …then a STALE, earlier-occurred paused event arrives late (a redelivery).
      await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.paused',
          occurredAt: now - 60_000,
          subscriptionId: 'sub_hook_o1',
          userId,
          status: 'paused',
        }),
      );

      expect((await getStatus(auth)).plan).toBe('plus'); // the newer 'active' held
    });

    it('binds a subscription to its first-seen account for life', async () => {
      const { userId, auth } = await authFor('iap-hook-bind-1');
      await postWebhook(subscriptionEvent({ subscriptionId: 'sub_hook_b1', userId }));

      // A later event carrying a DIFFERENT custom_data.userId must not re-point
      // the subscription (the stored binding wins).
      const other = await authFor('iap-hook-bind-2');
      await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.updated',
          occurredAt: Date.now() + 1000,
          subscriptionId: 'sub_hook_b1',
          userId: other.userId,
        }),
      );

      expect((await getStatus(auth)).plan).toBe('plus');
      expect((await getStatus(other.auth)).plan).toBe('free');
    });

    it('ACKs (200) an event it cannot apply, so Paddle never redelivers forever', async () => {
      // Unknown price id → logged and dropped, still 200.
      const logs = captureConsole();
      const res = await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_hook_unknown',
          userId: 'iap-hook-u1',
          priceId: 'pri_unknown',
        }),
      );
      expect(res.status).toBe(200);
      // The 200 is why the log MATTERS: Paddle is told never to retry, so this
      // line is the only trace left of a user who paid. It carries the alert
      // marker because the subscription is first-seen — no row to recover from.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('no known price in [pri_unknown] for sub_hook_unknown'),
      );
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('IAP_DROP_UNRECOVERABLE'));
    });

    it('applies every price in a plan’s list, not just the one on sale', async () => {
      // PADDLE_PRICE_ID_* is a comma-separated LIST because the read side has to
      // recognize every price the catalog has ever charged: an unrecognized
      // pri_… is `unknown_price`, which is log-and-ACK, which is permanent —
      // the subscriber pays and is never entitled. So a price that has been
      // retired from the storefront (or a second cadence added to it) must keep
      // folding, and only the FRONT of the list is what checkout sells.
      const onSale = env.PADDLE_PRICE_ID_PLUS;
      const retired = 'pri_plus_retired_launch_price';
      env.PADDLE_PRICE_ID_PLUS = `${onSale},${retired}`;
      try {
        const stillOnSale = await authFor('iap-price-list-1');
        expect(
          (
            await postWebhook(
              subscriptionEvent({
                subscriptionId: 'sub_price_list_1',
                userId: stillOnSale.userId,
                priceId: onSale,
              }),
            )
          ).status,
        ).toBe(200);
        expect((await getStatus(stillOnSale.auth)).plan).toBe('plus');

        const grandfathered = await authFor('iap-price-list-2');
        expect(
          (
            await postWebhook(
              subscriptionEvent({
                subscriptionId: 'sub_price_list_2',
                userId: grandfathered.userId,
                priceId: retired,
              }),
            )
          ).status,
        ).toBe(200);
        expect((await getStatus(grandfathered.auth)).plan).toBe('plus');
      } finally {
        env.PADDLE_PRICE_ID_PLUS = onSale;
      }
    });
  });

  // The PULL side: a row that looks wrong gets re-read from its provider on the
  // status route, so a webhook that never landed (retries exhausted, destination
  // disabled, or an event we ACKed and dropped — all permanent) still converges.
  describe('staleness refresh', () => {
    beforeAll(stubOutboundFetch);
    afterEach(assertNoPendingStubs);

    // Age a row's debounce clock: "the last time we heard anything about this
    // subscription was long ago". Every write stamps it `now`, so without this
    // a just-applied row is never refetched — the property that keeps the
    // healthy path free of outbound calls.
    async function clearSyncClock(externalId: string) {
      await env.DIRECTORY_DB.prepare(
        `UPDATE purchases SET last_synced_at = 0 WHERE external_id = ?`,
      )
        .bind(externalId)
        .run();
    }

    it('re-pulls Paddle for an expired row and self-heals the missed renewal', async () => {
      const { userId, auth } = await authFor('iap-refresh-1');

      // The last event we ever got put the period end in the past: the renewal
      // webhook never arrived, so the account reads free despite being paid.
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_refresh_1',
          userId,
          endsAt: Date.now() - 2 * DAY_MS,
        }),
      );
      await clearSyncClock('sub_refresh_1');

      // Paddle's actual state: renewed, running another month.
      const renewedTo = Date.now() + 28 * DAY_MS;
      mockPaddleSubscription({ subscriptionId: 'sub_refresh_1', userId, endsAt: renewedTo });

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus');
      expect(status.status).toBe('active');
      expect(status.expiresAt).toBe(renewedTo);
    });

    it('does not call the provider for a healthy row', async () => {
      const { userId, auth } = await authFor('iap-refresh-healthy-1');
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_refresh_h1',
          userId,
          endsAt: Date.now() + 30 * DAY_MS,
        }),
      );
      // Even with the debounce clock cleared, an entitled active row inside its
      // period has nothing to ask about — the 99% case stays one D1 query.
      await clearSyncClock('sub_refresh_h1');
      mockPaddleSubscription({ subscriptionId: 'sub_refresh_h1', userId });

      expect((await getStatus(auth)).plan).toBe('plus');
      takeUnusedStub('/subscriptions/sub_refresh_h1');
    });

    it('debounces: a second read inside the window does not re-ask', async () => {
      const { userId, auth } = await authFor('iap-refresh-debounce-1');
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_refresh_d1',
          userId,
          endsAt: Date.now() - 2 * DAY_MS,
        }),
      );
      await clearSyncClock('sub_refresh_d1');

      // First read refreshes, and Paddle answers `past_due` — a state that stays
      // refresh-worthy (dunning moves on the provider's schedule). So the second
      // read is blocked by the DEBOUNCE alone, not by the row looking healthy.
      mockPaddleSubscription({
        subscriptionId: 'sub_refresh_d1',
        userId,
        status: 'past_due',
        endsAt: Date.now() - 2 * DAY_MS,
      });
      const first = await getStatus(auth);
      expect(first.plan).toBe('plus'); // entitled through the dunning grace
      expect(first.status).toBe('grace');
      expect(first.willRenew).toBe(true); // dunning: collection retries are scheduled

      mockPaddleSubscription({ subscriptionId: 'sub_refresh_d1', userId });
      expect((await getStatus(auth)).status).toBe('grace');
      takeUnusedStub('/subscriptions/sub_refresh_d1');
    });

    it('still answers with the stored fold when the provider is unreachable', async () => {
      const { userId, auth } = await authFor('iap-refresh-down-1');
      const logs = captureConsole();
      const endsAt = Date.now() - 2 * DAY_MS;
      await postWebhook(subscriptionEvent({ subscriptionId: 'sub_refresh_x1', userId, endsAt }));
      await clearSyncClock('sub_refresh_x1');

      fetchStubs.push({ match: '/subscriptions/sub_refresh_x1', status: 500, body: {} });

      // A read must never fail because a payment provider is down.
      const status = await getStatus(auth);
      expect(status.plan).toBe('free');

      // …and the failed attempt still advanced the debounce clock, so a hot
      // client can't hammer a provider that's already struggling.
      mockPaddleSubscription({ subscriptionId: 'sub_refresh_x1', userId });
      await getStatus(auth);
      takeUnusedStub('/subscriptions/sub_refresh_x1');

      // Swallowed for the caller, but not silently: the row is now knowingly
      // stale, and only this line says so.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('refreshPurchase: paddle sub_refresh_x1 refresh failed'),
        expect.any(Error),
      );
    });

    it('refreshes a store row by its stored external id, with no notification', async () => {
      const { auth } = await authFor('iap-refresh-store-1');
      mockPlaySubscription({ expiryTime: Date.now() + 30 * DAY_MS });
      mockPlayAcknowledge();
      const verifyRes = await app.request(
        iapVerifyEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            source: 'playstore',
            productId: STORE_PRODUCT_IDS.plus,
            token: 'play-token-refresh-1',
          }),
        },
        env,
      );
      expect(verifyRes.status).toBe(200);

      // Push the row past its period without any notification arriving — the
      // account now reads free while Google still has it active.
      await env.DIRECTORY_DB.prepare(
        `UPDATE purchases SET expires_at = ?, last_synced_at = 0 WHERE external_id = ?`,
      )
        .bind(Date.now() - 2 * DAY_MS, 'play-token-refresh-1')
        .run();

      // The status read pulls the truth using the purchase token we ALREADY
      // store as external_id — it is Google's own lookup key, so re-reading
      // needs no notification and no extra column. (Acknowledged long ago, so
      // the refresh makes no acknowledge call either.)
      const renewedTo = Date.now() + 28 * DAY_MS;
      mockPlaySubscription({
        expiryTime: renewedTo,
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      });
      const status = await getStatus(auth);
      expect(status.plan).toBe('plus');
      expect(status.expiresAt).toBe(renewedTo);
    });
  });

  // The PRE-ROW hole the staleness refresh cannot reach: a FIRST purchase whose
  // subscription webhook never arrived leaves no purchase row to look stale, and
  // Paddle can't be asked about a userId. The persisted txn_… is the only key,
  // so these tests drive the whole recovery through the public surface —
  // POST /iap/checkout, then GET /iap/status with no webhook in between.
  describe('pending checkout reconciliation', () => {
    beforeAll(stubOutboundFetch);
    afterEach(assertNoPendingStubs);

    // Create a checkout the way the web client does, with Paddle's POST
    // /transactions scripted to mint `transactionId`.
    async function postCheckout(auth: Record<string, string>, transactionId: string) {
      fetchStubs.push({
        match: '/transactions',
        status: 200,
        body: { data: { id: transactionId } },
      });
      const res = await app.request(
        iapCheckoutEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ plan: 'plus' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ transactionId });
    }

    // Script Paddle's GET /transactions/{id} — the first hop. `subscriptionId`
    // omitted is the in-flight case (paid, not provisioned yet).
    function mockPaddleTransaction(o: {
      transactionId: string;
      subscriptionId?: string;
      status?: string;
    }) {
      fetchStubs.push({
        match: `/transactions/${o.transactionId}`,
        status: 200,
        body: {
          data: {
            id: o.transactionId,
            status: o.status ?? 'completed',
            subscription_id: o.subscriptionId ?? null,
          },
        },
      });
    }

    // Age a pending checkout: "created N ago, never attempted". The gate
    // deliberately ignores a brand-new row (the payment can't have landed yet),
    // so anything expecting a resolve has to clear that floor.
    async function ageCheckout(transactionId: string, ageMs = 5 * 60 * 1000) {
      await env.DIRECTORY_DB.prepare(
        `UPDATE paddle_checkouts SET created_at = ?, last_synced_at = 0 WHERE transaction_id = ?`,
      )
        .bind(Date.now() - ageMs, transactionId)
        .run();
    }

    async function isPending(transactionId: string): Promise<boolean> {
      const row = await env.DIRECTORY_DB.prepare(
        `SELECT COUNT(*) AS n FROM paddle_checkouts WHERE transaction_id = ?`,
      )
        .bind(transactionId)
        .first<{ n: number }>();
      return (row?.n ?? 0) > 0;
    }

    // The other half of the double-subscription guard. `already_subscribed`
    // can only see a subscription that EXISTS, so it is blind to two checkouts
    // created before either is paid — and two live txn_… is two payable
    // checkouts on one account.
    it('reuses a fresh pending checkout instead of minting a second payable one', async () => {
      const { auth } = await authFor('iap-checkout-reuse-1');
      await postCheckout(auth, 'txn_reuse_1');

      // No /transactions stub is scripted for this second call: reuse must
      // answer from the pending row without asking Paddle at all. (An unstubbed
      // outbound call falls through to the real fetch, which cannot mint
      // `txn_reuse_1`, so returning it is proof no second transaction exists.)
      const res = await app.request(
        iapCheckoutEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ plan: 'plus' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ transactionId: 'txn_reuse_1' });
    });

    it('mints a new checkout once the old one is past the reuse window', async () => {
      const { auth } = await authFor('iap-checkout-reuse-2');
      await postCheckout(auth, 'txn_reuse_old');
      // Past CHECKOUT_REUSE_MS: an abandoned checkout must not pin a stale
      // transaction to the account for the row's 3-day TTL. `last_synced_at` is
      // stamped NOW rather than zeroed (what ageCheckout does), so the row is
      // too old to reuse but still inside its resolve debounce — this test is
      // about the reuse window, not about reconciliation's Paddle round-trip.
      await env.DIRECTORY_DB.prepare(
        `UPDATE paddle_checkouts SET created_at = ?, last_synced_at = ? WHERE transaction_id = ?`,
      )
        .bind(Date.now() - 31 * 60 * 1000, Date.now(), 'txn_reuse_old')
        .run();

      await postCheckout(auth, 'txn_reuse_new');
    });

    it('recovers a first purchase whose webhook never arrived', async () => {
      const { userId, auth } = await authFor('iap-checkout-1');
      await postCheckout(auth, 'txn_recover_1');
      await ageCheckout('txn_recover_1');

      // No webhook is ever posted. Paddle's truth: the transaction completed and
      // grew a subscription — the hop the persisted txn_… exists to make.
      const endsAt = Date.now() + 30 * DAY_MS;
      mockPaddleTransaction({ transactionId: 'txn_recover_1', subscriptionId: 'sub_recover_1' });
      mockPaddleSubscription({ subscriptionId: 'sub_recover_1', userId, endsAt });

      const status = await getStatus(auth);
      expect(status.plan).toBe('plus');
      expect(status.status).toBe('active');
      expect(status.expiresAt).toBe(endsAt);

      // Resolved rows are deleted — the purchase row is the durable record from
      // here on, so a later read costs nothing extra.
      expect(await isPending('txn_recover_1')).toBe(false);
      mockPaddleTransaction({ transactionId: 'txn_recover_1', subscriptionId: 'sub_recover_1' });
      expect((await getStatus(auth)).plan).toBe('plus');
      takeUnusedStub('/transactions/txn_recover_1');
    });

    it('binds through the stored checkout when custom_data did not survive', async () => {
      const { auth } = await authFor('iap-checkout-unbound-1');
      await postCheckout(auth, 'txn_unbound_1');
      await ageCheckout('txn_unbound_1');

      // `userId: undefined` ⇒ custom_data null on the subscription. A webhook
      // carrying this would drop as 'unbound'; here the checkout row names the
      // account, because the server wrote it from the session.
      mockPaddleTransaction({ transactionId: 'txn_unbound_1', subscriptionId: 'sub_unbound_1' });
      mockPaddleSubscription({ subscriptionId: 'sub_unbound_1' });

      expect((await getStatus(auth)).plan).toBe('plus');
    });

    it('does not ask before a checkout could plausibly have completed', async () => {
      const { auth } = await authFor('iap-checkout-fresh-1');
      await postCheckout(auth, 'txn_fresh_1');
      // Deliberately NOT aged: at t≈0 the answer is a near-certain "not yet",
      // and spending the row's first attempt there would then debounce away the
      // window the user is actually watching.
      mockPaddleTransaction({ transactionId: 'txn_fresh_1', subscriptionId: 'sub_fresh_1' });

      expect((await getStatus(auth)).plan).toBe('free');
      takeUnusedStub('/transactions/txn_fresh_1');
    });

    it('waits out a transaction with no subscription yet, then debounces', async () => {
      const { auth } = await authFor('iap-checkout-inflight-1');
      await postCheckout(auth, 'txn_inflight_1');
      await ageCheckout('txn_inflight_1');

      // Billed but not provisioned: nothing to apply, and the row must survive.
      mockPaddleTransaction({ transactionId: 'txn_inflight_1' });
      expect((await getStatus(auth)).plan).toBe('free');
      expect(await isPending('txn_inflight_1')).toBe(true);

      // The attempt stamped the debounce clock, so an activation poll re-reading
      // every 2s can't turn into a Paddle call per poll.
      mockPaddleTransaction({ transactionId: 'txn_inflight_1', subscriptionId: 'sub_inflight_1' });
      expect((await getStatus(auth)).plan).toBe('free');
      takeUnusedStub('/transactions/txn_inflight_1');
    });

    it('drops the row when Paddle does not know the transaction', async () => {
      const { auth } = await authFor('iap-checkout-404-1');
      const logs = captureConsole();
      await postCheckout(auth, 'txn_gone_1');
      await ageCheckout('txn_gone_1');

      fetchStubs.push({ match: '/transactions/txn_gone_1', status: 404, body: {} });
      expect((await getStatus(auth)).plan).toBe('free');

      // Terminal: nothing will ever come of it, so it isn't left to age out.
      expect(await isPending('txn_gone_1')).toBe(false);
      // Dropping a row on the provider's say-so is logged as an error — a 404
      // for a transaction we minted means our side and Paddle's disagree.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('paddle does not know txn_gone_1'),
      );
    });

    it('keeps the row when Paddle is unreachable, and still answers', async () => {
      const { auth } = await authFor('iap-checkout-down-1');
      const logs = captureConsole();
      await postCheckout(auth, 'txn_down_1');
      await ageCheckout('txn_down_1');

      fetchStubs.push({ match: '/transactions/txn_down_1', status: 500, body: {} });
      expect((await getStatus(auth)).plan).toBe('free');
      // A provider outage is transient — the row survives to be retried, but the
      // failed attempt still advanced the clock.
      expect(await isPending('txn_down_1')).toBe(true);

      mockPaddleTransaction({ transactionId: 'txn_down_1', subscriptionId: 'sub_down_1' });
      expect((await getStatus(auth)).plan).toBe('free');
      takeUnusedStub('/transactions/txn_down_1');

      // An outage reads differently from the 404 above — "failed", not "does
      // not know" — which is what keeps the row alive for the next window.
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('resolveCheckout: txn_down_1 failed'),
        expect.any(Error),
      );
      expect(logs.error).not.toHaveBeenCalledWith(
        expect.stringContaining('does not know txn_down_1'),
      );
    });

    it('ignores pending checkouts once the account is entitled', async () => {
      const { userId, auth } = await authFor('iap-checkout-paid-1');
      await postCheckout(auth, 'txn_paid_1');
      await ageCheckout('txn_paid_1');

      // The webhook DID land for this one, by its own path.
      await postWebhook(
        subscriptionEvent({
          subscriptionId: 'sub_paid_1',
          userId,
          endsAt: Date.now() + 30 * DAY_MS,
        }),
      );

      mockPaddleTransaction({ transactionId: 'txn_paid_1', subscriptionId: 'sub_paid_1' });
      expect((await getStatus(auth)).plan).toBe('plus');
      // An entitled fold can't be hiding a lost first webhook, so the paid
      // majority never pays for this table.
      takeUnusedStub('/transactions/txn_paid_1');
    });

    it('retires the pending checkout when the created webhook lands', async () => {
      const { userId, auth } = await authFor('iap-checkout-retire-1');
      await postCheckout(auth, 'txn_retire_1');

      // The HAPPY path: `subscription.created` carries our txn_… back, so the
      // push side can retire the row itself. Nothing else would: an entitled
      // account short-circuits before the scan, and its next checkout — the
      // other deleteStale caller — is refused as already-subscribed.
      await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.created',
          subscriptionId: 'sub_retire_1',
          userId,
          transactionId: 'txn_retire_1',
        }),
      );

      expect(await isPending('txn_retire_1')).toBe(false);
      expect((await getStatus(auth)).plan).toBe('plus');
    });

    it('keeps the pending checkout when the created event could not be applied', async () => {
      const { userId, auth } = await authFor('iap-checkout-unapplied-1');
      const logs = captureConsole();
      await postCheckout(auth, 'txn_unapplied_1');

      // An unknown pri_… (the config-bug drop): we ACK, so Paddle never resends,
      // and no purchase row is written. Retiring the checkout here would discard
      // the only key left to recover the purchase with.
      const res = await postWebhook(
        subscriptionEvent({
          eventType: 'subscription.created',
          subscriptionId: 'sub_unapplied_1',
          userId,
          priceId: 'pri_not_configured',
          transactionId: 'txn_unapplied_1',
        }),
      );
      expect(res.status).toBe(200);
      expect(await isPending('txn_unapplied_1')).toBe(true);
      expect((await getStatus(auth)).plan).toBe('free');
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('no known price in [pri_not_configured] for sub_unapplied_1'),
      );
      logs.error.mockClear();

      // …and the row does its job on the next window, once Paddle is asked
      // about a subscription whose price the server does know.
      await ageCheckout('txn_unapplied_1');
      mockPaddleTransaction({
        transactionId: 'txn_unapplied_1',
        subscriptionId: 'sub_unapplied_1',
      });
      mockPaddleSubscription({ subscriptionId: 'sub_unapplied_1', userId });
      expect((await getStatus(auth)).plan).toBe('plus');
      // Recovery is clean — no second drop, and nothing on the error channel.
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('drops a checkout left unbilled long enough to read as abandoned', async () => {
      const { auth } = await authFor('iap-checkout-abandoned-1');
      await postCheckout(auth, 'txn_abandoned_1');
      await ageCheckout('txn_abandoned_1', 18 * 60 * 60 * 1000);

      // `ready` means no payment was ever ATTEMPTED, so this cannot be the case
      // the table exists for (paid, subscription never seen) — it's a closed
      // overlay. Dropped rather than left to bill the account's every status
      // read with a Paddle round-trip for the rest of the TTL.
      mockPaddleTransaction({ transactionId: 'txn_abandoned_1', status: 'ready' });
      expect((await getStatus(auth)).plan).toBe('free');
      expect(await isPending('txn_abandoned_1')).toBe(false);
    });

    it('keeps a young unbilled checkout — the user may still be paying', async () => {
      const { auth } = await authFor('iap-checkout-paying-1');
      await postCheckout(auth, 'txn_paying_1');
      await ageCheckout('txn_paying_1');

      // Same `ready` status, minutes old instead of half a day: the overlay is
      // plausibly still open, and the abandonment rule must not race a payment
      // that hasn't been submitted yet.
      mockPaddleTransaction({ transactionId: 'txn_paying_1', status: 'ready' });
      expect((await getStatus(auth)).plan).toBe('free');
      expect(await isPending('txn_paying_1')).toBe(true);
    });
  });
});
