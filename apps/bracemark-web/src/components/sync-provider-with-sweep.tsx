'use client';

// bracemark-web's SyncProvider, carrying the once-per-session dangling-extraction
// janitor (sweepDanglingExtractions — see its header for what a dangling is and why
// it's fixed by deletion). A client wrapper because the (app) layout is a server
// component and can't hand the provider a function.
//
// It lives in bracemark-web — not in a shared web-react provider — on purpose: the
// sweep queues REMOTE deletes from "link absent locally", which is only sound on a
// client that syncs the whole library. bracemark-web is one; the browser extension
// is not — it syncs selectively (a `pathFilter` in its sync-runner, today skipping
// `pins/`), and which prefixes it materializes is its own call to change. So the
// sweep must never be inherited by mounting a shared provider: that would couple
// these remote deletes to whatever some other app's filter happens to be.
//
// WHEN it runs is the engine's `afterCycle` (sync/engine.ts SyncDeps): at the end
// of a background cycle that succeeded, still inside that cycle's lock. That is the
// best moment to judge by "link absent locally", and at no other does it mean much.
// Before the first sync completes, absence proves nothing (see the sweep's header);
// during any pull — this tab's, or another tab's on the same store — a link can be
// absent merely because its GET hasn't landed yet; and after a cycle that FAILED,
// what it had already pulled stays stored while the cursor stays put, so an
// extraction can be in the store without the link the next cycle would bring. The
// lock keeps every context's cycle for this account out while the sweep reads (where
// Web Locks exist; elsewhere, only this tab's own), and a failed cycle never reaches
// its end. Even then the store can lack a link the
// server holds: one the pull skipped as unreadable, which the sweep passes over
// itself (SyncMetaRecord.unreadablePaths), and the known gaps the sweep's header
// lists, which it cannot see.
//
// Once per session is enough: danglings are rare, one skews a stat, and this
// remounts on the next sign-in/visit ((app) layout) so garbage never outlives a
// session boundary by more than a session. The latch is set before the sweep runs,
// so a failed sweep is not retried within the session either — it changes nothing
// user-visible, and the next session tries again. Resolving `true` when it swept
// anything has the engine run the cycle once more, which pushes the tombstones so
// other devices stop re-pulling the garbage.
//
// The ORPHANED-FILE sweep (sweepOrphanFiles) runs in the same slot, after the
// dangling one — which may have just freed blobs of its own — for the same reasons
// and under stricter ones of its own (its header: no unreadable paths at all, every
// string in every entity counts as a reference, a month's grace, nothing queued, at
// most weekly). It deletes user data on every device when it is wrong, which is why
// it must stay here and nowhere a selective-sync client could inherit it.

import { type ReactNode, useCallback, useRef } from 'react';

import { sweepDanglingExtractions, sweepOrphanFiles, SyncProvider } from '@stxapps/web-react';

export function SyncProviderWithSweep({ children }: { children: ReactNode }) {
  // Per mount (= per signed-in session; sign-out unmounts the (app) tree), and keyed
  // by account so an account change inside one mount still gets its sweep.
  const sweptForRef = useRef<string | null>(null);

  const afterCycle = useCallback(async (username: string): Promise<boolean> => {
    if (sweptForRef.current === username) return false;
    sweptForRef.current = username;
    const danglings = await sweepDanglingExtractions(username);
    const orphans = await sweepOrphanFiles(username);
    return danglings + orphans > 0;
  }, []);

  return <SyncProvider afterCycle={afterCycle}>{children}</SyncProvider>;
}
