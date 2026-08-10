// Live read of the plan's saved-link cap against the local library — the expo
// port of web-react's use-link-quota (that header is canonical: this gate IS
// the enforcement of the free tier's 200-link wall, since bracemark-api's
// `files/sign` keeps only the byte/object backstop; a stale entitlement fails
// open; and `count` is trash-INCLUSIVE, every `links/` record including trashed
// ones, a rule shared with import-all-data's cap check and the share sheet's
// isAtLinkCap). The count is `countLinks` (queries.ts), live over `items` via
// useLiveRead.

import { useMemo } from 'react';

import { countLinks } from '../data/queries';
import { useEntitlements } from './use-entitlements';
import { useLiveRead } from './use-live-read';

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
  const count = useLiveRead(() => countLinks(), [], ['items']) ?? 0;

  return useMemo(() => ({ count, max, atLimit: max !== null && count >= max }), [count, max]);
}
