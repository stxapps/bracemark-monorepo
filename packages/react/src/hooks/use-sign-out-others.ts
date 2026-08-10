'use client';

import { useMutation } from '@tanstack/react-query';

import { signOutOthersEndpoint } from '@stxapps/shared';

import { useApiClient } from '../contexts/api-client-provider';

// "Sign out other devices" (Settings → Account). Revokes every OTHER session for
// the account server-side, keeping THIS device signed in — so, unlike useSignOut,
// it does NOT call endSession or touch the local session store. Session-only on
// the server (requireAuth, no fresh proof): a low-harm, reversible action, the
// plural of sign-out.
//
// Platform-agnostic, unlike its useSignOut neighbour: leaving the local session
// alone is exactly what removes the dependency on a platform session store, so
// there's nothing left here but the api call. Both apps use this one copy.
export function useSignOutOthers() {
  const api = useApiClient();

  return useMutation({
    mutationFn: async () => {
      // The bearer token (attached by authFetch) names the session to KEEP; the
      // server deletes all the account's other rows. Not swallowed like sign-out's
      // best-effort call: here success is the whole point of the action, so a
      // failure must surface to the UI rather than falsely report "signed out".
      await api.call(signOutOthersEndpoint, {});
    },
  });
}
