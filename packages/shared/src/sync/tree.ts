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
// every device (sibling order is by `rank`, ties broken by `id`; the cycle scan
// walks ids in sorted order), so two devices render the same tree.

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

export function buildTree<T extends TreeItem>(
  items: T[],
  options?: BuildTreeOptions,
): TreeNode<T>[] {
  const noChildren = options?.noChildrenIds ?? EMPTY_SET;
  const byId = new Map(items.map((i) => [i.id, i]));

  // Resolve each entity's EFFECTIVE parent: null (root) when the declared parent
  // is null, missing (orphan), or a forbidden (no-children) id.
  const parentOf = new Map<string, string | null>();
  for (const item of items) {
    const p = item.parentId;
    parentOf.set(item.id, p !== null && byId.has(p) && !noChildren.has(p) ? p : null);
  }

  // Break cycles: an entity that can't reach a root by following effective
  // parents is part of a loop, so detach it (root). Walked over ids in sorted
  // order so the broken edge is the same on every device. Each detach can only
  // free other members, never create a new cycle, so one pass suffices.
  for (const id of [...byId.keys()].sort()) {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur !== null) {
      if (seen.has(cur)) {
        parentOf.set(id, null);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  // Group by effective parent, then assemble top-down, sorting each sibling group.
  const childrenOf = new Map<string | null, T[]>();
  for (const item of items) {
    const p = parentOf.get(item.id) ?? null;
    const group = childrenOf.get(p);
    if (group) group.push(item);
    else childrenOf.set(p, [item]);
  }

  const build = (parentId: string | null, depth: number): TreeNode<T>[] =>
    (childrenOf.get(parentId) ?? [])
      .slice()
      .sort(compareRank)
      .map((item) => ({ item, depth, children: build(item.id, depth + 1) }));

  return build(null, 0);
}

// Flatten a forest back to a depth-first list — the order the UI renders rows in,
// each row already carrying its `depth`. Saves every consumer rewriting the same
// recursion just to map over nodes.
export function flattenTree<T extends TreeItem>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const walk = (ns: TreeNode<T>[]): void => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// --- projections over a forest -------------------------------------------------
// The walks below all recur the same depth-first shape as flattenTree, but each
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
  const walk = (ns: TreeNode<T>[]): void => {
    for (const n of ns) {
      map.set(n.item.id, n.item.name);
      walk(n.children);
    }
  };
  walk(nodes);
  return map;
}

// One flattened row carrying the ANCESTOR NAMES on the path down to it — the path
// label the list pickers show on filtered rows ("Work / Cooking / Recipes") and
// on ListSelect's trigger. `flattenTree` yields `depth` but not the names, which
// is the whole reason this richer walk exists.
export interface TreePathRow<T extends TreeItem & { name: string }> {
  item: T;
  depth: number;
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
  const walk = (ns: TreeNode<T>[], ancestors: string[]): void => {
    for (const n of ns) {
      if (!excludeIds?.includes(n.item.id)) {
        out.push({ item: n.item, depth: n.depth, ancestors });
      }
      walk(n.children, [...ancestors, n.item.name]);
    }
  };
  walk(nodes, []);
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
  const walk = (group: TreeNode<T>[], parentId: string | null) => {
    const siblings = group.map((node) => node.item);
    group.forEach((node, index) => {
      const hasChildren = node.children.length > 0;
      rows.push({ item: node.item, depth: node.depth, parentId, hasChildren, siblings, index });
      if (hasChildren && !collapsedIds.has(node.item.id)) walk(node.children, node.item.id);
    });
  };
  walk(nodes, null);
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
// subtree (no cycles), and any no-children container. The "move to" picker
// subtracts these from the candidate parents. `noChildrenIds` defaults to the
// list containers (Trash) — the only entity kind that has any; a caller working
// a tag tree can pass an empty set (or just accept the harmless list default,
// since no tag id collides with TRASH_ID).
export function forbiddenParentIds<T extends TreeItem>(
  nodes: TreeNode<T>[],
  id: string,
  noChildrenIds: ReadonlySet<string> = LIST_NO_CHILDREN_IDS,
): Set<string> {
  const forbidden = new Set<string>(noChildrenIds);
  const node = findNode(nodes, id);
  if (node) collectSubtreeIds(node, forbidden);
  return forbidden;
}

// Ids on the path from the root down to (not including) `id` — the ancestors that
// must be expanded for `id`'s row to be visible (the sidebar's auto-expand).
// Empty when `id` isn't in the forest.
export function ancestorIds<T extends TreeItem>(nodes: TreeNode<T>[], id: string): string[] {
  const walk = (ns: TreeNode<T>[], trail: string[]): string[] | null => {
    for (const n of ns) {
      if (n.item.id === id) return trail;
      const found = walk(n.children, [...trail, n.item.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes, []) ?? [];
}

function findNode<T extends TreeItem>(nodes: TreeNode<T>[], id: string): TreeNode<T> | undefined {
  for (const node of nodes) {
    if (node.item.id === id) return node;
    const inChild = findNode(node.children, id);
    if (inChild) return inChild;
  }
  return undefined;
}

function collectSubtreeIds<T extends TreeItem>(node: TreeNode<T>, into: Set<string>): void {
  into.add(node.item.id);
  for (const child of node.children) collectSubtreeIds(child, into);
}
