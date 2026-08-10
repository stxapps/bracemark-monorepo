'use client';

// Live count of this account's queued local edits — the pendingOps rows the next
// sync cycle will push. Powers the "N changes waiting to sync" status lines in
// the Settings→Data card and the extension popup's sync detail. Returns 0 while
// signed out or before the first read resolves. The querier is a single direct
// Dexie call (no async helper hops), so liveQuery's dependency tracking is safe.

import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '../contexts/auth-provider';
import { db } from '../data/db';

export function usePendingChangesCount(): number {
  const { username } = useAuth();
  return (
    useLiveQuery(
      () => (username ? db.pendingOps.where('username').equals(username).count() : 0),
      [username],
      0,
    ) ?? 0
  );
}
