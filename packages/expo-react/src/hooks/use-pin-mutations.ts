// Pin operations for links — pin to top, unpin, and move one slot up/down
// within the pinned section — the expo port of web-react's use-pin-mutations,
// verbatim (that file is the canonical doc: pins are their own LWW point, so
// pinning never rewrites the link's blob; reorder is just a new fractional
// `rank`, computed against a fresh read of the pins so a pin added on another
// device since render is accounted for).

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
  // Move a pinned link one slot toward the top / bottom of the pinned section.
  // A no-op (no write) if the link isn't pinned or is already at that end.
  moveUp: (link: LinkItem) => Promise<void>;
  moveDown: (link: LinkItem) => Promise<void>;
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

  // Shared body for the two one-slot moves. `delta` is -1 (up) / +1 (down). The
  // destination is computed against the sibling group MINUS the moved pin, so
  // rankForIndex inserts between the right pair.
  const moveBy = useCallback(
    async (link: LinkItem, delta: number) => {
      if (!username) throw new Error('usePinMutations: no active account');

      const id = linkIdOf(link);
      const ordered = (await readPins()).sort(compareRank);
      const i = ordered.findIndex((p) => p.id === id);
      if (i < 0) return; // not pinned

      const target = i + delta;
      if (target < 0 || target >= ordered.length) return; // already at the end

      const siblings = ordered.filter((_, idx) => idx !== i);
      await writePin(username, ordered[i], { rank: rankForIndex(siblings, target) });
      requestSync();
    },
    [username, requestSync],
  );

  const moveUp = useCallback((link: LinkItem) => moveBy(link, -1), [moveBy]);
  const moveDown = useCallback((link: LinkItem) => moveBy(link, 1), [moveBy]);

  return useMemo<PinMutations>(
    () => ({ pin, unpin, moveUp, moveDown }),
    [pin, unpin, moveUp, moveDown],
  );
}
