import {
  ApiError,
  AVAILABLE_PAID_PLANS,
  PLAY_FREE_TRIAL_OFFER_TAG,
  STORE_PRODUCT_IDS,
  type SubscriptionStatus,
} from '@stxapps/shared';

import { PurchaseNotRecordedError, storeFailureMessage } from './iap';

const mockInitConnection = jest.fn<Promise<void>, []>();
const mockFetchProducts = jest.fn();
const mockFinishTransaction = jest.fn<Promise<void>, [unknown]>();
const mockGetAvailablePurchases = jest.fn();
const mockRequestPurchase = jest.fn<Promise<void>, [unknown]>();
const mockDeepLinkToSubscriptions = jest.fn<Promise<void>, [unknown]>();
const mockApiCall = jest.fn();

let purchaseUpdated: ((purchase: Record<string, unknown>) => void) | undefined;
let purchaseFailed: ((error: { code: string; message: string }) => void) | undefined;

jest.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    ConnectionClosed: 'connection-closed',
    DeferredPayment: 'deferred-payment',
    NetworkError: 'network-error',
    Pending: 'pending',
    ServiceDisconnected: 'service-disconnected',
    ServiceTimeout: 'service-timeout',
    UserCancelled: 'user-cancelled',
  },
  initConnection: () => mockInitConnection(),
  fetchProducts: (options: unknown) => mockFetchProducts(options),
  finishTransaction: (options: unknown) => mockFinishTransaction(options),
  getAvailablePurchases: () => mockGetAvailablePurchases(),
  requestPurchase: (options: unknown) => mockRequestPurchase(options),
  deepLinkToSubscriptions: (options: unknown) => mockDeepLinkToSubscriptions(options),
  purchaseUpdatedListener: (listener: typeof purchaseUpdated) => {
    purchaseUpdated = listener;
    return { remove: jest.fn() };
  },
  purchaseErrorListener: (listener: typeof purchaseFailed) => {
    purchaseFailed = listener;
    return { remove: jest.fn() };
  },
}));

jest.mock('./api-client', () => ({
  apiClient: { call: (...args: unknown[]) => mockApiCall(...args) },
}));

const PAID: SubscriptionStatus = {
  plan: 'plus',
  status: 'active',
  source: 'appstore',
  expiresAt: Date.UTC(2027, 0, 1),
  willRenew: true,
};

function load(): typeof import('./iap') {
  let mod!: typeof import('./iap');
  jest.isolateModules(() => {
    mod = require('./iap') as typeof import('./iap');
  });
  return mod;
}

function purchase(
  id: string,
  productId = STORE_PRODUCT_IDS.plus,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    productId,
    purchaseState: 'purchased',
    purchaseToken: `play-${id}`,
    originalTransactionIdentifierIOS: `apple-${id}`,
    ...extra,
  };
}

beforeEach(() => {
  purchaseUpdated = undefined;
  purchaseFailed = undefined;
  jest.clearAllMocks();
  mockInitConnection.mockResolvedValue();
  mockFetchProducts.mockResolvedValue([]);
  mockFinishTransaction.mockResolvedValue();
  mockGetAvailablePurchases.mockResolvedValue([]);
  mockRequestPurchase.mockResolvedValue();
  mockDeepLinkToSubscriptions.mockResolvedValue();
  mockApiCall.mockResolvedValue(PAID);
});

test('opens one lazy connection and returns only products that are currently on sale', async () => {
  const iap = load();
  const plus = { id: STORE_PRODUCT_IDS.plus, platform: 'ios', displayPrice: '$48.00' };
  const pro = { id: STORE_PRODUCT_IDS.pro, platform: 'ios', displayPrice: '$96.00' };
  const foreign = { id: 'somebody.else.yearly', platform: 'ios', displayPrice: '$1.00' };
  mockFetchProducts.mockResolvedValue([foreign, pro, plus]);

  expect(mockInitConnection).not.toHaveBeenCalled();

  const [first, second] = await Promise.all([
    iap.fetchStorePlanProducts(),
    iap.fetchStorePlanProducts(),
  ]);

  expect(mockInitConnection).toHaveBeenCalledTimes(1);
  expect(mockFetchProducts).toHaveBeenCalledTimes(2);
  expect(mockFetchProducts).toHaveBeenCalledWith({
    skus: AVAILABLE_PAID_PLANS.map((plan) => STORE_PRODUCT_IDS[plan]),
    type: 'subs',
  });
  expect(first).toEqual({ plus });
  expect(second).toEqual({ plus });
});

