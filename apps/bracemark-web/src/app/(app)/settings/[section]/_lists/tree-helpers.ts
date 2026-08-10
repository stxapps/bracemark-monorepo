// Tree → rows helpers for the Lists settings page. The forest-shape logic is
// generic and shared with bracemark-expo's settings, so it lives in `@stxapps/shared`
// (`sync/tree.ts`, next to buildTree/flattenTree); this module just specializes
// it to `ListItem` and names the row `ListRow` for the table's call sites.
//
// - `flattenToRows` — forest → flat, depth-tagged rows (skipping collapsed
//   subtrees), each carrying its sibling group + index so the reorder controls
//   need no second walk.
// - `childrenOf` — the ordered child items of a parent (a "move to" destination).
// - `forbiddenParentIds` — ids a list may not move under (itself, its subtree,
//   Trash).

import type { ListItem, TreeRow } from '@stxapps/shared';

export { childrenOf, flattenToRows, forbiddenParentIds } from '@stxapps/shared';

export type ListRow = TreeRow<ListItem>;
