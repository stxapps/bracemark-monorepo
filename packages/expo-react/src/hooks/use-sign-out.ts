import { useMutation } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import { signOutEndpoint } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { getSession } from '../data/session-store';

// The expo sibling of web-react's hooks/use-sign-out.ts: the SAME two-step
// sequence (best-effort server revocation, then the authoritative local drop) —
// see the web hook for the full rationale on each step; only the platform seams
// differ (this package's auth provider, whose endSession also wipes the
// decrypted local store and secure-store session).

export function useSignOut() {
  const api = useApiClient();
  const { endSession } = useAuth();

  return useMutation({
    mutationFn: async () => {
      // The session this sign-out ends: the one whose token the request below
      // carries. A resume while it is in flight mints a replacement, and that
      // one must survive the late step 2.
      const generation = getSession()?.generation ?? null;

      // Step 1: ask the server to revoke this session, while the bearer token is
      // still held (once endSession clears the local session, the token is gone).
      // Best-effort: a network/server failure — or an EXPIRED session, which just
      // answers `session_expired` — must NOT trap the user signed-in; an
      // unrevoked row idles out and is purged like any other. Nor may a stalled
      // one hold the wipe for long: the endpoint's contract caps this wait
      // (SIGN_OUT_TIMEOUT_MS, @stxapps/shared), and a timeout lands in the
      // same catch.
      try {
        await api.call(signOutEndpoint, {});
      } catch {
        // Ignore — local sign-out is authoritative for the UI.
      }

      // Step 2: drop the local session. No reason arg, so this records the
      // default 'signed-out' — AuthGuard sees a deliberate sign-out and sends
      // the user home, not to /sign-in?next=. endSession also runs clearData,
      // which wipes every device-local per-account cache (decrypted rows,
      // plaintext file blobs, the cached subscription copy) so the next account
      // on this device doesn't inherit this one's state.
      await endSession({ generation });
    },
  });
}
