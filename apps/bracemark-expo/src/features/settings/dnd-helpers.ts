// The expo half of the Lists drag-and-drop pair — the mirror of bracemark-web's
// `_lists/dnd-helpers.ts`, and the same shape tree-helpers.ts has: the projection
// math is pure shape and identical on both platforms, so it lives in
// `@stxapps/shared` (`sync/tree-dnd.ts`); what stays here is what's genuinely
// this platform's — the px indent and the options every call site passes.
//
// The drag layer itself (gesture + animation) is drag-sort.tsx; this module is
// only the arithmetic's platform calibration.

import { LIST_NO_CHILDREN_IDS, type ProjectionOptions } from '@stxapps/shared';

export { excludeActiveDescendants, getMovePlan, getProjection } from '@stxapps/shared';

// Px per indent level. The rows render their indent from this same constant
// (lists-section's Row), so the visible indent and the drag math can't drift.
// Narrower than web's 20 — a phone has less width to spend, and this is also
// the tree indent the section already used before it could be dragged.
export const INDENT_WIDTH = 16;

// What every projection/plan call on this screen passes.
//
// `stepThreshold` is the touch calibration, and the reason the option exists: a
// finger dragging vertically jitters horizontally by several px the whole way,
// so web's plain rounding (change level at HALF an indent — right for a precise
// pointer) would reparent rows by accident here. Three quarters of an indent —
// 12px — is past the jitter but still an easy, deliberate nudge.
export const PROJECTION_OPTIONS: ProjectionOptions = {
  indentWidth: INDENT_WIDTH,
  noChildrenIds: LIST_NO_CHILDREN_IDS,
  stepThreshold: 0.75,
};
