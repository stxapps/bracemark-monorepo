// Turn a flat set of ranked, parented entities (lists or tags — entities.ts) into
// an ordered forest for the UI. Pure and entity-agnostic: it knows only the three
// structural fields, so lists and tags share it (and a tag set that never nests
// just comes back as one flat ranked level).
//
// Every rule here is a READ-TIME reconciliation of what last-writer-wins can
// leave behind — the same spirit as "a dangling reference is NORMAL, the UI skips
// it" elsewhere. Two devices editing different files concurrently can produce a
// `parentId` that points at a deleted entity, forms a cycle, or names a
// forbidden parent; none of that may crash or hide an entity, so each is folded
// back to a root placement. Given identical input the output is identical on
// every device (sibling order is by `rank`, ties broken by `id`; a cycle is cut
// at an edge chosen by id alone), so two devices render the same tree.
//
// NOTHING IN THIS FILE RECURSES, and that is a rule rather than a style. A tree
// is as deep as its `parentId` chain, and the chain is data: a backup restores
// `parentId` verbatim and another device can sync any chain at all, so depth is
// decided outside this device. `useLists` builds the tree in render and the lock
// provider reads it above every signed-in screen, so a walk that used one call
// frame per level turned one deep chain into a stack overflow that took the whole
// app down with it — on every launch, since the chain is stored. Every walk here
// keeps its own stack on the heap instead. (An import's folder chain is bounded
// separately, import/resolve.ts; that bound covers what an import mints, not what
// is already stored.)
//
// ONE NODE PER ID, for the same reason: how many nodes a forest holds must not be
// data either. Parents are resolved by id, so two items sharing an id were both
// children of one parent and both parents of everything naming them — each copy
// of a level got its own copy of the level below, and a chain of repeated ids
// multiplied at every step: twenty records, two to an id and ten deep, built two
// thousand nodes, and each further level doubled that. So an id is placed once,
// and a forest is never larger than the set it was built from. The read edges
// take a list's and a tag's id from its PATH (`withPathId`, items.ts), which
// is unique, so nothing stored is hidden by this; it is the backstop for a caller
// holding a set that never went through one — the marketing site's converter
// reading a backup that repeats a line. The LAST item with an id is the one
// placed, which follows input order: the one thing here that does, and only for
// input that already broke the contract.

import { compareRank } from './rank';
import { LIST_NO_CHILDREN_IDS } from './system-lists';

// The structural contract an entity must satisfy to be tree-able. Any `T` with
// these fields works; the node carries the whole `T` so the UI keeps its `path`,
// `name`, timestamps, etc.
export interface TreeItem {
  id: string;
  parentId: string | null;
  rank: string;
}

export interface TreeNode<T extends TreeItem> {
  item: T;
  // 0 at the root, +1 per level — the UI's indentation depth.
  depth: number;
  children: TreeNode<T>[];
}

export interface BuildTreeOptions {
  // Ids that may not be a PARENT (they can still be children). Anything naming
  // one of these as its `parentId` is promoted to root. For lists this is
  // `{TRASH_ID}` — Trash is a leaf container, nothing nests inside it.
  noChildrenIds?: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// The deepest a list or tag tree may be made: TREE_MAX_DEPTH levels, a root
// (`depth` 0) being level 1. A rule for the doors that MAKE a tree — the
// editors refuse a move past it, an import and a restore place what is deeper
// at it, an interop export writes it no deeper — and never for the ones that
// read one: nothing here refuses or trims a deeper stored chain, which sync can
// always deliver (two devices' moves can each be legal and meet past it).
// Far past any real library — browsers and their users stop within a dozen
// levels — which is the point: the bound should never be met by a real one.
// docs/data-limits.md.
export const TREE_MAX_DEPTH = 100;

export function buildTree<T extends TreeItem>(
  items: T[],
  options?: BuildTreeOptions,
): TreeNode<T>[] {
  const noChildren = options?.noChildrenIds ?? EMPTY_SET;
  // Last wins on a repeated id — and from here on the walk is over `byId`, never
  // `items`, which is what makes the forest one node per id (header).
  const byId = new Map(items.map((i) => [i.id, i]));

  // Resolve each entity's EFFECTIVE parent: null (root) when the declared parent
  // is null, missing (orphan), or a forbidden (no-children) id.
  const parentOf = new Map<string, string | null>();
  for (const item of byId.values()) {
    const p = item.parentId;
    parentOf.set(item.id, p !== null && byId.has(p) && !noChildren.has(p) ? p : null);
  }

  breakCycles(parentOf);

  // Group by effective parent, then assemble top-down, sorting each sibling group.
  const childrenOf = new Map<string | null, T[]>();
  for (const item of byId.values()) {
    const p = parentOf.get(item.id) ?? null;
    const group = childrenOf.get(p);
    if (group) group.push(item);
    else childrenOf.set(p, [item]);
  }

  const nodesUnder = (parentId: string | null, depth: number): TreeNode<T>[] =>
    (childrenOf.get(parentId) ?? [])
      .slice()
      .sort(compareRank)
      .map((item) => ({ item, depth, children: [] }));

  const roots = nodesUnder(null, 0);
  const pending = roots.slice();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    node.children = nodesUnder(node.item.id, node.depth + 1);
    for (const child of node.children) pending.push(child);
  }
  return roots;
}

