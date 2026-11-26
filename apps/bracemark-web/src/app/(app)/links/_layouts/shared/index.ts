// Bits common to both link layouts: the props contract, shared hooks, the row's
// media/tag/action widgets, and the layout chrome. Each layout owns its own
// scroll container + virtualizer (row geometry differs per layout), so this
// folder is deliberately just the shared parts, not a base component.

export { addressText, listNameFor, rowDate, TITLE_CLAMP } from './fields';
export {
  measureRowHeight,
  remeasureAll,
  useListNameMap,
  useReportDisplayedLinkPaths,
  useRestoreReturnRow,
  useScrollTopOnQuery,
  useTagMap,
} from './hooks';
export { EmptyState, RefreshPill, ShowMore } from './layout-chrome';
export { Favicon, LinkPreviewImage } from './link-media';
export { LinkRowMenu } from './link-row-menu';
export { KeptCopyBadge, LinkRowSelect, NoteBadge, PinnedBadge } from './link-row-widgets';
export { hasKnownTags, LinkTagChips } from './link-tag-chips';
export type { LinkLayoutProps } from './types';
