'use client';

import { useMutation } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import { signOutEndpoint } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';

// Web-only: it reaches for the web auth context + the configured api client, so it
// can't live in the platform-agnostic @stxapps/react (same reasoning as
// use-create-account). The client comes from useApiClient() — the seam each app
// binds to its own baseUrl — instead of a hardcoded app-local `api`. The TanStack
// analog of a redux-thunk: one async unit you "dispatch" (mutate), with
// isPending/error for free.

export function useSignOut() {
  const api = useApiClient();
  const { endSession } = useAuth();

  return useMutation({
    mutationFn: async () => {
      // Step 1: ask the server to revoke this session, while the bearer token is
      // still live (authFetch attaches it — once endSession clears the local
      // session, the token is gone). Best-effort: a network/server failure here
      // must NOT trap the user signed-in. The orphaned row ages out via its TTL,
      // so we swallow the error and still drop the local session below.
      try {
        await api.call(signOutEndpoint, {});
      } catch {
        // Ignore — local sign-out is authoritative for the UI.
      }

      // Step 2: drop the local session (clears the session store + flips app auth
      // state to unauthenticated). No reason arg, so this records the default
      // 'signed-out' — AuthGuard sees a deliberate sign-out and sends the user out
      // to the marketing site, not /sign-in?next=. This is the step that actually signs the user
      // out client-side. In bracemark-web that lands the user on the marketing
      // site's landing page — see AuthGuard. endSession also runs clearData, which wipes every
      // device-local per-account cache — including the last-known subscription copy
      // — so the next account here doesn't inherit this one's state (clear-data.ts).
      await endSession();
    },
  });
}