// Break cycles: an entity that can't reach a root by following effective parents
// runs into a loop, so some edges are cut (the entity becomes a root) until
// every entity reaches one. WHICH edges is part of the contract — two devices
// must cut the same ones — and it is defined by a scan this function no longer
// performs literally: take the ids in sorted order, and detach each one whose
// walk, at its turn, does not reach a root. That scan re-walked the chain from
// every id, which is quadratic in the depth, so one long chain cost as much as a
// large library.
//
// What the scan computes has a closed form, and this is it. Say an entity's
// walk "runs into a cycle" when following parents from it never ends. Then:
//
//  - of a cycle's own members, exactly the least id is detached — it is the
//    first of them the scan reaches, and once it is a root the others reach it;
//  - an entity on a TAIL leading into a cycle is detached exactly when its id is
//    less than every id after it on its walk (the rest of the tail and the whole
//    cycle) — otherwise something nearer the cycle was detached first, and the
//    walk now ends there.
//
// So one number per entity settles it: `floor`, the least id on its walk from
// itself onward, or null when the walk reaches a root. Each entity is walked
// once. tree.spec.ts holds the sorted scan as an oracle and compares the two on
// generated graphs, cycles with tails included.
function breakCycles(parentOf: Map<string, string | null>): void {
  const floor = new Map<string, string | null>();
  // Position of an id on the walk in progress. Never cleared: an id left over
  // from an earlier walk is already in `floor`, which is tested first.
  const onWalk = new Map<string, number>();
  const detached: string[] = [];

  for (const start of parentOf.keys()) {
    if (floor.has(start)) continue;

    const walk: string[] = [];
    let cur: string | null = start;
    while (cur !== null && !floor.has(cur) && !onWalk.has(cur)) {
      onWalk.set(cur, walk.length);
      walk.push(cur);
      cur = parentOf.get(cur) ?? null;
    }

    // What the walk ran into: a root, an entity already settled, or itself.
    let least: string | null;
    let tailLength = walk.length;
    if (cur === null) {
      least = null;
    } else if (floor.has(cur)) {
      least = floor.get(cur) ?? null;
    } else {
      tailLength = onWalk.get(cur) ?? 0;
      least = walk[tailLength];
      for (let i = tailLength + 1; i < walk.length; i++) if (walk[i] < least) least = walk[i];
      for (let i = tailLength; i < walk.length; i++) floor.set(walk[i], least);
      detached.push(least);
    }

    // Back down the tail, nearest the cycle first.
    for (let i = tailLength - 1; i >= 0; i--) {
      const id = walk[i];
      if (least !== null && id < least) {
        detached.push(id);
        least = id;
      }
      floor.set(id, least);
    }
  }

  for (const id of detached) parentOf.set(id, null);
}

// Visit every node of a forest depth-first — a parent before its children,
// siblings in order: the order the UI renders rows in. `each` returns true to
// stop the walk. The one traversal the readers below share, on its own stack.
function visit<T extends TreeItem>(
  nodes: TreeNode<T>[],
  each: (node: TreeNode<T>) => boolean | void,
): void {
  const pending: TreeNode<T>[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) pending.push(nodes[i]);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (each(node) === true) return;
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
}

