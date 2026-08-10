// The web half of the Lists drag-and-drop pair. The projection math itself is
// pure shape and identical on both platforms, so it lives in `@stxapps/shared`
// (`sync/tree-dnd.ts`, next to the tree helpers it builds on) — the same hoist
// tree-helpers.ts made when bracemark-expo grew its own settings table. What stays
// here is what's genuinely web's: the px indent constant and the options every
// call site passes with it.
//
// See the shared module for the approach (drag a flat list, project the
// horizontal offset onto a depth). bracemark-expo's mirror is
// `features/settings/dnd-helpers.ts`.

import { LIST_NO_CHILDREN_IDS, type ProjectionOptions } from '@stxapps/shared';

export {
  excludeActiveDescendants,
  getMovePlan,
  getProjection,
  type MovePlan,
  type Projection,
} from '@stxapps/shared';

// Px per indent level — the single source of truth for the tree's indent. dnd-kit
// reports the drag offset in px, so the projection thinks in px; the rows render
// their indent from this same constant (lists-section) so the visible indent and
// the drag math can never drift. 20px ≈ 1.25rem.
export const INDENT_WIDTH = 20;

// What every projection/plan call on this page passes. No `stepThreshold`: a
// pointer is precise, so plain rounding at half an indent is the right feel
// (expo's touch surface raises it — see its mirror of this file).
export const PROJECTION_OPTIONS: ProjectionOptions = {
  indentWidth: INDENT_WIDTH,
  noChildrenIds: LIST_NO_CHILDREN_IDS,
};
