// Pure drag-and-drop math for a settings tree (lists on both platforms; the flat
// tag table uses only `arrayMove`). Turns "the user is dragging row A over row B,
// N px to the right" into the two things a drag surface actually needs: a
// projected DEPTH (to draw the row at its would-be indent mid-drag) and, on drop,
// a concrete `move(item, parentId, siblings, index)` plan. No React, no gesture
// library — just shape, so it's unit-testable in isolation and identical on web
// (dnd-kit) and expo (gesture-handler + reanimated).
//
// The approach is the canonical dnd-kit "sortable tree" one: never drag a nested
// tree, drag a flat list and PROJECT the horizontal offset onto a depth, clamped
// to what the neighbours allow. The vertical axis (between rows) is plain
// sortable reordering; the horizontal axis (indent = parent) is this projection.
//
// This lived in bracemark-web's `_lists/dnd-helpers.ts` until bracemark-expo grew a drag
// surface of its own — the same hoist `flattenToRows`/`childrenOf` made into
// tree.ts, and for the same reason: the forest shape is platform-independent,
// only the px constants and the gesture plumbing aren't.

import { LIST_NO_CHILDREN_IDS } from './system-lists';
import { childrenOf, type TreeItem, type TreeNode, type TreeRow } from './tree';

export interface Projection {
  depth: number;
  parentId: string | null;
}

// A concrete drop: feed straight into `move(item, parentId, siblings, index)`.
// `depth` is carried for the drop indicator / final indent.
export interface MovePlan<T extends TreeItem> {
  item: T;
  parentId: string | null;
  siblings: T[];
  index: number;
  depth: number;
}

export interface ProjectionOptions {
  // Px per indent level. Each platform owns its own constant and renders its rows
  // from the same one, so the visible indent and the drag math can't drift
  // (web: 20, expo: 16). The drag offset arrives in px, so the projection thinks
  // in px too.
  indentWidth?: number;
  // Ids that may not be a PARENT — they can sit above the dragged row without
  // granting it the usual +1 level. Defaults to the list containers (Trash); a
  // tag tree can pass an empty set, or just accept the harmless default since no
  // tag id collides with TRASH_ID (the same convention `forbiddenParentIds` uses).
  noChildrenIds?: ReadonlySet<string>;
  // How far into an indent step the drag must travel before the level changes,
  // as a fraction of `indentWidth`. 0.5 is plain rounding — a pointer's natural
  // behaviour, and what web uses. Touch wants more: a finger dragging vertically
  // jitters horizontally by several px the whole way, and at 0.5 that jitter
  // reparents rows by accident, so expo asks for 0.75 of an indent.
  stepThreshold?: number;
}

const DEFAULT_INDENT_WIDTH = 20;

// Move one element within an array, returning a new one. Tiny, but every drag
// surface needs it (it's dnd-kit's `arrayMove`, which we no longer import) — and
// the flat tag table needs nothing else from this module.
export function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Drop the active row's whole subtree out of the flat list while it's being
// dragged: a node's descendants are the contiguous run of following rows with a
// greater depth (flattenToRows is depth-first), so the row's children travel with
// it and can never become its own drop target. Returns the rows unchanged when
// nothing is being dragged.
export function excludeActiveDescendants<T extends TreeItem>(
  rows: TreeRow<T>[],
  activeId: string | null,
): TreeRow<T>[] {
  if (activeId === null) return rows;

  const activeIndex = rows.findIndex((row) => row.item.id === activeId);
  if (activeIndex === -1) return rows;

  const activeDepth = rows[activeIndex].depth;
  let end = activeIndex + 1;
  while (end < rows.length && rows[end].depth > activeDepth) end++;
  return [...rows.slice(0, activeIndex + 1), ...rows.slice(end)];
}

// Horizontal offset → whole indent steps, with a configurable threshold.
// `Math.sign(x) * Math.floor(|x| / w + (1 - t))` is Math.round(x / w) at t = 0.5,
// and demands a longer pull as t rises. Symmetric in both directions.
function dragSteps(offsetX: number, indentWidth: number, threshold: number): number {
  const steps = Math.floor(Math.abs(offsetX) / indentWidth + (1 - threshold));
  return offsetX < 0 ? -steps : steps;
}

