'use client';

// Live read of the plan's saved-link cap against the local library — what the
// create surfaces (bracemark-web's quick-add popover, the extension popup's editor)
// gate on before they let a save through.
//
// THIS IS THE ENFORCEMENT of the free tier's 200-link wall. Nothing behind it
// counts links: bracemark-api's `files/sign` gate keeps only the byte/object
// backstop (lib/quota.ts), so a save that gets past here syncs and stays. That
// was a deliberate trade. The cap is the one
// COST-DEFENSIVE limit whose bypass costs ~nothing to serve (200 links of
// metadata is a few hundred KB, and maxBytes still bounds it server-side),
// while enforcing it blind cost a create-vs-update existence check on every
// sign batch, a partial-push retry in the sync engine, and a whole sync state
// for "some of your changes are refused". Honor-system here buys all of that
// back. What it costs is real and accepted: devtools, or a patched extension
// build, walks through it.
//
// So a stale or missing entitlement fails OPEN (useEntitlements serves the
// device-local last-known copy), which is the right direction — telling a
// paying customer their library is full is worse than one link over the cap.
//
// `count` is trash-INCLUSIVE: every `links/` record, including trashed ones.
// Trash is a listId, not a deletion — a trashed link still has its
// `links/{id}.enc` blob. That rule is shared with readExistingLinks
// (data/import-all-data.ts) and the share sheet's isAtLinkCap (expo-react
// data/share-store.ts); all three must agree, or the surfaces disagree with
// each other about when the library is full.
//
// The querier is a single direct Dexie call (no async helper hops), so
// liveQuery's dependency tracking is safe.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { LINKS_PREFIX } from '@stxapps/shared';

import { db } from '../data/db';
import { useEntitlements } from './use-entitlements';

export interface LinkQuota {
  // Links in the local store, counted the server's way (incl. trashed). 0 until
  // the first read resolves.
  count: number;
  // The plan's cap; null = unlimited (every paid plan).
  max: number | null;
  // Whether a new link would be refused. False while unlimited.
  atLimit: boolean;
}

export function useLinkQuota(): LinkQuota {
  const { entitlements } = useEntitlements();
  const max = entitlements.maxLinks;
  const count =
    useLiveQuery(() => db.items.where('path').startsWith(LINKS_PREFIX).count(), [], 0) ?? 0;

  return useMemo(() => ({ count, max, atLimit: max !== null && count >= max }), [count, max]);
}