test('allows a failed store connection to be retried', async () => {
  mockInitConnection.mockRejectedValueOnce(new Error('store unavailable'));
  const iap = load();

  await expect(iap.fetchStorePlanProducts()).rejects.toThrow('store unavailable');
  await expect(iap.fetchStorePlanProducts()).resolves.toEqual({});

  expect(mockInitConnection).toHaveBeenCalledTimes(2);
});

test('opens checkout with the selected SKU and the Play offer token', async () => {
  const iap = load();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: {
      id: STORE_PRODUCT_IDS.plus,
      platform: 'android',
      subscriptionOffers: [{ offerTokenAndroid: 'base-plan-token' }],
    } as never,
    onCompleted: jest.fn(),
    onFailed: jest.fn(),
    onClosed: jest.fn(),
  });

  expect(mockRequestPurchase).toHaveBeenCalledWith({
    request: {
      apple: { sku: STORE_PRODUCT_IDS.plus },
      google: {
        skus: [STORE_PRODUCT_IDS.plus],
        subscriptionOffers: [{ sku: STORE_PRODUCT_IDS.plus, offerToken: 'base-plan-token' }],
      },
    },
    type: 'subs',
  });
});

test('opens checkout with the Play free-trial offer when it is listed after the base plan', async () => {
  const iap = load();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: {
      id: STORE_PRODUCT_IDS.plus,
      platform: 'android',
      subscriptionOffers: [
        { offerTokenAndroid: 'base-plan-token', offerTagsAndroid: [] },
        { offerTokenAndroid: 'trial-token', offerTagsAndroid: [PLAY_FREE_TRIAL_OFFER_TAG] },
      ],
    } as never,
    onCompleted: jest.fn(),
    onFailed: jest.fn(),
    onClosed: jest.fn(),
  });

  expect(mockRequestPurchase).toHaveBeenCalledWith({
    request: {
      apple: { sku: STORE_PRODUCT_IDS.plus },
      google: {
        skus: [STORE_PRODUCT_IDS.plus],
        subscriptionOffers: [{ sku: STORE_PRODUCT_IDS.plus, offerToken: 'trial-token' }],
      },
    },
    type: 'subs',
  });
});

test('verifies a completed purchase before finishing it and notifying checkout', async () => {
  const iap = load();
  const events: string[] = [];
  mockApiCall.mockImplementation(async () => {
    events.push('verify');
    return PAID;
  });
  mockFinishTransaction.mockImplementation(async () => {
    events.push('finish');
  });
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onCompleted = jest.fn(() => {
    events.push('complete');
    settle();
  });

  await iap.openStoreCheckout({
    plan: 'plus',
    product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
    onCompleted,
    onFailed: jest.fn(),
    onClosed: jest.fn(),
  });
  purchaseUpdated?.(purchase('tx-1'));
  await completed;

  const token = iap.STORE_SOURCE === 'appstore' ? 'apple-tx-1' : 'play-tx-1';
  expect(mockApiCall).toHaveBeenCalledWith(expect.anything(), {
    source: iap.STORE_SOURCE,
    productId: STORE_PRODUCT_IDS.plus,
    token,
  });
  expect(mockFinishTransaction).toHaveBeenCalledWith({
    purchase: purchase('tx-1'),
    isConsumable: false,
  });
  expect(onCompleted).toHaveBeenCalledWith(PAID);
  expect(events).toEqual(['verify', 'finish', 'complete']);
});

test('leaves a failed verification unfinished so the store can replay it', async () => {
  const iap = load();
  mockApiCall.mockRejectedValue(new Error('offline'));
  let settle!: () => void;
  const failed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onFailed = jest.fn(() => settle());
  const onCompleted = jest.fn();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
    onCompleted,
    onFailed,
    onClosed: jest.fn(),
  });
  purchaseUpdated?.(purchase('tx-2'));
  await failed;

  // Tagged as the one failure where the store may already have charged — the
  // sentence it earns must not be "try again".
  expect(onFailed).toHaveBeenCalledWith(expect.any(iap.PurchaseNotRecordedError));
  expect(onCompleted).not.toHaveBeenCalled();
  expect(mockFinishTransaction).not.toHaveBeenCalled();
});

