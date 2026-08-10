// The Subscription settings section — the store-IAP mirror of bracemark-web's
// `(app)/settings/[section]/_subscription/subscription-section.tsx` (the
// canonical doc). The moving parts, per docs/iap.md:
//  - plan/status come from useEntitlements (the `iap/status` query + the
//    device-local last-known copy);
//  - an upgrade is: fetch the store products (localized prices) → the store's
//    purchase sheet (lib/iap.ts) → POST /v1/iap/verify with the store's proof
//    of purchase — the server fetches authoritative state from the store's
//    API, records the purchase bound to this account, and returns the fresh
//    fold. No post-checkout polling (the web waits on a webhook; here the
//    verify RESPONSE is the flipped plan) — just a refetch to sync the cache;
//  - "Manage subscription" deep-links to the platform store's own manage
//    surface (payment method, cancel — never in the app); a Paddle (web)
//    purchase gets a note instead, the exact converse of the web's
//    store-purchase note;
//  - "Restore purchases" re-drives verify for purchases the store already
//    holds (App Review requires it; it's also reinstall/new-device recovery).

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { ProductSubscription } from 'expo-iap';
import { Check, ExternalLink, RefreshCw } from 'lucide-react-native';

import { useEntitlements, useSync } from '@stxapps/expo-react';
import {
  type AvailablePaidPlan,
  entitlementsOf,
  PLAN_CARDS,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
} from '@stxapps/shared';

