'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import {
  type ApiClient,
  canonicalizeUsername,
  checkUsernameEndpoint,
  isRetryableTransportError,
  retryDelayMs,
  usernameSchema,
} from '@stxapps/shared';

import { useApiClient } from '../contexts/api-client-provider';
import { useDebouncedValue } from './use-debounced-value';

// Retries after the first failure. The count TanStack would use anyway; what
// changes is which failures get them and how long each waits (below).
export const USERNAME_CHECK_RETRIES = 3;

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
    // A 429 is a WAIT, not a failure. The endpoint's limit is per network, so a
    // room signing up together on one wifi can share it out, and the server says
    // exactly when its window clears (Retry-After). TanStack's own backoff (1 s,
    // 2 s, 4 s) ignores that hint, spends all three retries inside the window
    // that refused the first, and lands on "Couldn’t check. Try again." with the
    // submit disabled — a stuck rung for a state that clears by itself. Waiting
    // the hint keeps `isFetching` true between tries, so the field reads
    // "Checking availability…" until the answer lands, which is simply true.
    //
    // Only what the shared transport policy calls retryable (a 429, a 5xx, a
    // dropped connection; api/retry.ts) is retried, on its timing. A 4xx on the
    // merits fails at once, and an abort from a newer keystroke is never revived.
    // These options ride into the submit-time `fetchQuery` too (which would
    // otherwise default to no retry), so a submit that has to re-ask waits out a
    // 429 under "Creating account…" rather than failing as UsernameCheckError.
    retry: (failureCount, err) =>
      failureCount < USERNAME_CHECK_RETRIES && isRetryableTransportError(err),
    retryDelay: (failureCount, err) => retryDelayMs(err, failureCount),
  });
}

// Live availability for the create-account field. Debounces internally and is
// purely for inline feedback; the authoritative gate is a fetchQuery on submit
// (with the exact, non-debounced value) and the server re-check at creation.
//
// `current` is the query result's expiry date, and callers MUST check it before
// showing `data`. The query answers the DEBOUNCED name, so for the ~400ms after a
// keystroke `data` still describes the PREVIOUS one — while `isFetching` is false,
// because no request is in flight yet. Rendering `data.available` unguarded
// therefore says "Username is available" about a name the user has already typed
// past, which is the one direction this message must never be wrong in.
export function useUsernameAvailable(username: string) {
  const client = useApiClient();
  const debounced = useDebouncedValue(username);
  const query = useQuery(usernameAvailableQueryOptions(client, debounced));
  // Compare CANONICAL forms, matching what the query keys on — `Alice` typed over
  // `alice` is the same question and shouldn't re-open a "checking…" window.
  const current = canonicalizeUsername(debounced) === canonicalizeUsername(username);
  return { ...query, current };
}
