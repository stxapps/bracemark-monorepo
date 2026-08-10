'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import { type ApiClient, iapStatusEndpoint, type SubscriptionStatus } from '@stxapps/shared';

import { useApiClient } from '../contexts/api-client-provider';

// The account's subscription state, from the one authority: `GET /v1/iap/status`
// on bracemark-api. Deliberately NOT a synced entity (the server derives it from
// webhook-written purchase rows and can't write into the user's encrypted
// keyspace) — every device asks and caches instead. This hook is the query
// layer only; platform wrappers add persistence (web-react's useEntitlements
// keeps a last-known copy so an offline start doesn't flash free).

// What an account with no live subscription resolves to — also the safe default
// while the first fetch is in flight.
export const FREE_SUBSCRIPTION_STATUS: SubscriptionStatus = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
};

// Export-and-reuse (the use-username-available pattern): the hook, a
// post-checkout poll, and any submit-time fetchQuery all share one cache entry.
export function subscriptionStatusQueryOptions(client: ApiClient) {
  return queryOptions({
    queryKey: ['iap', 'status'] as const,
    queryFn: ({ signal }) => client.call(iapStatusEndpoint, {}, { signal }),
    // Subscription state changes rarely (a renewal, a checkout) and the
    // interested flows invalidate/refetch explicitly, so a long staleTime keeps
    // navigation from re-hitting the endpoint.
    staleTime: 5 * 60_000,
  });
}

export function useSubscriptionStatus(options?: {
  // Placeholder shown until the fetch lands (e.g. a persisted last-known
  // status). Rendered but never cached — a later success overwrites it.
  placeholderData?: SubscriptionStatus;
}) {
  const client = useApiClient();
  return useQuery({
    ...subscriptionStatusQueryOptions(client),
    placeholderData: options?.placeholderData,
  });
}
