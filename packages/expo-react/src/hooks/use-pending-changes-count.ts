// Live count of this account's queued local edits — the expo sibling of
// web-react's hooks/use-pending-changes-count.ts (see there): the pendingOps
// rows the next sync cycle will push, powering the "N changes waiting to sync"
// status line in Settings → Data. Returns 0 while signed out or before the
// first read resolves. Reactivity is useLiveRead over `pending_ops` instead of
// Dexie's liveQuery.

import { useAuth } from '../contexts/auth-provider';
import { countPendingOps } from '../data/pending-store';
import { useLiveRead } from './use-live-read';

export function usePendingChangesCount(): number {
  const { username } = useAuth();
  return (
    useLiveRead(
      () => (username ? countPendingOps(username) : Promise.resolve(0)),
      [username],
      ['pending_ops'],
    ) ?? 0
  );
}
