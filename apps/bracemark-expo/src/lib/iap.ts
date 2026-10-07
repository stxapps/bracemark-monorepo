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
  apiErrorCode,
  AVAILABLE_PAID_PLANS,
  type AvailablePaidPlan,
  iapVerifyEndpoint,
  type PaidPlan,
  planOfStoreProduct,
  PLAY_FREE_TRIAL_OFFER_TAG,
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
let onFailed: ((error: unknown) => void) | null = null;
let onClosed: (() => void) | null = null;

// The store took the purchase and bracemark-api did not record it — `iap/verify`
// threw. Its own class because this is the one failure where money may already
// have moved: the transaction is left unfinished and the store replays it, so
// the user is owed "it went through, restore it", never "try again" (a second
// purchase). `reason` is what verify threw, kept for the server's verdict.
export class PurchaseNotRecordedError extends Error {
  constructor(public readonly reason: unknown) {
    super('The store purchase was not recorded');
    this.name = 'PurchaseNotRecordedError';
  }
}

const STORE_NAME = STORE_SOURCE === 'appstore' ? 'App Store' : 'Play Store';

// The store could not be reached at all — the one family where "check your
// connection" is the act.
const STORE_UNREACHABLE: ReadonlySet<string> = new Set([
  ErrorCode.NetworkError,
  ErrorCode.ServiceDisconnected,
  ErrorCode.ServiceTimeout,
  ErrorCode.ConnectionClosed,
]);

const FAILURE_FALLBACK = {
  purchase: 'Could not complete the purchase. Please try again.',
  restore: 'Could not restore your purchases. Please try again.',
  manage: `Could not open the ${STORE_NAME}’s subscription settings. Please try again.`,
} as const;

// The sentence a failed store action puts on screen — chosen by the failure's
// CODE, never its message. Nothing thrown on this path was written for a
// customer: the store library attaches a canned string to each code (a declined
// card arrives as BillingUnavailable, "Billing API version is not supported for
// the type requested", which the section used to print under the card), and a
// failed verify is ApiError's "Request failed with status 409". The shape is
// docs/brand-assets.md's, _errors have a fixed shape_: name the act where there
// is one, otherwise "Could not ⟨verb⟩. Please try again."
export function storeFailureMessage(action: keyof typeof FAILURE_FALLBACK, e: unknown): string {
  if (e instanceof PurchaseNotRecordedError) {
    const verdict = apiErrorCode(e.reason);
    // One ACCOUNT per store subscription, for life (docs/iap.md, step 2).
    if (verdict === 'purchase_bound') {
      return 'This purchase belongs to another Bracemark account. Sign in to that account to use it.';
    }
    // `invalid_receipt` is the store disowning the token, so nothing was
    // bought; anything else (offline, a 5xx) left a real purchase unrecorded.
    if (action === 'purchase' && verdict !== 'invalid_receipt') {
      return 'Your purchase went through, but we could not record it. Tap Restore purchases to try again.';
    }
    return FAILURE_FALLBACK[action];
  }

  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && STORE_UNREACHABLE.has(code)) {
    return `Could not reach the ${STORE_NAME}. Check your connection and try again.`;
  }
  if (action === 'purchase') {
    switch (code) {
      // Play's BILLING_UNAVAILABLE: a payment method it could not charge, but
      // also an out-of-date Play Store or an unsupported country — so the
      // sentence names the act without asserting the cause.
      case ErrorCode.BillingUnavailable:
        return `The ${STORE_NAME} could not complete this purchase. Check your payment method there and try again.`;
      // The store account already holds the subscription — bought under it
      // before, or a purchase whose verify never landed. Restore re-drives it.
      case ErrorCode.AlreadyOwned:
        return `This ${STORE_NAME} account already has a Bracemark subscription. Tap Restore purchases to use it here.`;
      // Ask to Buy, or a payment the store has not settled yet. Not a failure:
      // the purchase arrives through the replay path once it clears, so "try
      // again" would be asking for a second one.
      case ErrorCode.DeferredPayment:
      case ErrorCode.Pending:
        return 'This purchase is waiting for approval. Your plan changes here once it is approved.';
    }
  }
  return FAILURE_FALLBACK[action];
}

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

  let status: SubscriptionStatus;
  try {
    status = await apiClient.call(iapVerifyEndpoint, {
      source: STORE_SOURCE,
      productId: purchase.productId,
      token,
    });
  } catch (e) {
    throw new PurchaseNotRecordedError(e);
  }
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
          .catch((e) => takeHandlers().onFailed?.(e));
      });

      purchaseErrorListener((error) => {
        // The user backing out of the store sheet is a close, not a failure —
        // mirror Paddle's `closed` semantics.
        const handlers = takeHandlers();
        if (error.code === ErrorCode.UserCancelled) handlers.onClosed?.();
        else handlers.onFailed?.(error);
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
// `onFailed` on a store error or a failed verify, with the error itself — for
// `storeFailureMessage`, never for display; `onClosed` when the user backs out
// (clear busy state, nothing happened).
export async function openStoreCheckout(options: {
  plan: AvailablePaidPlan;
  // The fetched product (fetchStorePlanProducts) — Android's purchase flow
  // needs the product's offer token, so the cards fetch before checkout.
  product: ProductSubscription;
  onCompleted: (status: SubscriptionStatus) => void;
  onFailed: (error: unknown) => void;
  onClosed: () => void;
}): Promise<void> {
  await ensureConnection();

  onCompleted = options.onCompleted;
  onFailed = options.onFailed;
  onClosed = options.onClosed;

  const sku = STORE_PRODUCT_IDS[options.plan];
  // Play requires the base-plan/offer token from the fetched product. Play
  // lists the base plan AND every offer the buyer is eligible for, in no
  // promised order, so buy the free-trial offer by its tag when it's listed —
  // otherwise the trial the pricing copy promises depends on list order — and
  // fall back to the first entry (the base plan; the trial is the only offer
  // we configure). `subscriptionOffers` is the cross-platform standard shape —
  // its Android-only predecessor `subscriptionOfferDetailsAndroid` is
  // deprecated upstream.
  const offers =
    options.product.platform === 'android' ? (options.product.subscriptionOffers ?? []) : [];
  const offer =
    offers.find((o) => o.offerTagsAndroid?.includes(PLAY_FREE_TRIAL_OFFER_TAG)) ?? offers[0];
  const offerToken = offer?.offerTokenAndroid;

  // The sheet's outcome arrives TWICE when it is not a purchase: expo-iap 4.x
  // rejects this call with the store's error as well as emitting it to the
  // error listener. So a backed-out sheet has to be recognized here too, or it
  // reaches the section's catch and prints "User cancelled the purchase flow" as
  // an error under the card. Taking the handlers settles the checkout once,
  // whichever of the two lands first. Found by IAP-NATIVE-001 on the iOS
  // simulator (docs/e2e.md, _subscriptions_); the jest mock resolved.
  try {
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
  } catch (e) {
    const handlers = takeHandlers();
    if ((e as { code?: unknown } | null)?.code === ErrorCode.UserCancelled) {
      handlers.onClosed?.();
      return;
    }
    throw e;
  }
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
