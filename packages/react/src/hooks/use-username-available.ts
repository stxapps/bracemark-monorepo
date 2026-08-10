'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import {
  type ApiClient,
  canonicalizeUsername,
  checkUsernameEndpoint,
  usernameSchema,
} from '@stxapps/shared';

import { useApiClient } from '../contexts/api-client-provider';
import { useDebouncedValue } from './use-debounced-value';

// One source of truth for the query so the live hook and the submit-time check
// share a cache key — when the user pauses on a name, submit gets a cache hit
// instead of a second round trip. Export-and-reuse is the TanStack-recommended
// shape over inlining queryKey/queryFn at each call site.
//
// Canonicalized (trim→NFKC→lowercase) before keying and sending: availability is
// a fact about the CANONICAL handle (the server's UNIQUE key), so `Alice` and
// `alice` are the same question — one cache entry, and the live hook's key always
// matches the submit-time fetchQuery's regardless of typed case.
export function usernameAvailableQueryOptions(client: ApiClient, username: string) {
  username = canonicalizeUsername(username);
  return queryOptions({
    queryKey: ['username-available', username] as const,
    // `signal` flows into fetch, so a superseded request (older keystrokes) is
    // aborted — the race-safety that makes this worth a query lib over useEffect.
    queryFn: ({ signal }) => client.call(checkUsernameEndpoint, { username }, { signal }),
    // Only hit the server once the value passes the shared format rules; avoids
    // firing for too-short/invalid names. (fetchQuery ignores this on submit.)
    enabled: usernameSchema.safeParse(username).success,
    staleTime: 60_000,
  });
}

// Live availability for the create-account field. Debounces internally and is
// purely for inline feedback; the authoritative gate is a fetchQuery on submit
// (with the exact, non-debounced value) and the server re-check at creation.
export function useUsernameAvailable(username: string) {
  const client = useApiClient();
  const debounced = useDebouncedValue(username);
  return useQuery(usernameAvailableQueryOptions(client, debounced));
}
