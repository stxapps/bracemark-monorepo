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
import {
  childrenOf,
  deepestDepthFor,
  findNode,
  type TreeItem,
  type TreeNode,
  type TreeRow,
} from './tree';

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
  // The deepest depth the dragged row may land at — `deepestDepthFor(nodes,
  // activeId)` (tree.ts), the TREE_MAX_DEPTH rule. The flat rows can't say it:
  // the dragged row's subtree is excluded from them and a collapsed one was
  // never in them. Only the live indent reads it from here; getMovePlan works it
  // out from the forest itself, so a drop can't pass the limit if a caller
  // leaves it out.
  maxDepth?: number;
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
  // it doesn't grant the usual +1 level. Nor may the row go deeper than the depth
  // rule lets its subtree reach. Where that is shallower than the next row needs,
  // minDepth wins — the row can't land above a deeper row without adopting it —
  // and the drop is past the limit, which getMovePlan refuses.
  const maxDepth = Math.min(
    prev ? (noChildrenIds.has(prev.item.id) ? prev.depth : prev.depth + 1) : 0,
    options?.maxDepth ?? Infinity,
  );
  const minDepth = next ? next.depth : 0;

  const depth = Math.max(Math.min(projected, maxDepth), minDepth);

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
// `move` will re-rank against. Null for a drop that would put the row's subtree
// past TREE_MAX_DEPTH: the row eases home, as for any drop that changes nothing.
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

  const maxDepth = deepestDepthFor(nodes, activeId);
  const { depth, parentId } = getProjection(rows, activeId, overId, offsetX, {
    ...options,
    maxDepth,
  });
  if (depth > maxDepth) return null;
  const item = rows[activeIndex].item;
  const newRows = arrayMove(rows, activeIndex, overIndex);

  const siblings = childrenOf(nodes, parentId).filter((sibling) => sibling.id !== activeId);
  let index = 0;
  for (let i = 0; i < overIndex; i++) {
    if (newRows[i].parentId === parentId) index++;
  }

  return { item, parentId, siblings, index, depth };
}

// The forest as it will read once `plan` has been written: the node lifted out
// of wherever it sits and set down under `plan.parentId` at `plan.index` (counted
// among the destination's OTHER children, as the plan counts it), its subtree's
// depths rewritten to match. This is the half of a drop a surface needs when it
// has no pose to hold — web's dnd-kit drops its transforms in the render the drop
// lands in, so the new order has to be in that render too, ahead of the write and
// the live read that will confirm it (docs/editors.md). Returns `nodes` itself
// when the plan no longer fits the forest — the node or its destination is gone —
// so a caller comparing the two sees "nothing to show".
export function applyMovePlan<T extends TreeItem>(
  nodes: TreeNode<T>[],
  plan: Pick<MovePlan<T>, 'item' | 'parentId' | 'index'>,
): TreeNode<T>[] {
  const id = plan.item.id;

  const lifted = findNode(nodes, id);
  if (lifted === undefined) return nodes;

  // A fresh copy of everything else, so the set-down below can splice into it.
  const rest = copyForest(nodes, { skipId: id });
  const setDown = (group: TreeNode<T>[], depth: number): void => {
    group.splice(plan.index, 0, ...copyForest([lifted], { depth }));
  };
  if (plan.parentId === null) {
    setDown(rest, 0);
    return rest;
  }

  // Looked up in `rest`, so a destination inside the lifted subtree is not found.
  const parent = findNode(rest, plan.parentId);
  if (parent === undefined) return nodes;
  setDown(parent.children, parent.depth + 1);
  return rest;
}

// A deep copy of a forest, on its own stack (the tree is as deep as the
// library's `parentId` chain — tree.ts). `skipId` leaves that node and its
// subtree out; `depth` re-roots the copy at that depth, each level one deeper,
// and without it every node keeps the depth it had.
function copyForest<T extends TreeItem>(
  nodes: TreeNode<T>[],
  options: { skipId?: string; depth?: number },
): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const pending: { from: TreeNode<T>[]; into: TreeNode<T>[]; depth: number | undefined }[] = [
    { from: nodes, into: out, depth: options.depth },
  ];
  for (let group = pending.pop(); group !== undefined; group = pending.pop()) {
    for (const node of group.from) {
      if (node.item.id === options.skipId) continue;
      const copy: TreeNode<T> = { ...node, depth: group.depth ?? node.depth, children: [] };
      group.into.push(copy);
      if (node.children.length > 0) {
        pending.push({
          from: node.children,
          into: copy.children,
          depth: group.depth === undefined ? undefined : group.depth + 1,
        });
      }
    }
  }
  return out;
}
