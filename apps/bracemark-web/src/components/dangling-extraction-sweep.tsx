'use client';

// Once-per-session trigger for the dangling-extraction janitor
// (sweepDanglingExtractions — see its header for what a dangling is and why it's
// fixed by deletion). Renders nothing; it just watches for the session's first
// COMPLETED sync cycle and fires the sweep once.
//
// It lives in bracemark-web — not in a shared web-react provider — on purpose: the sweep
// queues REMOTE deletes from "link absent locally", which is only sound on a client
// that syncs the whole library. bracemark-web is one; the browser extension is not — it
// syncs selectively (a `pathFilter` in its sync-runner, today skipping `pins/`), and
// which prefixes it materializes is its own call to change. So the sweep must never
// be inherited by mounting a shared provider: that would couple these remote deletes
// to whatever some other app's filter happens to be.
//
// The guard (`storeStatus === 'ready' && bgSyncStatus === 'idle' && lastSyncAt !==
// null`) means "a cycle finished successfully this session": lastSyncAt is null until
// a cycle completes, and after a failure bgSyncStatus is 'error', so the pair can't
// be satisfied by the initial state or a failed cycle. That timing matters — during
// the initial pull (and before any pull), "link absent" proves nothing (see the sweep's
// header). Once per session is enough: danglings are rare, one skews a stat, and the
// component remounts on the next sign-in/visit ((app) layout) so garbage never
// outlives a session boundary by more than a session.

import { useEffect, useRef } from 'react';

import { sweepDanglingExtractions, useAuth, useSync } from '@stxapps/web-react';

export function DanglingExtractionSweep() {
  const { username } = useAuth();
  const { storeStatus, bgSyncStatus, lastSyncAt, requestSync } = useSync();

  // Once per mount (= per signed-in session; sign-out unmounts the (app) tree).
  const sweptRef = useRef(false);

  useEffect(() => {
    if (sweptRef.current || !username) return;
    if (storeStatus !== 'ready' || bgSyncStatus !== 'idle' || lastSyncAt === null) return;

    sweptRef.current = true;
    void sweepDanglingExtractions(username).then(
      (swept) => {
        // Push the queued tombstones so other devices stop re-pulling the garbage.
        if (swept > 0) requestSync();
      },
      () => {
        // Best-effort janitor: a failed sweep changes nothing user-visible and the
        // next session retries, so don't re-arm within this one.
      },
    );
  }, [username, storeStatus, bgSyncStatus, lastSyncAt, requestSync]);

  return null;
}
