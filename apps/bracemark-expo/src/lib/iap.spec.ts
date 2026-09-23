import {
  AVAILABLE_PAID_PLANS,
  PLAY_FREE_TRIAL_OFFER_TAG,
  STORE_PRODUCT_IDS,
  type SubscriptionStatus,
} from '@stxapps/shared';

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
  ErrorCode: { UserCancelled: 'user-cancelled' },
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

  expect(onFailed).toHaveBeenCalledWith('offline');
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
  purchaseFailed?.({ code: 'store-unavailable', message: 'Store unavailable' });

  expect(onFailed).toHaveBeenCalledWith('Store unavailable');
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

  await expect(iap.restoreStorePurchases()).rejects.toThrow('purchase belongs to another account');
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