// Flatten a forest back to a depth-first list — the order the UI renders rows in,
// each row already carrying its `depth`. Saves every consumer rewriting the same
// walk just to map over nodes.
export function flattenTree<T extends TreeItem>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  visit(nodes, (node) => {
    out.push(node);
  });
  return out;
}

// --- projections over a forest -------------------------------------------------
// The walks below all follow the same depth-first shape as flattenTree, but each
// carries a different accumulator (a name map, ancestor names, sibling groups),
// so flattenTree — which only yields the nodes — can't express them. They lived
// hand-rolled and duplicated across web and expo before landing here.

// Forest → id→name map: the projection every "resolve a tag/list id to its
// display name" surface needs (the link tag chips' tagsById, the tags-field's
// chosen-chip labels). Live at the call site, so a rename repaints immediately.
export function treeNameMap<T extends TreeItem & { name: string }>(
  nodes: TreeNode<T>[],
): Map<string, string> {
  const map = new Map<string, string>();
  visit(nodes, (node) => {
    map.set(node.item.id, node.item.name);
  });
  return map;
}

// The most levels one ROW describes: the ancestor names in a path row below, and
// the guide lines a picker draws for a row's indent (web-ui's ListCommand, expo's
// guide-lines.tsx). Both are paid per row and both used to be the row's whole
// depth, so one long `parentId` chain cost the SQUARE of its length — a 10,000-
// deep chain held 600 MB of ancestor names before a picker had drawn anything.
// Nothing here recursed, so the app launched; the bill came when a picker opened.
//
// A bound on what a row SHOWS, never on the tree: the row keeps its true `depth`
// and the forest under it is untouched, which is the only place a display limit
// may live (lock coverage reads the real forest — lock-coverage.ts). A row with
// 32 ancestors or fewer is unchanged by it. A deeper row's label ends in the cut
// marker in place of its nearest ancestors — one truncated line where it is
// drawn, and read out whole where expo's ListSelect makes it an accessibility
// label — and its indent stays at 32 guide lines, 768px of it.
export const TREE_ROW_MAX_LEVELS = 32;

// Stands in for the names a path row leaves out past TREE_ROW_MAX_LEVELS, so a
// cut path reads "Work / … / Recipes" rather than naming the wrong parent.
export const TREE_PATH_CUT = '…';

// One flattened row carrying the ANCESTOR NAMES on the path down to it — the path
// label the list pickers show on filtered rows ("Work / Cooking / Recipes") and
// on ListSelect's trigger. `flattenTree` yields `depth` but not the names, which
// is the whole reason this richer walk exists.
export interface TreePathRow<T extends TreeItem & { name: string }> {
  item: T;
  depth: number;
  // Root first. Every ancestor's name down to TREE_ROW_MAX_LEVELS of them; a row
  // deeper than that gets the first TREE_ROW_MAX_LEVELS and then TREE_PATH_CUT.
  ancestors: string[];
}

// Flatten a forest depth-first, annotating each row with its ancestors' names.
// `excludeIds` drops a row entirely (Trash in the editors, or the reparent
// dialog's forbidden subtree) — every such id is a no-children leaf or has its
// whole subtree in the set, so nothing gets orphaned; the walk still descends so
// the exclusion never truncates unrelated branches.
export function flattenToPathRows<T extends TreeItem & { name: string }>(
  nodes: TreeNode<T>[],
  excludeIds?: readonly string[],
): TreePathRow<T>[] {
  const out: TreePathRow<T>[] = [];
  const excluded = new Set(excludeIds);
  const pending: { node: TreeNode<T>; ancestors: string[] }[] = [];
  const root: string[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) pending.push({ node: nodes[i], ancestors: root });
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, ancestors } = next;
    if (!excluded.has(node.item.id)) {
      out.push({ item: node.item, depth: node.depth, ancestors });
    }
    if (node.children.length === 0) continue;
    // One array per PARENT, shared by its children's rows — and once the path is
    // cut, one array for everything below, however far down that goes.
    const below =
      ancestors.length < TREE_ROW_MAX_LEVELS
        ? [...ancestors, node.item.name]
        : ancestors.length === TREE_ROW_MAX_LEVELS
          ? [...ancestors, TREE_PATH_CUT]
          : ancestors;
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], ancestors: below });
    }
  }
  return out;
}

