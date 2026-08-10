import { useQuery } from '@tanstack/react-query';

import { hasRecoveryDoorQueryOptions, useApiClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';

// Does the signed-in account have a recovery door? — the expo sibling of
// web-react's hooks/use-has-recovery-door.ts. The query itself (the endpoint,
// the 404-means-no reading, the cache key) is shared by both in
// @stxapps/react — see there; all this wrapper adds is the username, which
// comes from the expo auth provider.
export function useHasRecoveryDoor() {
  const api = useApiClient();
  const { username } = useAuth();

  return useQuery(hasRecoveryDoorQueryOptions(api, username));
}
