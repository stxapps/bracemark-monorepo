'use client';

// Pin operations for links — pin to top, unpin, and move one slot up/down within
// the pinned section — bound to the active account and wired to a sync kick. Each
// op writes exactly ONE pin file (writePin) or deletes one (deletePin); pins are
// their own LWW point (entities.ts), so pinning/reordering a link never rewrites
// the link's blob and concurrent pin moves on two devices don't collide.
//
// Reorder is just a new `rank` (rank.ts fractional index), the same way
// useListMutations reorders lists: pick the destination index, rankForIndex turns
// it into the key to persist, and nothing else is rewritten. Move re-reads the
// pins from the store rather than trusting a snapshot, so a pin added on another
// device since render is accounted for.

import { useCallback, useMemo } from 'react';

import { compareRank, pathFromId, PINS_PREFIX, rankForIndex } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { deletePin, writePin } from '../data/mutations';
import { linkIdOf, type LinkItem, type PinItem, readPins } from '../data/queries';

// The pin shadows the link at `pins/{id}.enc`, keyed by the link's id (linkIdOf).
function pinPathOf(linkId: string): string {
  return pathFromId(linkId, PINS_PREFIX);
}

export interface PinMutations {
  // Pin a link to the very top of the pinned section.
  pin: (link: LinkItem) => Promise<void>;
  // Remove a link's pin (the link itself is untouched).
  unpin: (link: LinkItem) => Promise<void>;
  // Move a pinned link one slot toward the top / bottom of the pinned section
  // AS THE VIEW SHOWS IT: to just above `above` / just below `below`, the
  // adjacent pinned link the caller renders. A no-op (no write) if either link
  // is no longer pinned.
  moveUp: (link: LinkItem, above: LinkItem) => Promise<void>;
  moveDown: (link: LinkItem, below: LinkItem) => Promise<void>;
}

export function usePinMutations(): PinMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const pin = useCallback(
    async (link: LinkItem) => {
      if (!username) throw new Error('usePinMutations: no active account');

      const id = linkIdOf(link);
      // Top of the section = index 0 among the current pins, ascending by rank.
      const ordered = (await readPins()).sort(compareRank);
      const pinItem: PinItem = {
        id,
        rank: rankForIndex(ordered, 0),
        createdAt: 0,
        updatedAt: 0,
        path: pinPathOf(id),
      };

      await writePin(username, pinItem, {});
      requestSync();
    },
    [username, requestSync],
  );

  const unpin = useCallback(
    async (link: LinkItem) => {
      if (!username) throw new Error('usePinMutations: no active account');

      await deletePin(username, linkIdOf(link));
      requestSync();
    },
    [username, requestSync],
  );

  // Shared body for the two one-slot moves: re-rank `link` to sit directly
  // before (`side` -1) or after (+1) `neighbour`. The neighbour, not a global
  // index ± 1, because pins have no listId: the store holds ONE rank order and
  // each view filters it (readPinnedOverlay), so the pin one global slot away
  // may be in another list, or dangling — stepping past it writes a rank and
  // changes nothing on screen. The view's order is a subsequence of the global
  // one, so landing beside the neighbour always swaps the two there. The
  // destination is computed against the pins MINUS the moved one, exactly like
  // useListMutations.move, so rankForIndex inserts between the right pair.
  const moveBeside = useCallback(
    async (link: LinkItem, neighbour: LinkItem, side: -1 | 1) => {
      if (!username) throw new Error('usePinMutations: no active account');

      const id = linkIdOf(link);
      const ordered = (await readPins()).sort(compareRank);
      const moved = ordered.find((p) => p.id === id);
      if (!moved) return; // not pinned

      const siblings = ordered.filter((p) => p !== moved);
      const j = siblings.findIndex((p) => p.id === linkIdOf(neighbour));
      if (j < 0) return; // the neighbour was unpinned since render

      await writePin(username, moved, { rank: rankForIndex(siblings, side < 0 ? j : j + 1) });
      requestSync();
    },
    [username, requestSync],
  );

  const moveUp = useCallback(
    (link: LinkItem, above: LinkItem) => moveBeside(link, above, -1),
    [moveBeside],
  );
  const moveDown = useCallback(
    (link: LinkItem, below: LinkItem) => moveBeside(link, below, 1),
    [moveBeside],
  );

  return useMemo<PinMutations>(
    () => ({ pin, unpin, moveUp, moveDown }),
    [pin, unpin, moveUp, moveDown],
  );
}