// A forest without the subtrees rooted at `ids` — the sidebar's "drop the hidden
// lists" (a hidden parent takes its subtree with it structurally). Returns
// `nodes` itself when there is nothing to drop, so a memo keyed on it holds.
export function withoutSubtrees<T extends TreeItem>(
  nodes: TreeNode<T>[],
  ids: ReadonlySet<string>,
): TreeNode<T>[] {
  if (ids.size === 0) return nodes;
  const out: TreeNode<T>[] = [];
  const pending: { from: TreeNode<T>[]; into: TreeNode<T>[] }[] = [{ from: nodes, into: out }];
  for (let group = pending.pop(); group !== undefined; group = pending.pop()) {
    for (const node of group.from) {
      if (ids.has(node.item.id)) continue;
      if (node.children.length === 0) {
        group.into.push(node);
        continue;
      }
      const copy: TreeNode<T> = { ...node, children: [] };
      group.into.push(copy);
      pending.push({ from: node.children, into: copy.children });
    }
  }
  return out;
}

// --- settings-table row helpers ------------------------------------------------
// The Lists settings table renders a flat, depth-tagged row list and asks
// positional questions of it ("who are my siblings?", "where can I move?"). Pure
// shape, no React — shared verbatim by bracemark-web and bracemark-expo's settings.

// One rendered row: the item plus everything the row's controls need without a
// second tree walk. `siblings` is the row's ordered sibling group INCLUDING
// itself (so `index`/`siblings.length` answer "am I first/last?"); `parentId` is
// the EFFECTIVE parent in the rendered tree (null at the root), which can differ
// from `item.parentId` when buildTree promoted a dangling/forbidden parent to the
// root — reorder must target where the row actually sits.
export interface TreeRow<T extends TreeItem> {
  item: T;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  siblings: T[];
  index: number;
}

// Flatten the forest depth-first (parent before children), skipping the subtree
// under any id in `collapsedIds`. Order matches the sidebar exactly. The richer
// forest → `TreeRow[]` variant of `flattenTree` the settings table renders.
export function flattenToRows<T extends TreeItem>(
  nodes: TreeNode<T>[],
  collapsedIds: ReadonlySet<string>,
): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  // One frame per open sibling group, with how far through it the walk is.
  interface Frame {
    group: TreeNode<T>[];
    siblings: T[];
    parentId: string | null;
    index: number;
  }
  const open = (group: TreeNode<T>[], parentId: string | null): Frame => ({
    group,
    siblings: group.map((node) => node.item),
    parentId,
    index: 0,
  });
  const frames: Frame[] = [open(nodes, null)];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.group.length) {
      frames.pop();
      continue;
    }
    const index = frame.index++;
    const node = frame.group[index];
    const hasChildren = node.children.length > 0;
    rows.push({
      item: node.item,
      depth: node.depth,
      parentId: frame.parentId,
      hasChildren,
      siblings: frame.siblings,
      index,
    });
    if (hasChildren && !collapsedIds.has(node.item.id)) {
      frames.push(open(node.children, node.item.id));
    }
  }
  return rows;
}

// The ordered child items of `parentId` (root group when null) — the destination
// sibling group a "move to" needs. Found by a depth-first search for the node,
// since the forest is small.
export function childrenOf<T extends TreeItem>(nodes: TreeNode<T>[], parentId: string | null): T[] {
  if (parentId === null) return nodes.map((node) => node.item);
  const found = findNode(nodes, parentId);
  return found ? found.children.map((node) => node.item) : [];
}

