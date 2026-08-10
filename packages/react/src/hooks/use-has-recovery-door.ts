'use client';

import { queryOptions } from '@tanstack/react-query';

import { type ApiClient, ApiError, recoveryDoorEndpoint } from '@stxapps/shared';

// Does an account have a recovery door? Powers the "no recovery set" nudge in
// Settings → Account. We reuse the pre-auth recovery-door fetch (it only ever
// serves this user's own ciphertext) and read existence from the status: a 200
// means a door is set, a 404 means it was skipped at create (or never added).
// Query, not mutation — it's a cacheable read; it invalidates when a recovery
// code is (re)generated so the nudge disappears immediately.
//
// This is the query layer only (the use-subscription-status pattern): the
// username comes from each platform's own useAuth, whose provider is bound to a
// platform session store, so the HOOK stays in web-react / expo-react and only
// the shared parts live here.

// The invalidation prefix, exported so the (re)generate flows can't drift from
// the reader by a mistyped string literal — `queryClient.invalidateQueries({
// queryKey: hasRecoveryDoorQueryKey })` matches every username's entry.
export const hasRecoveryDoorQueryKey = ['recovery-door-exists'] as const;

export function hasRecoveryDoorQueryOptions(client: ApiClient, username: string | null) {
  return queryOptions({
    queryKey: [...hasRecoveryDoorQueryKey, username] as const,
    enabled: !!username,
    queryFn: async (): Promise<boolean> => {
      // `enabled` gates this on a non-null username; the guard just narrows the type.
      if (!username) return false;
      try {
        await client.call(recoveryDoorEndpoint, { username });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return false;
        throw err;
      }
    },
  });
}
