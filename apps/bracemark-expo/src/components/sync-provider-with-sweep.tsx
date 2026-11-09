// bracemark-expo's SyncProvider, carrying the two janitors that queue remote
// deletes from local absence: the dangling-extraction sweep, then the
// orphaned-file sweep (expo-react data/sweep-*.ts, whose rules are shared's
// sync/sweeps.ts). bracemark-web's SyncProviderWithSweep is the original, and its
// header carries the reasoning: why WHEN is the engine's afterCycle (the end of
// a successful cycle, inside its lock), why the latch is set before the sweep
// runs, why `true` asks for one more cycle (it pushes the tombstones), and why
// the orphaned-file sweep follows the dangling one in the same slot.
//
// It lives in the app, not in expo-react's SyncProvider, for web's reason: the
// sweeps are only sound on a client that syncs the whole library, so no surface
// may inherit them by mounting a shared provider. bracemark-expo is one. The iOS
// share extension never opens the database and never runs a cycle.
//
// Where it differs from web, ONE thing: how long the latch lasts. On web it lasts
// a visit. Here a mount can last for days, since the process lives on in the
// background, so the latch lets a run through again once SWEEP_EVERY_MS has
// passed. The orphaned-file sweep keeps its own weekly gate either way; this only
// keeps a dangling extraction from outliving a long-lived process.

import { type ReactNode, useCallback, useRef } from 'react';

import { sweepDanglingExtractions, sweepOrphanFiles, SyncProvider } from '@stxapps/expo-react';

export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export function SyncProviderWithSweep({ children }: { children: ReactNode }) {
  // Per mount (sign-out unmounts the (app) tree), and keyed by account so an
  // account change inside one mount still gets its sweep.
  const sweptRef = useRef<{ username: string; at: number } | null>(null);

  const afterCycle = useCallback(async (username: string): Promise<boolean> => {
    const now = Date.now();
    const last = sweptRef.current;
    if (last?.username === username && now - last.at < SWEEP_EVERY_MS) return false;
    sweptRef.current = { username, at: now };
    const danglings = await sweepDanglingExtractions(username);
    const orphans = await sweepOrphanFiles(username);
    return danglings + orphans > 0;
  }, []);

  return <SyncProvider afterCycle={afterCycle}>{children}</SyncProvider>;
}