test('ignores a pending Play purchase until the store reports it purchased', async () => {
  const iap = load();
  const onCompleted = jest.fn();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: { id: STORE_PRODUCT_IDS.plus, platform: 'android' } as never,
    onCompleted,
    onFailed: jest.fn(),
    onClosed: jest.fn(),
  });
  purchaseUpdated?.(purchase('tx-3', STORE_PRODUCT_IDS.plus, { purchaseState: 'pending' }));

  expect(mockApiCall).not.toHaveBeenCalled();
  expect(mockFinishTransaction).not.toHaveBeenCalled();
  expect(onCompleted).not.toHaveBeenCalled();
});

test('treats cancellation as a close and other store errors as failures', async () => {
  const iap = load();
  const onClosed = jest.fn();
  const onFailed = jest.fn();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
    onCompleted: jest.fn(),
    onFailed,
    onClosed,
  });
  purchaseFailed?.({ code: 'user-cancelled', message: 'cancelled' });

  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();

  await iap.openStoreCheckout({
    plan: 'plus',
    product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
    onCompleted: jest.fn(),
    onFailed,
    onClosed,
  });
  const unavailable = { code: 'store-unavailable', message: 'Store unavailable' };
  purchaseFailed?.(unavailable);

  // The error itself, for storeFailureMessage — not its message, for display.
  expect(onFailed).toHaveBeenCalledWith(unavailable);
  expect(onClosed).toHaveBeenCalledTimes(1);
});

// expo-iap 4.x rejects requestPurchase with the sheet's error AND emits it to
// the listener. Treating only the listener as the signal let the rejection reach
// the section's catch, which printed a backed-out sheet as an error — seen on
// the iOS simulator by IAP-NATIVE-001, invisible here while the mock resolved.
test('settles a rejected sheet once: a cancel is a close, anything else is thrown', async () => {
  const iap = load();
  const onClosed = jest.fn();
  const onFailed = jest.fn();
  const cancelled = Object.assign(new Error('User cancelled the purchase flow'), {
    code: 'user-cancelled',
  });
  mockRequestPurchase.mockRejectedValueOnce(cancelled);

  await expect(
    iap.openStoreCheckout({
      plan: 'plus',
      product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
      onCompleted: jest.fn(),
      onFailed,
      onClosed,
    }),
  ).resolves.toBeUndefined();
  purchaseFailed?.({ code: 'user-cancelled', message: 'cancelled' });

  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();

  const unavailable = Object.assign(new Error('Store unavailable'), { code: 'service-error' });
  mockRequestPurchase.mockRejectedValueOnce(unavailable);

  await expect(
    iap.openStoreCheckout({
      plan: 'plus',
      product: { id: STORE_PRODUCT_IDS.plus, platform: 'ios' } as never,
      onCompleted: jest.fn(),
      onFailed,
      onClosed,
    }),
  ).rejects.toBe(unavailable);
  purchaseFailed?.({ code: 'service-error', message: 'Store unavailable' });

  expect(onFailed).not.toHaveBeenCalled();
  expect(onClosed).toHaveBeenCalledTimes(1);
});

test('silently verifies a replayed transaction when no checkout is open', async () => {
  const iap = load();
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  mockFinishTransaction.mockImplementation(async () => settle());
  await iap.fetchStorePlanProducts();

  purchaseUpdated?.(purchase('replayed'));
  await finished;

  expect(mockApiCall).toHaveBeenCalledTimes(1);
  expect(mockFinishTransaction).toHaveBeenCalledTimes(1);
});

test('restore skips foreign purchases and continues after one of ours fails', async () => {
  const iap = load();
  const failed = purchase('old-plus');
  const restored = purchase('current-pro', STORE_PRODUCT_IDS.pro);
  mockGetAvailablePurchases.mockResolvedValue([
    purchase('foreign', 'somebody.else.yearly'),
    failed,
    restored,
  ]);
  const proStatus: SubscriptionStatus = { ...PAID, plan: 'pro' };
  mockApiCall
    .mockRejectedValueOnce(new Error('bound to another account'))
    .mockResolvedValueOnce(proStatus);

  await expect(iap.restoreStorePurchases()).resolves.toEqual(proStatus);

  expect(mockApiCall).toHaveBeenCalledTimes(2);
  expect(mockFinishTransaction).toHaveBeenCalledTimes(1);
  expect(mockFinishTransaction).toHaveBeenCalledWith({
    purchase: restored,
    isConsumable: false,
  });
});

