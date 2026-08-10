'use client';

import { useQuery } from '@tanstack/react-query';

import { hasRecoveryDoorQueryOptions, useApiClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';

// Does the signed-in account have a recovery door? Powers the "no recovery set"
// nudge in Settings → Account. The query itself (the endpoint, the 404-means-no
// reading, the cache key) is shared with expo in @stxapps/react — see there; all
// this wrapper adds is the username, which comes from the web auth provider.
export function useHasRecoveryDoor() {
  const api = useApiClient();
  const { username } = useAuth();

  return useQuery(hasRecoveryDoorQueryOptions(api, username));
}