// Project the horizontal drag offset onto a depth, clamped to what the row's new
// neighbours permit, and resolve the parent that depth implies. `rows` must
// already have the active subtree excluded (see above), so the previous row can
// never be a descendant of the active row — self-parenting is structurally
// impossible and needs no extra guard.
export function getProjection<T extends TreeItem>(
  rows: TreeRow<T>[],
  activeId: string,
  overId: string,
  offsetX: number,
  options?: ProjectionOptions,
): Projection {
  const indentWidth = options?.indentWidth ?? DEFAULT_INDENT_WIDTH;
  const noChildrenIds = options?.noChildrenIds ?? LIST_NO_CHILDREN_IDS;
  const stepThreshold = options?.stepThreshold ?? 0.5;

  const overIndex = rows.findIndex((row) => row.item.id === overId);
  const activeIndex = rows.findIndex((row) => row.item.id === activeId);
  if (overIndex === -1 || activeIndex === -1) return { depth: 0, parentId: null };

  const newRows = arrayMove(rows, activeIndex, overIndex);
  const prev = newRows[overIndex - 1] as TreeRow<T> | undefined;
  const next = newRows[overIndex + 1] as TreeRow<T> | undefined;
  const active = rows[activeIndex];

  const projected = active.depth + dragSteps(offsetX, indentWidth, stepThreshold);

  // A no-children container (Trash) can sit beside the row but never adopt it, so
  // it doesn't grant the usual +1 level.
  const maxDepth = prev ? (noChildrenIds.has(prev.item.id) ? prev.depth : prev.depth + 1) : 0;
  const minDepth = next ? next.depth : 0;

  let depth = projected;
  if (projected >= maxDepth) depth = maxDepth;
  else if (projected < minDepth) depth = minDepth;

  return { depth, parentId: resolveParentId(newRows, overIndex, depth, prev) };
}

// The parent implied by a depth at a flat position: same depth as the previous
// row ⇒ same parent; one deeper ⇒ the previous row itself; shallower ⇒ walk back
// to the nearest row already at that depth and borrow its parent. Root at depth 0.
function resolveParentId<T extends TreeItem>(
  newRows: TreeRow<T>[],
  overIndex: number,
  depth: number,
  prev: TreeRow<T> | undefined,
): string | null {
  if (depth === 0 || !prev) return null;
  if (depth === prev.depth) return prev.parentId;
  if (depth > prev.depth) return prev.item.id;
  const shallower = newRows
    .slice(0, overIndex)
    .reverse()
    .find((row) => row.depth === depth);
  return shallower ? shallower.parentId : null;
}

// Resolve the drag into a ready-to-execute move. `nodes` is the live tree (for the
// destination sibling group), `rows` the active-subtree-excluded flat list. The
// index is how many of the destination's children already sit above the drop —
// counted from the post-move flat order, so it lines up with the sibling group
// `move` will re-rank against.
export function getMovePlan<T extends TreeItem>(
  nodes: TreeNode<T>[],
  rows: TreeRow<T>[],
  activeId: string,
  overId: string,
  offsetX: number,
  options?: ProjectionOptions,
): MovePlan<T> | null {
  const activeIndex = rows.findIndex((row) => row.item.id === activeId);
  const overIndex = rows.findIndex((row) => row.item.id === overId);
  if (activeIndex === -1 || overIndex === -1) return null;

  const { depth, parentId } = getProjection(rows, activeId, overId, offsetX, options);
  const item = rows[activeIndex].item;
  const newRows = arrayMove(rows, activeIndex, overIndex);

  const siblings = childrenOf(nodes, parentId).filter((sibling) => sibling.id !== activeId);
  let index = 0;
  for (let i = 0; i < overIndex; i++) {
    if (newRows[i].parentId === parentId) index++;
  }

  return { item, parentId, siblings, index, depth };
}