test('restore surfaces an error only when none of our purchases can be restored', async () => {
  const iap = load();
  mockGetAvailablePurchases.mockResolvedValue([purchase('broken')]);
  mockApiCall.mockRejectedValue(new Error('purchase belongs to another account'));

  // Wrapped, with the server's refusal kept as the reason — the message is for
  // storeFailureMessage to choose, not for this to carry.
  await expect(iap.restoreStorePurchases()).rejects.toMatchObject({
    name: 'PurchaseNotRecordedError',
    reason: expect.objectContaining({ message: 'purchase belongs to another account' }),
  });
  expect(mockFinishTransaction).not.toHaveBeenCalled();
});

test('restore returns null when the store holds no Bracemark purchase', async () => {
  const iap = load();
  mockGetAvailablePurchases.mockResolvedValue([purchase('foreign', 'somebody.else.yearly')]);

  await expect(iap.restoreStorePurchases()).resolves.toBeNull();

  expect(mockApiCall).not.toHaveBeenCalled();
  expect(mockFinishTransaction).not.toHaveBeenCalled();
});

test('opens the platform subscription manager for the selected plan', async () => {
  const iap = load();

  await iap.openStoreSubscriptionManagement('plus');

  expect(mockDeepLinkToSubscriptions).toHaveBeenCalledWith({
    skuAndroid: STORE_PRODUCT_IDS.plus,
    packageNameAndroid: 'com.bracemark.app',
  });
});

// What the store library and ApiError attach to a failure was never written for
// a customer. Found on a real device: Play's "always declines" test card arrived
// as BillingUnavailable, and the section printed the library's canned string for
// that code — "Billing API version is not supported for the type requested" —
// under the upgrade card.
describe('storeFailureMessage', () => {
  const LIBRARY_STRING = 'Billing API version is not supported for the type requested';
  const coded = (code: string) => ({ code, message: LIBRARY_STRING });
  // The server's refusal, as the api client throws it. Read through the file's
  // STATIC import of `./iap`, not `load()`: an isolated copy brings its own
  // @stxapps/shared, so an ApiError built here would fail its `instanceof` and
  // read as no verdict at all. These two exports hold no state, so nothing
  // needs isolating — and `require`-ing the package to match registries is the
  // dynamic import docs/testing.md's tripwire forbids.
  const bound = new PurchaseNotRecordedError(new ApiError(409, '{"error":"purchase_bound"}'));

  test('never returns the thrown message, whatever the action or the failure', () => {
    const failures = [
      coded('billing-unavailable'),
      coded('already-owned'),
      coded('network-error'),
      coded('a-code-added-next-year'),
      new Error(LIBRARY_STRING),
      bound,
      new PurchaseNotRecordedError(new Error(LIBRARY_STRING)),
      LIBRARY_STRING,
      null,
    ];
    for (const action of ['purchase', 'restore', 'manage'] as const) {
      for (const failure of failures) {
        const sentence = storeFailureMessage(action, failure);
        expect(sentence).not.toContain(LIBRARY_STRING);
        expect(sentence).not.toContain('Request failed');
        // The fixed shape: a full sentence that ends on one.
        expect(sentence).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  test('sends a declined payment to the payment method, not to a retry of nothing', () => {
    expect(storeFailureMessage('purchase', coded('billing-unavailable'))).toMatch(
      /Check your payment method/,
    );
  });

  test('does not tell a charged customer to buy again when verify fails', () => {
    const sentence = storeFailureMessage(
      'purchase',
      new PurchaseNotRecordedError(new Error('offline')),
    );
    // The transaction is unfinished and the store replays it; Restore re-drives
    // the same verify. "Please try again" here would be a second purchase.
    expect(sentence).toMatch(/Restore purchases/);
    expect(sentence).not.toMatch(/Please try again/);
  });

  test('names the other account for a purchase bound elsewhere, on purchase and on restore', () => {
    for (const action of ['purchase', 'restore'] as const) {
      expect(storeFailureMessage(action, bound)).toMatch(/another Bracemark account/);
    }
  });

  test('does not ask for a second purchase while one is waiting for approval', () => {
    for (const code of ['deferred-payment', 'pending']) {
      const sentence = storeFailureMessage('purchase', coded(code));
      expect(sentence).toMatch(/waiting for approval/);
      expect(sentence).not.toMatch(/try again/);
    }
  });

  test('falls back to the action’s own verb for a code it has no sentence for', () => {
    const unknown = coded('a-code-added-next-year');
    const sentences = (['purchase', 'restore', 'manage'] as const).map((action) =>
      storeFailureMessage(action, unknown),
    );
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) expect(sentence).toMatch(/^Could not .* Please try again\.$/);
  });
});
