'use client';

// The main pane's body while the selected list is locked — a SWAP for the link
// layout, not an overlay: the layout (and its link query) simply doesn't mount,
// so the locked links are never fetched, never in the DOM (find-in-page, screen
// readers), and there's nothing to peek at. Unlocking flips lock-provider's
// in-memory state and Main mounts the layout fresh.

import { useLocks } from '@stxapps/web-react';

import { LockPane } from '@/components/lock-pane';

export function ListLockPane({ listId }: { listId: string }) {
  const { unlockList } = useLocks();

  return (
    <LockPane
      className="h-full"
      title="This list is locked"
      description="Enter the list's password to view its links."
      onUnlock={(password) => unlockList(listId, password)}
    />
  );
}