import { LegalConsent } from '../../components/legal-consent';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import {
  fetchStorePlanProducts,
  openStoreCheckout,
  openStoreSubscriptionManagement,
  restoreStorePurchases,
  STORE_SOURCE,
} from '../../lib/iap';
import { SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';

// The upgrade cards (copy + which plans are on sale) come from PLAN_CARDS in
// @stxapps/shared iap/plans.ts, next to the entitlements table they render —
// the SAME cards the web section renders, so the two storefronts can't drift.

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function SubscriptionSection() {
  const { subscription, isLoading, refetch } = useEntitlements();
  // Kicked the moment the plan actually widens — see startCheckout / restore.
  const { requestSync } = useSync();

  // One busy flag drives every control: 'checkout:<plan>' while the store
  // sheet/verify is in flight, 'restore' during restore, 'manage' while the
  // store's manage surface opens, 'refresh' for the status re-read.
  // Serializing them keeps double-taps and overlapping flows out (the web
  // section's exact pattern).
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The store's localized products for the upgrade cards (displayPrice is the
  // authoritative price — the store sheet's own number); null until loaded.
  const [products, setProducts] = useState<Partial<
    Record<AvailablePaidPlan, ProductSubscription>
  > | null>(null);
  // Store callbacks outlive a navigation away mid-purchase; never set state
  // after unmount.
  const unmounted = useRef(false);
  useEffect(() => {
    return () => {
      unmounted.current = true;
    };
  }, []);

  // Load the store catalog only when the upgrade cards will render (free plan)
  // — this is also what lazily opens the store connection (lib/iap.ts).
  const plan = subscription.plan;
  useEffect(() => {
    if (isLoading || plan !== 'free' || products !== null) return;
    let canceled = false;
    fetchStorePlanProducts()
      .then((byPlan) => {
        if (!canceled) setProducts(byPlan);
      })
      .catch(() => {
        // No store on this device/simulator (or the catalog is missing) — the
        // cards render with the planning price and a disabled button.
        if (!canceled) setProducts({});
      });
    return () => {
      canceled = true;
    };
  }, [isLoading, plan, products]);

  const startCheckout = async (cardPlan: AvailablePaidPlan) => {
    const product = products?.[cardPlan];
    if (!product) return;
    setError(null);
    setNotice(null);
    setBusy(`checkout:${cardPlan}`);
    try {
      await openStoreCheckout({
        plan: cardPlan,
        product,
        onCompleted: (status) => {
          if (unmounted.current) return;
          // The verify response already IS the new fold; refetch just syncs
          // the shared query cache + the device's last-known copy.
          void refetch().catch(() => undefined);
          // The widened entitlement is the ONLY thing that unblocks a queue the
          // quota gate refused (engine signPushable / BgSyncStatus
          // 'blocked-capacity'): an upgrade raises maxBytes by orders of
          // magnitude (100 MB → 5 GB), so puts that were over the ceiling a
          // moment ago now fit. Nothing else would kick a cycle: the engine
          // syncs on mount and on local edits. Safe to fire eagerly — cycles
          // single-flight per account.
          requestSync();
          setBusy(null);
          setNotice(`You're on ${PLAN_LABELS[status.plan]} now — thank you!`);
        },
        onFailed: (message) => {
          if (unmounted.current) return;
          setBusy(null);
          setError(message);
        },
        onClosed: () => {
          if (unmounted.current) return;
          setBusy((b) => (b === `checkout:${cardPlan}` ? null : b));
        },
      });
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async () => {
    setError(null);
    setNotice(null);
    setBusy('restore');
    try {
      const status = await restoreStorePurchases();
      if (unmounted.current) return;
      if (status && status.plan !== 'free') {
        void refetch().catch(() => undefined);
        // Same reason as the checkout path: a restore widens the entitlement on
        // THIS device, so anything the plan gate refused here can push now.
        requestSync();
        setNotice(`Restored — you're on ${PLAN_LABELS[status.plan]}.`);
      } else {
        setNotice('No purchases to restore on this store account.');
      }
    } catch (e) {
      if (!unmounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!unmounted.current) setBusy(null);
    }
  };

  const openManage = async () => {
    if (subscription.plan === 'free') return;
    setError(null);
    setBusy('manage');
    try {
      await openStoreSubscriptionManagement(subscription.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshStatus = async () => {
    setError(null);
    setBusy('refresh');
    await refetch().catch(() => undefined);
    setBusy(null);
  };

  if (isLoading) {
    return (
      <SettingsPane>
        <SettingsHeader title="Subscription" description="Loading your subscription…" />
      </SettingsPane>
    );
  }

  const { status, source, expiresAt, willRenew } = subscription;
  // Upgrade cards only from FREE — a paid user buying again would double-
  // subscribe; a Plus→Pro switch is a store subscription UPDATE (its own flow,
  // not yet built).
  //
  // On THIS path that client gate is the only PRE-payment one, which is the
  // difference from the web section: `POST /iap/checkout` can 409
  // `already_subscribed` because it runs before any money moves, whereas a store
  // purchase is charged before the server ever hears of it — so `iap/verify`
  // records it and raises IAP_DOUBLE_SUBSCRIPTION instead of refusing a purchase
  // the customer has already paid for (services/iap.ts). Not to be confused with
  // `purchase_bound`, which is the other direction: one ACCOUNT per store
  // subscription, not one subscription per account.
  const upgradeCards = plan === 'free' ? PLAN_CARDS : [];

  return (
    <SettingsPane>
      <SettingsHeader
        title="Subscription"
        description={
          <Text className="text-sm text-muted-foreground">
            Your plan applies to your whole account, on every device. Payments are handled by the{' '}
            {STORE_SOURCE === 'appstore' ? 'App Store' : 'Play Store'}; Bracemark never sees your
            card details.
          </Text>
        }
      />

      {/* Current plan */}
      <View className="rounded-lg border border-border p-4">
        <View className="flex-row items-start justify-between gap-4">
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row items-baseline gap-2">
              <Text className="font-medium">{PLAN_LABELS[plan]}</Text>
              {plan !== 'free' && status === 'trialing' && (
                <Text className="text-sm text-muted-foreground">free trial</Text>
              )}
              {plan !== 'free' && status === 'grace' && (
                <Text className="text-sm text-destructive">payment issue</Text>
              )}
            </View>
            <Text className="text-sm text-muted-foreground">
              {plan === 'free'
                ? // "with previews" — this app extracts them itself, on-device and for
                  // free (it never calls bracemark-extractor; see docs/link-extraction.md).
                  // The cap comes from the entitlements table rather than the string.
                  `Encrypted saving, sync, lists and tags — up to ${entitlementsOf('free').maxLinks} links, with previews for what you save here.`
                : expiresAt === null
                  ? 'Never expires.'
                  : // A trial's period end is the FIRST CHARGE, not a renewal —
                    // say that, rather than letting "Renews on" imply they have
                    // already paid. Canceling mid-trial gets its own sentence
                    // too: the generic "it won't renew" is accurate but leaves
                    // the question they actually cancelled over — am I being
                    // charged? — unanswered.
                    status === 'trialing'
                    ? willRenew
                      ? `Free trial — your first payment is on ${formatDate(expiresAt)}.`
                      : `Free trial ends on ${formatDate(expiresAt)} — you won't be charged.`
                    : willRenew
                      ? `Renews on ${formatDate(expiresAt)}.`
                      : `Ends on ${formatDate(expiresAt)} — it won't renew.`}
            </Text>
          </View>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onPress={() => void refreshStatus()}
          >
            <Icon as={RefreshCw} className="size-4" />
            <Text>Refresh</Text>
          </Button>
        </View>

        {status === 'grace' && (
          <SettingsNotice tone="error" className="mt-3">
            Your last payment didn&apos;t go through. Update your payment method to keep your plan —
            we&apos;ll retry for a while before it lapses.
          </SettingsNotice>
        )}

        {/* Manage: a subscription bought in THIS platform's store is managed in
            that store's own surface; a Paddle (web) purchase from the web app;
            the other platform's store purchase in that store. */}
        {plan !== 'free' && source === STORE_SOURCE && (
          <View className="mt-3 items-start">
            <Button variant="outline" disabled={busy !== null} onPress={() => void openManage()}>
              <Icon as={ExternalLink} className="size-4" />
              <Text>{busy === 'manage' ? 'Opening…' : 'Manage subscription'}</Text>
            </Button>
            <Text className="mt-2 text-xs text-muted-foreground">
              Payment method, cancellation, and renewals — in the{' '}
              {STORE_SOURCE === 'appstore' ? 'App Store' : 'Play Store'}&apos;s subscription
              settings.
            </Text>
          </View>
        )}
        {plan !== 'free' && source === 'paddle' && (
          <Text className="mt-3 text-sm text-muted-foreground">
            This subscription was purchased on the web — manage billing or cancel it in the web
            app&apos;s Subscription settings.
          </Text>
        )}
        {(source === 'appstore' || source === 'playstore') && source !== STORE_SOURCE && (
          <Text className="mt-3 text-sm text-muted-foreground">
            This subscription was purchased in the{' '}
            {source === 'appstore' ? 'App Store' : 'Play Store'} — manage or cancel it there.
          </Text>
        )}
      </View>

      {notice && <SettingsNotice tone="pending">{notice}</SettingsNotice>}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* Upgrades. The extra column around the cards holds the consent line
          closer than the pane's `gap-6`, so it reads as the cards' own fine
          print rather than as another block of the screen — web's section is
          nested the same way, for the same reason.

          THE LINE MATTERS MORE ON THIS PLATFORM than on web. App Review 3.1.2
          wants functional links to the terms and the privacy policy on the
          surface that sells an auto-renewable subscription, and this is that
          surface; Settings → About having the same two links elsewhere in the
          app is not what the guideline asks for. */}
      {upgradeCards.length > 0 && (
        <View className="gap-3">
          <View className="gap-4">
            {upgradeCards.map(({ plan: cardPlan, blurb, features }) => {
              const product = products?.[cardPlan];
              return (
                <View key={cardPlan} className="rounded-lg border border-border p-4">
                  <View className="flex-row items-baseline justify-between">
                    <Text className="font-medium">{PLAN_LABELS[cardPlan]}</Text>
                    <Text className="text-sm text-muted-foreground">
                      {/* The store's localized price once loaded; the USD
                          planning price as a placeholder meanwhile. */}
                      {product
                        ? `${product.displayPrice}/year`
                        : `$${PLAN_USD_PER_YEAR[cardPlan]}/year`}
                    </Text>
                  </View>
                  <Text className="mt-1 text-sm text-muted-foreground">{blurb}</Text>
                  <View className="mt-3 gap-1.5">
                    {features.map((feature) => (
                      <View key={feature} className="flex-row items-start gap-2">
                        <Icon as={Check} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <Text className="flex-1 text-sm">{feature}</Text>
                      </View>
                    ))}
                  </View>
                  <Button
                    className="mt-4"
                    disabled={busy !== null || !product}
                    onPress={() => void startCheckout(cardPlan)}
                  >
                    <Text>
                      {busy === `checkout:${cardPlan}`
                        ? 'Finishing your upgrade…'
                        : `Upgrade to ${PLAN_LABELS[cardPlan]}`}
                    </Text>
                  </Button>
                </View>
              );
            })}
          </View>

          {/* No mention of the store here — the section header already names who
              takes the payment, and repeating it in the fine print is how a
              settings surface accretes text nobody reads. */}
          <LegalConsent action="subscribing" />
        </View>
      )}

      {plan === 'free' && (
        <View className="items-start">
          <Button variant="ghost" size="sm" disabled={busy !== null} onPress={() => void restore()}>
            <Text>{busy === 'restore' ? 'Restoring…' : 'Restore purchases'}</Text>
          </Button>
        </View>
      )}
    </SettingsPane>
  );
}
