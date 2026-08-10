import type { LinkSortOn } from '@stxapps/shared';
import type { LinkView } from '@stxapps/web-react';

export interface LinkLayoutProps {
  // Display-resolved rows (link joined with its extraction): `link.title` /
  // `link.imageId` are the override-wins resolved values — see LinkView.
  links: LinkView[];
  // The RESOLVED sort field the rows are ordered by (URL override ?? synced
  // setting — page-provider computes it). The date column shows THIS field's
  // timestamp so the visible dates read in row order; see list-layout.
  sortOn: LinkSortOn;
  // Leading `pinnedCount` entries of `links` are pinned, in pin-rank order (top
  // first). A row at index `i` is pinned iff `i < pinnedCount`; it's the topmost
  // pin at `i === 0` and the bottom pin at `i === pinnedCount - 1`.
  pinnedCount: number;
  hasMore: boolean;
  showMore: () => void;
  isLoading: boolean;
  // A background sync has newer results being held back; render the RefreshPill.
  hasPending: boolean;
  // Swap the held results in (the pill's click also scrolls the layout to top).
  applyPending: () => void;
}