// Every id that may NOT receive `id` as a child: the item itself, its whole
// subtree (no cycles), any no-children container, and every parent too deep to
// take `id`'s subtree within TREE_MAX_DEPTH (deepestDepthFor). The "move to"
// picker subtracts these from the candidate parents. The too-deep set is closed
// downwards — a parent's children are deeper still — so a picker that drops an
// excluded row's subtree with it drops nothing it would have offered.
// `noChildrenIds` defaults to the list containers (Trash) — the only entity kind
// that has any; a caller working a tag tree can pass an empty set (or just
// accept the harmless list default, since no tag id collides with TRASH_ID).
export function forbiddenParentIds<T extends TreeItem>(
  nodes: TreeNode<T>[],
  id: string,
  noChildrenIds: ReadonlySet<string> = LIST_NO_CHILDREN_IDS,
): Set<string> {
  const forbidden = new Set<string>(noChildrenIds);
  const node = findNode(nodes, id);
  if (node) collectSubtreeIds(node, forbidden);
  const deepest = deepestDepthFor(nodes, id);
  visit(nodes, (each) => {
    if (each.depth + 1 > deepest) forbidden.add(each.item.id);
  });
  return forbidden;
}

// The deepest `depth` (0 at the root) `id` may be placed at by a move: deep
// enough that its whole subtree still ends within TREE_MAX_DEPTH levels — or,
// for a subtree that is already past the limit (a backup from before the
// limit, or two devices' moves meeting in sync), no deeper than it sits now, so
// a move that only lifts it is never refused. The editors' one depth rule: the
// "move to" picker reads it through forbiddenParentIds, the drag projection
// through getMovePlan (tree-dnd.ts).
export function deepestDepthFor<T extends TreeItem>(nodes: TreeNode<T>[], id: string): number {
  const node = findNode(nodes, id);
  if (node === undefined) return TREE_MAX_DEPTH - 1;
  let height = 0;
  visit([node], (each) => {
    height = Math.max(height, each.depth - node.depth + 1);
  });
  return Math.max(TREE_MAX_DEPTH - height, node.depth);
}

// Every node deeper than TREE_MAX_DEPTH levels, mapped to the parent that puts
// it AT that level: its ancestor on level TREE_MAX_DEPTH - 1. So the node keeps
// its name and its own links and sits beside that ancestor's other children,
// and its descendants, each mapped the same way, follow it there — only the
// nesting below the limit is lost. The shape the interop exports write
// (export/bundle.ts, foldersWithPaths) and the one a restore places a too-deep
// backup line in (data/backup.ts, flattenBackupTree). docs/data-limits.md.
export function parentsPastMaxDepth<T extends TreeItem>(nodes: TreeNode<T>[]): Map<string, string> {
  const out = new Map<string, string>();
  const pending: { node: TreeNode<T>; anchor: string | null }[] = nodes.map((node) => ({
    node,
    anchor: null,
  }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node } = next;
    if (node.depth >= TREE_MAX_DEPTH && next.anchor !== null) out.set(node.item.id, next.anchor);
    const anchor = node.depth === TREE_MAX_DEPTH - 2 ? node.item.id : next.anchor;
    for (const child of node.children) pending.push({ node: child, anchor });
  }
  return out;
}

// Ids on the path from the root down to (not including) `id` — the ancestors that
// must be expanded for `id`'s row to be visible (the sidebar's auto-expand).
// Empty when `id` isn't in the forest.
export function ancestorIds<T extends TreeItem>(nodes: TreeNode<T>[], id: string): string[] {
  // Each frame remembers the frame it was reached from, so the path is read back
  // off the one that matched instead of being copied down to every node.
  interface Frame {
    node: TreeNode<T>;
    parent: Frame | null;
  }
  const pending: Frame[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) pending.push({ node: nodes[i], parent: null });
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (frame.node.item.id === id) {
      const trail: string[] = [];
      for (let up = frame.parent; up !== null; up = up.parent) trail.push(up.node.item.id);
      return trail.reverse();
    }
    const { children } = frame.node;
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ node: children[i], parent: frame });
    }
  }
  return [];
}

// The node with `id`, wherever it sits in the forest — the first in depth-first
// order, should a malformed forest ever hold two.
export function findNode<T extends TreeItem>(
  nodes: TreeNode<T>[],
  id: string,
): TreeNode<T> | undefined {
  let found: TreeNode<T> | undefined;
  visit(nodes, (node) => {
    if (node.item.id !== id) return false;
    found = node;
    return true;
  });
  return found;
}

function collectSubtreeIds<T extends TreeItem>(node: TreeNode<T>, into: Set<string>): void {
  visit([node], (each) => {
    into.add(each.item.id);
  });
}
