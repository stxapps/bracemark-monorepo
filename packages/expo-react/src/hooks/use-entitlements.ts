import { useEffect, useState } from 'react';

import { FREE_SUBSCRIPTION_STATUS, useSubscriptionStatus } from '@stxapps/react';
import { type Entitlements, entitlementsOf, type SubscriptionStatus } from '@stxapps/shared';

import { readCachedStatus, writeCachedStatus } from '../data/subscription-store';

// The expo sibling of web-react's hooks/use-entitlements.ts, verbatim in
// contract (see there): wraps @stxapps/react's useSubscriptionStatus (the query
// on `GET /v1/iap/status`) with the device-local LAST-KNOWN copy
// (subscription-store — sqlite here instead of localStorage), so an offline or
// cold start keeps the account's plan instead of flashing free.

export type UseEntitlementsResult = {
  // The folded subscription state (plan + display fields for the settings UI).
  subscription: SubscriptionStatus;
  // What the plan unlocks — the shared entitlementsOf table, so gates here
  // match the server's enforcement and the paywall's copy exactly.
  entitlements: Entitlements;
  // True only on a cold start with nothing cached — callers can skip paywall
  // flashes while the very first answer is in flight.
  isLoading: boolean;
  // Force a re-read (e.g. a "Refresh status" button). Resolves with the fresh
  // status (undefined on failure) so a poll loop can inspect the answer
  // directly instead of racing a re-render.
  refetch: () => Promise<{ data?: SubscriptionStatus }>;
};

export function useEntitlements(): UseEntitlementsResult {
  // Read once per mount (lazy useState, not per render) so the placeholder is
  // identity-stable — see the unstable-value rules for hook returns.
  const [cached] = useState(readCachedStatus);
  const query = useSubscriptionStatus({ placeholderData: cached ?? undefined });

  // Persist each fresh answer as the device's last-known copy. `isSuccess` alone
  // does NOT mean "fresh": react-query reports status 'success' the whole time it
  // is serving placeholderData, so the isPlaceholderData guard is what keeps this
  // from writing the placeholder straight back. Usually that would be a harmless
  // rewrite of the value we just read — but not when the placeholder came from
  // ANOTHER account's cache entry, which is the failure the sign-out
  // queryClient.clear() (auth-provider) closes from the other side.
  useEffect(() => {
    if (query.data === undefined || !query.isSuccess || query.isPlaceholderData) return;
    writeCachedStatus(query.data);
  }, [query.data, query.isSuccess, query.isPlaceholderData]);

  const subscription = query.data ?? cached ?? FREE_SUBSCRIPTION_STATUS;
  return {
    subscription,
    entitlements: entitlementsOf(subscription.plan),
    isLoading: query.isPending && cached === null,
    refetch: query.refetch,
  };
}
