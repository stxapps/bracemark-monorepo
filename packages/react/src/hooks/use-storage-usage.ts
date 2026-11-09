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

// "Preview images and screenshots", not "Screenshots": a screenshot is the
// largest single copy, but every link has a preview and screenshots are off by
// default, so in most libraries the previews are most of the bytes (measured,
// docs/link-extraction-keep.md). Deleting links is named beside removing copies
// for the same reason — a library full of previews has no copies to remove.
const NOTE_ROOM = 'Preview images and screenshots take the most room.';
const NOTE_FULL =
  'Full — new changes wait to sync until there’s room. Removing kept copies or deleting links permanently frees space.';

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
