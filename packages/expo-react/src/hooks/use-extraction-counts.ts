// Live EXACT extraction-progress counts (done / pending / failed for `titleImage`,
// trash-corrected) — the expo port of web-react's hooks/use-extraction-counts.ts, and
// mounted on demand for the same reason: exactness costs the trash-correction join
// (readTrashedTitleImageCounts), and a live read re-runs on every `items` transaction, so
// the join must run only while a surface is actually showing the numbers — never on the
// always-on provider's wake path, which uses the raw over-count instead.
//
// The one divergence is the reactivity primitive: `useLiveRead` over the two extraction
// wake tables rather than Dexie's liveQuery (the read runs several statements, which
// drizzle's own useLiveQuery can't subscribe). Zeros while extraction is disabled or
// before the first read resolves.

import { useExtraction } from '../contexts/extraction-provider';
import { type ExtractionFacetCounts, readExtractionFacetCounts } from '../data/queries';
import { useLiveRead } from './use-live-read';

const EMPTY_COUNTS: ExtractionFacetCounts = { done: 0, pending: 0, failed: 0 };

export function useExtractionCounts(): ExtractionFacetCounts {
  const { enabled } = useExtraction();
  return (
    useLiveRead(
      () => (enabled ? readExtractionFacetCounts() : Promise.resolve(EMPTY_COUNTS)),
      [enabled],
      ['items', 'item_facet_statuses'],
    ) ?? EMPTY_COUNTS
  );
}
