import { Platform } from 'react-native';
import {
  deepLinkToSubscriptions,
  ErrorCode,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  type ProductSubscription,
  type Purchase,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap';

import {
  AVAILABLE_PAID_PLANS,
  type AvailablePaidPlan,
  iapVerifyEndpoint,
  type PaidPlan,
  planOfStoreProduct,
  STORE_PRODUCT_IDS,
  type SubscriptionStatus,
} from '@stxapps/shared';

import { apiClient } from './api-client';

// App-level store-IAP wrapper — the sibling of bracemark-web's `lib/paddle.ts`
// (bracemark-expo is the ONLY store-checkout surface, so this lives in the app, not
// a package). It wraps expo-iap with:
//  - a lazy singleton: the store connection opens only when the subscription
//    section actually needs it, never on app boot;
//  - the purchase lifecycle callbacks the subscription UI cares about, routed
//    from expo-iap's global purchase listeners (registered once at
//    connection) to the currently-open checkout's handlers.
//
// The flow inverts Paddle's direction on purpose (docs/iap.md — bracemark-expo):
// a store purchase is a CLIENT-side event the server only learns about from
// the receipt this app submits, so after the store sheet completes we POST
// `iap/verify` with the store's proof (App Store transaction id / Play
// purchase token). bracemark-api fetches the authoritative state from the store's
// API, records the purchase bound to the session's account, and returns the
// fresh fold — so unlike the web's post-checkout webhook wait, there is no
// status polling here: the verify RESPONSE is the flipped plan. Only after the
// server has recorded it do we `finishTransaction` — an unfinished transaction
// replays on the next connection (both stores), which is exactly the retry we
// want if verify failed mid-flight.

// Which purchases this build can make/see. Platform.OS is the right
// discriminator (not the purchase's `store` field) — it's what decides which
// store sheet requestPurchase opens.
export const STORE_SOURCE: 'appstore' | 'playstore' =
  Platform.OS === 'ios' ? 'appstore' : 'playstore';

// Must match app.config.ts's `android.package` — deepLinkToSubscriptions needs
// it to open Play's manage-subscription screen on our app.
const ANDROID_PACKAGE_NAME = 'com.bracemark.app';

let connectPromise: Promise<void> | null = null;

// The open checkout's handlers. expo-iap's purchase listeners are global
// (bound once at connection), so the per-open callbacks are held here; only one
// store sheet can be open at a time.
let onCompleted: ((status: SubscriptionStatus) => void) | null = null;
let onFailed: ((message: string) => void) | null = null;
let onClosed: (() => void) | null = null;

// Read the handlers AND drop them — a checkout settles exactly once (completed,
// failed, or canceled), so holding them past that would let a REPLAYED
// transaction (which arrives with no checkout open) fire the previous
// checkout's callbacks into a section that has since unmounted. React no-ops
// those setStates, so this is tidiness rather than a live bug — but it's what
// makes the replay path actually silent, the way ensureConnection describes it.
function takeHandlers() {
  const handlers = { onCompleted, onFailed, onClosed };
  onCompleted = null;
  onFailed = null;
  onClosed = null;
  return handlers;
}

// Send the store's proof of purchase to bracemark-api, then — only once the server
// has recorded it — finish the transaction with the store. Returns the fresh
// fold from `iap/verify`. On verify failure the transaction is deliberately
// LEFT UNFINISHED so the store replays it on the next connection (the retry
// path); the caller surfaces the error.
async function verifyAndFinish(purchase: Purchase): Promise<SubscriptionStatus> {
  // The server's lookup key: App Store subscriptions are looked up by
  // transaction id on the App Store Server API; Play by the purchase token.
  const token =
    STORE_SOURCE === 'appstore'
      ? ((purchase as { originalTransactionIdentifierIOS?: string | null })
          .originalTransactionIdentifierIOS ?? purchase.id)
      : purchase.purchaseToken;
  if (!token) throw new Error('The store returned no purchase token');

  const status = await apiClient.call(iapVerifyEndpoint, {
    source: STORE_SOURCE,
    productId: purchase.productId,
    token,
  });
  await finishTransaction({ purchase, isConsumable: false });
  return status;
}

// Open the store connection and bind the global listeners, once. The updated
// listener also catches REPLAYED transactions (a purchase whose verify never
// landed — killed app, offline) with no checkout open: those verify + finish
// silently, and the section's next `iap/status` read shows the recovered plan.
function ensureConnection(): Promise<void> {
  if (!connectPromise) {
    connectPromise = (async () => {
      await initConnection();

      purchaseUpdatedListener((purchase) => {
        // Android can deliver pending (not yet charged) states — not a
        // completed purchase; the listener fires again once it's `purchased`.
        if (purchase.purchaseState !== 'purchased') return;
        void verifyAndFinish(purchase)
          .then((status) => takeHandlers().onCompleted?.(status))
          .catch((e) => {
            takeHandlers().onFailed?.(e instanceof Error ? e.message : String(e));
          });
      });

      purchaseErrorListener((error) => {
        // The user backing out of the store sheet is a close, not a failure —
        // mirror Paddle's `closed` semantics.
        const handlers = takeHandlers();
        if (error.code === ErrorCode.UserCancelled) handlers.onClosed?.();
        else handlers.onFailed?.(error.message);
      });
    })().catch((e) => {
      connectPromise = null; // a failed connection may be retried
      throw e;
    });
  }
  return connectPromise;
}

// The plans on sale, as store products — for the upgrade cards' localized
// prices (`displayPrice` is the store's tax/locale-correct price sheet value,
// authoritative over the USD planning numbers). A plan whose product the store
// doesn't return (misconfigured catalog) is simply absent.
export async function fetchStorePlanProducts(): Promise<
  Partial<Record<AvailablePaidPlan, ProductSubscription>>
> {
  await ensureConnection();
  const skus = AVAILABLE_PAID_PLANS.map((plan) => STORE_PRODUCT_IDS[plan]);
  const products = (await fetchProducts({ skus, type: 'subs' })) ?? [];

  const byPlan: Partial<Record<AvailablePaidPlan, ProductSubscription>> = {};
  for (const product of products as ProductSubscription[]) {
    const plan = planOfStoreProduct(product.id);
    if (plan && (AVAILABLE_PAID_PLANS as readonly string[]).includes(plan)) {
      byPlan[plan as AvailablePaidPlan] = product;
    }
  }
  return byPlan;
}

// Open the store's purchase sheet for a plan. `onCompleted` fires after the
// purchase is VERIFIED AND RECORDED server-side, with the fresh fold;
// `onFailed` on a store error or a failed verify; `onClosed` when the user
// backs out (clear busy state, nothing happened).
export async function openStoreCheckout(options: {
  plan: AvailablePaidPlan;
  // The fetched product (fetchStorePlanProducts) — Android's purchase flow
  // needs the product's offer token, so the cards fetch before checkout.
  product: ProductSubscription;
  onCompleted: (status: SubscriptionStatus) => void;
  onFailed: (message: string) => void;
  onClosed: () => void;
}): Promise<void> {
  await ensureConnection();

  onCompleted = options.onCompleted;
  onFailed = options.onFailed;
  onClosed = options.onClosed;

  const sku = STORE_PRODUCT_IDS[options.plan];
  // Play requires the base-plan/offer token from the fetched product; the
  // first offer is the base yearly plan (we configure no promotional offers).
  // `subscriptionOffers` is the cross-platform standard shape — its Android-only
  // predecessor `subscriptionOfferDetailsAndroid` is deprecated upstream.
  const offerToken =
    options.product.platform === 'android'
      ? options.product.subscriptionOffers?.[0]?.offerTokenAndroid
      : undefined;

  await requestPurchase({
    request: {
      apple: { sku },
      google: {
        skus: [sku],
        ...(offerToken ? { subscriptionOffers: [{ sku, offerToken }] } : {}),
      },
    },
    type: 'subs',
  });
}

// Re-drive verify for purchases the store already holds — the "Restore
// purchases" path (App Review requires one for auto-renewable subscriptions;
// it's also the reinstall / new-device / new-account recovery). Returns the
// fold after the last successful verify, or null when the store held nothing
// of ours. A purchase bound to ANOTHER Bracemark account surfaces as the server's
// 409 (`purchase_bound`) — thrown for the section to show, but only if nothing
// else restored (see the loop).
export async function restoreStorePurchases(): Promise<SubscriptionStatus | null> {
  await ensureConnection();
  const purchases = await getAvailablePurchases();

  let last: SubscriptionStatus | null = null;
  let firstError: unknown = null;
  for (const purchase of purchases) {
    if (planOfStoreProduct(purchase.productId) === null) continue;
    try {
      last = await verifyAndFinish(purchase);
    } catch (e) {
      // One purchase failing must NOT abandon the rest. A store account can hold
      // several of ours (an old lapsed one, one bound to the user's other Bracemark
      // account → 409 `purchase_bound`), and the very next one may be the live
      // subscription this restore exists to recover. Each is independent — its
      // transaction is left unfinished for the usual replay retry.
      firstError ??= e;
    }
  }
  // Surface a failure only when NOTHING restored: if some purchase did verify,
  // that fold is the answer the user asked for, and an unrelated 409 alongside
  // it is noise.
  if (last === null && firstError !== null) throw firstError;
  return last;
}

// Open the platform's own manage-subscription surface (payment method, plan
// changes, cancel all live in the store, never in the app — docs/iap.md).
export async function openStoreSubscriptionManagement(plan: PaidPlan): Promise<void> {
  await deepLinkToSubscriptions({
    skuAndroid: STORE_PRODUCT_IDS[plan],
    packageNameAndroid: ANDROID_PACKAGE_NAME,
  });
}
