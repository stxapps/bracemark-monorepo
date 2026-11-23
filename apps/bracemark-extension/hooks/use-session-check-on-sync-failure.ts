import { useEffect } from 'react';

import { useApiClient } from '@stxapps/react';
import { sessionProbeEndpoint } from '@stxapps/shared';
import { useAuth, useSync } from '@stxapps/web-react';

// A FAILED BACKGROUND CYCLE GETS ONE SESSION CHECK FROM THE POPUP.
//
// The background worker syncs with the stored token but never acts on what the
// server says about it (docs/sessions.md, _who acts on a 401_): it runs no
// AuthProvider, so a `session_revoked` or `session_expired` it earns reaches no
// listener, and the mirror only records that the cycle failed. The popup is a
// lifecycle owner, but it learns a verdict only from its OWN requests, and the
// one it makes on its own is the editor's plan check — which never mounts on a
// page the popup can't save (a chrome:// or about: tab). There the pill read
// "Sync failed" with a Retry that could only fail again, for as long as the
// session stayed revoked, and the device was never told to forget.
//
// So while the popup is signed in and the mirror says the last cycle failed, it
// sends the same probe the expired state uses (`GET /v1/auth/session`) through
// its own api client. The answer goes where every popup verdict goes — the auth
// provider, under the lifecycle lock, against the persisted generation — so
// `session_revoked` erases this device and shows the sign-in notice, and
// `session_expired` / `session_unknown` turn the pill into "Sync paused". A
// session that is fine answers 200 and changes nothing: the failure was
// something else, and the pill keeps saying so. One probe per failure: the
// effect re-runs only when the failure clears and comes back (a Retry that
// fails again), or on the next popup open.
//
// An expired session is skipped: the auth provider already probes it, and its
// worker calls nothing, so its mirror reads `paused`, not `error`.
export function useSessionCheckOnSyncFailure(): void {
  const api = useApiClient();
  const { status, sessionState } = useAuth();
  const { bgSyncStatus } = useSync();
  const check = status === 'authenticated' && sessionState === 'active' && bgSyncStatus === 'error';

  useEffect(() => {
    if (!check) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void api.call(sessionProbeEndpoint, {}).catch(() => undefined);
  }, [check, api]);
}
