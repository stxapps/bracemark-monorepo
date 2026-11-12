'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import {
  type ApiClient,
  filesUsageEndpoint,
  formatStorageBytes,
  formatStorageCeiling,
  isPublishedStorageCeiling,
} from '@stxapps/shared';

import { useApiClient } from '../contexts/api-client-provider';

// What the account's library stores, against the ceiling a save is checked by
// (`GET /v1/files/usage`). Read only where it is shown — Settings → Subscription on
// both apps — so a library that never opens that screen never pays for the call.
export function storageUsageQueryOptions(client: ApiClient) {
  return queryOptions({
    queryKey: ['files', 'usage'] as const,
    queryFn: ({ signal }) => client.call(filesUsageEndpoint, {}, { signal }),
    // A save moves it, so a short staleTime: reopening the screen after keeping a
    // few copies should show them, without a refetch on every render.
    staleTime: 30_000,
  });
}

export type StorageReadout = {
  // "1.2 GB of 5 GB used" — the whole readout, and its accessible text.
  text: string;
  // 0..1, for the bar. Capped at 1: an account can sit a batch past its ceiling,
  // because a put is admitted against usage BEFORE it (bracemark-api lib/quota.ts).
  fraction: number;
  full: boolean;
  // The line under the bar. Full, it says what the sync status says in other
  // words ("Some changes aren’t syncing — storage full", shared sync/status.ts):
  // changes wait for room rather than fail, so it must not read as data lost.
  // Below full, it names what fills a library and the way to make room, which is
  // the one thing a person reading a storage number can act on.
  note: string;
};

// Two kinds of picture, in the order most libraries hold them: every link has a
// preview; a read-mode copy can keep its article's images (off by default), and those are the
// largest thing a library stores (a pack is a few hundred KB, a few MB for a long
// illustrated article). "Images" first because that is the whole of it —
// links, notes and an article's text are next to nothing. Deleting links is named
// beside removing copies for the same reason — a library full of previews has no
// copies to remove.
const NOTE_ROOM = 'Images take the most room: previews and the pictures in read-mode copies.';
const NOTE_FULL =
  'Full — new changes wait to sync until there’s room. Deleting copies you’ve kept, or links in Trash, frees space.';

// The readout both settings screens draw, or null when there is nothing to show:
// still loading, failed (the screen has nothing else that depends on it, so it is
// simply left out), or a ceiling the product does not publish
// (`isPublishedStorageCeiling` — Free's, today).
export function useStorageReadout(): StorageReadout | null {
  const client = useApiClient();
  const { data } = useQuery(storageUsageQueryOptions(client));
  if (!data || !isPublishedStorageCeiling(data.maxBytes)) return null;
  const { usedBytes, maxBytes } = data;
  const full = usedBytes >= maxBytes;
  return {
    text: `${formatStorageBytes(usedBytes)} of ${formatStorageCeiling(maxBytes)} used`,
    fraction: Math.min(1, usedBytes / maxBytes),
    full,
    note: full ? NOTE_FULL : NOTE_ROOM,
  };
}
