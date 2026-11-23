'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import {
  type ApiClient,
  entitlementsOf,
  filesUsageEndpoint,
  formatStorageBytes,
  formatStorageCeiling,
  isPublishedStorageCeiling,
  type Plan,
  PLAN_LABELS,
  PLANS,
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
  // Set when the ceiling is NOT the current plan's: the endpoint reports the
  // account's high-water ceiling (docs/iap.md, _the two ceilings are not
  // retroactive_), so a lapsed Plus account reads "of 5 GB" under a plan box
  // that says Free. Without this line the two disagree on screen; with it the
  // number says where it came from. Null when the ceiling is the plan's own.
  kept: string | null;
};

// Two kinds of picture, in the order most libraries hold them: every link has a
// preview; a read-mode copy can keep its article's images (off by default), and those are the
// largest thing a library stores (a pack is a few hundred KB, a few MB for a long
// illustrated article). "Images" first because that is the whole of it —
// links, notes and an article's text are next to nothing. Deleting links is named
// beside removing copies for the same reason — a library full of previews has no
// copies to remove.
const NOTE_STORAGE = 'Images take the most storage: previews and the images in read-mode copies.';
const NOTE_FULL =
  'Full — new changes wait to sync until there’s room. Deleting copies you’ve kept, or links in Trash, frees space.';

// The readout both settings screens draw, or null when there is nothing to show:
// still loading, failed (left out rather than guessed), or a ceiling the product
// does not publish (`isPublishedStorageCeiling` — Free's, today). `plan` is the
// account's CURRENT plan, which is what tells a kept ceiling from its own.
//
// `settled` is for the screen's reveal gate: true once the read has answered,
// or when it is not on the wire at all — react-query holds an offline query as
// `paused`, and a screen waiting on that would wait its whole cap for an answer
// that is not coming. Settings → Subscription holds its first paint on it so the
// block doesn't drop in under a page already on screen. A FAILING read is not
// settled quickly, though: `fetchStatus` stays `fetching` through its retries —
// react-query's own three (1 s, 2 s, 4 s), each over the api client's for a 5xx,
// a 429 or a network error (@stxapps/shared api/retry.ts) — far past the screens'
// REVEAL_WAIT_MS, so on a failure it is that cap that ends the wait.
export function useStorageReadout(plan: Plan): {
  readout: StorageReadout | null;
  settled: boolean;
} {
  const client = useApiClient();
  const { data, isFetched, fetchStatus } = useQuery(storageUsageQueryOptions(client));
  const settled = isFetched || fetchStatus !== 'fetching';
  if (!data || !isPublishedStorageCeiling(data.maxBytes)) return { readout: null, settled };
  const { usedBytes, maxBytes } = data;
  const full = usedBytes >= maxBytes;
  const ceilingPlan = PLANS.find((p) => entitlementsOf(p).maxBytes === maxBytes);
  return {
    readout: {
      text: `${formatStorageBytes(usedBytes)} of ${formatStorageCeiling(maxBytes)} used`,
      fraction: Math.min(1, usedBytes / maxBytes),
      full,
      note: full ? NOTE_FULL : NOTE_STORAGE,
      kept:
        ceilingPlan && ceilingPlan !== plan
          ? `Your ${formatStorageCeiling(maxBytes)} of storage comes from your earlier ${PLAN_LABELS[ceilingPlan]} plan.`
          : null,
    },
    settled,
  };
}
