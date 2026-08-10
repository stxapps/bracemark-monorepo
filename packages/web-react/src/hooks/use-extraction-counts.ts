'use client';

// Live EXACT extraction-progress counts (done / pending / failed for `titleImage`,
// trash-corrected — readExtractionFacetCounts) for the surfaces that DISPLAY them:
// the Settings extraction section's stats and the "Generate all N pending?" confirm.
// Deliberately a hook mounted on demand, NOT part of the always-on ExtractionProvider:
// exactness costs the O(trash) link↔extraction join (readTrashedTitleImageCounts),
// and a liveQuery re-runs its querier on every `db.items` transaction — so the join
// runs only while a surface is actually showing the numbers, never on the provider's
// wake path (which uses the raw over-count instead; see readRawPendingTitleImageCount).
// Zeros while extraction is disabled or before the first read resolves. The querier
// pass-through-returns the async read (no stacked await), so liveQuery's dependency
// tracking is safe — see readLinks' zone-echo note.

import { useLiveQuery } from 'dexie-react-hooks';

import { useExtraction } from '../contexts/extraction-provider';
import { type ExtractionFacetCounts, readExtractionFacetCounts } from '../data/queries';

const EMPTY_COUNTS: ExtractionFacetCounts = { done: 0, pending: 0, failed: 0 };

export function useExtractionCounts(): ExtractionFacetCounts {
  const { enabled } = useExtraction();
  return (
    useLiveQuery(
      () => (enabled ? readExtractionFacetCounts() : Promise.resolve(EMPTY_COUNTS)),
      [enabled],
    ) ?? EMPTY_COUNTS
  );
}
