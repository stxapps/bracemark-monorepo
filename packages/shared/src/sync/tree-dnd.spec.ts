import { LIST_NO_CHILDREN_IDS, TRASH_ID } from './system-lists';
import { buildTree, flattenToRows, type TreeItem, type TreeNode, type TreeRow } from './tree';
import {
  applyMovePlan,
  arrayMove,
  excludeActiveDescendants,
  getMovePlan,
  getProjection,
  type ProjectionOptions,
} from './tree-dnd';

// Minimal tree item; only id/parentId/rank matter to the tree + projection.
interface Node extends TreeItem {
  name: string;
}
function item(id: string, parentId: string | null, rank: string): Node {
  return { id, name: id, parentId, rank };
}

// The px-per-level a caller passes; the module's own default matches, but the
// tests are explicit so they don't silently ride on it.
const INDENT = 20;
const OPTS: ProjectionOptions = { indentWidth: INDENT, noChildrenIds: LIST_NO_CHILDREN_IDS };

// A small forest:  A | B > [B1] | C  (B has one child, all else at root).
function fixture(): { lists: TreeNode<Node>[]; rows: TreeRow<Node>[] } {
  const items = [
    item('A', null, 'a'),
    item('B', null, 'b'),
    item('B1', 'B', 'a'),
    item('C', null, 'c'),
  ];
  const lists = buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS });
  return { lists, rows: flattenToRows(lists, new Set()) };
}

const NONE: ReadonlySet<string> = new Set();

describe('arrayMove', () => {
  it('moves an element without mutating the input', () => {
    const items = ['a', 'b', 'c'];
    expect(arrayMove(items, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(arrayMove(items, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('excludeActiveDescendants', () => {
  it('drops the active row’s subtree but keeps the row itself', () => {
    const { rows } = fixture();
    expect(excludeActiveDescendants(rows, 'B').map((r) => r.item.id)).toEqual(['A', 'B', 'C']);
  });

  it('is a no-op when nothing is dragged or the id is gone', () => {
    const { rows } = fixture();
    expect(excludeActiveDescendants(rows, null)).toBe(rows);
    expect(excludeActiveDescendants(rows, 'nope').map((r) => r.item.id)).toEqual([
      'A',
      'B',
      'B1',
      'C',
    ]);
  });
});

describe('getProjection', () => {
  it('keeps a row at root when dragged with no horizontal offset', () => {
    const { rows } = fixture();
    expect(getProjection(rows, 'A', 'C', 0, OPTS)).toEqual({ depth: 0, parentId: null });
  });

  it('nests under the previous row when dragged one indent right', () => {
    const { rows } = fixture();
    // A dropped just under B, indented one level → child of B.
    expect(getProjection(rows, 'A', 'B', INDENT, OPTS)).toEqual({ depth: 1, parentId: 'B' });
  });

  it('clamps depth to one past the previous row, however far right', () => {
    const { rows } = fixture();
    const { depth } = getProjection(rows, 'A', 'B', INDENT * 10, OPTS);
    expect(depth).toBe(1);
  });

  it('never nests under a no-children container (Trash)', () => {
    const items = [item('A', null, 'a'), item(TRASH_ID, null, 'z')];
    const lists = buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS });
    const rows = flattenToRows(lists, NONE);
    // Drag A under Trash, pushed hard right: max depth stays at Trash's depth.
    expect(getProjection(rows, 'A', TRASH_ID, INDENT * 5, OPTS)).toEqual({
      depth: 0,
      parentId: null,
    });
  });

  describe('stepThreshold', () => {
    // Half an indent: rounding (the pointer default) takes it, a touch-calibrated
    // 0.75 doesn't — the whole point of the knob.
    const half = INDENT / 2;
    const touch: ProjectionOptions = { ...OPTS, stepThreshold: 0.75 };

    // Dropped over C (the last row), where neither neighbour clamps the result —
    // so the threshold alone decides the depth. Over B it wouldn't: B1 follows,
    // and minDepth would force depth 1 whatever the offset says.
    it('changes level at half an indent by default', () => {
      const { rows } = fixture();
      expect(getProjection(rows, 'A', 'C', half, OPTS)).toEqual({ depth: 1, parentId: 'C' });
    });

    it('holds the level until the threshold is passed', () => {
      const { rows } = fixture();
      expect(getProjection(rows, 'A', 'C', half, touch).depth).toBe(0);
      expect(getProjection(rows, 'A', 'C', INDENT * 0.74, touch).depth).toBe(0);
      expect(getProjection(rows, 'A', 'C', INDENT * 0.76, touch).depth).toBe(1);
    });

    it('is symmetric — an outdent needs the same pull', () => {
      const { rows } = fixture();
      // B1 (depth 1, under B) held in place: it only flattens to the root once
      // the leftward pull passes the same 0.75 of an indent.
      expect(getProjection(rows, 'B1', 'B1', -half, touch).depth).toBe(1);
      expect(getProjection(rows, 'B1', 'B1', -INDENT * 0.76, touch)).toEqual({
        depth: 0,
        parentId: null,
      });
    });
  });
});

describe('getMovePlan', () => {
  it('reparents A as the first child of B', () => {
    const { lists, rows } = fixture();
    const plan = getMovePlan(lists, rows, 'A', 'B', INDENT, OPTS);
    expect(plan).toMatchObject({ parentId: 'B', index: 0 });
    expect(plan?.item.id).toBe('A');
    expect(plan?.siblings.map((s) => s.id)).toEqual(['B1']); // excludes A
  });

  it('moves A to the end of the root group', () => {
    const { lists, rows } = fixture();
    const plan = getMovePlan(lists, rows, 'A', 'C', 0, OPTS);
    // Root siblings excluding A are B and C; A lands after both.
    expect(plan).toMatchObject({ parentId: null, index: 2 });
    expect(plan?.siblings.map((s) => s.id)).toEqual(['B', 'C']);
  });

  it('returns null when either row is gone', () => {
    const { lists, rows } = fixture();
    expect(getMovePlan(lists, rows, 'nope', 'C', 0, OPTS)).toBeNull();
    expect(getMovePlan(lists, rows, 'A', 'nope', 0, OPTS)).toBeNull();
  });
});

describe('applyMovePlan', () => {
  // The forest as rendered: every row in order with its depth, which is the whole
  // shape (depth-first order plus depth determines the tree).
  const shape = (nodes: TreeNode<Node>[]) =>
    flattenToRows(nodes, NONE).map((row) => `${row.item.id}:${row.depth}`);

  // What the STORE would read back: write the plan the way `move` does — one
  // `{ parentId, rank }` on the moved item — and rebuild. `rank` here is a bare
  // letter between its new neighbours, which is all buildTree compares.
  const written = (items: Node[], id: string, parentId: string | null, rank: string) =>
    buildTree(
      items.map((i) => (i.id === id ? { ...i, parentId, rank } : i)),
      { noChildrenIds: LIST_NO_CHILDREN_IDS },
    );

  const items = [
    item('A', null, 'a'),
    item('B', null, 'c'),
    item('B1', 'B', 'a'),
    item('B2', 'B', 'c'),
    item('C', null, 'e'),
  ];
  const lists = buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS });
  const rows = flattenToRows(lists, NONE);

  it('predicts the forest the write will produce, for a reorder, a nest and an un-nest', () => {
    // The held order is only invisible when it is the order about to arrive: a
    // prediction that is off by a slot is a row that lands, then moves again.
    const drops: [activeId: string, overId: string, offsetX: number, rank: string][] = [
      ['A', 'C', 0, 'f'], // root reorder, to the end
      ['C', 'A', 0, '0'], // root reorder, to the head
      ['A', 'B1', INDENT, 'b'], // nest between B1 and B2
      ['B1', 'C', -INDENT, 'f'], // un-nest to the end of the root
    ];
    for (const [activeId, overId, offsetX, rank] of drops) {
      const dragRows = excludeActiveDescendants(rows, activeId);
      const plan = getMovePlan(lists, dragRows, activeId, overId, offsetX, OPTS);
      if (!plan) throw new Error(`no plan for ${activeId} over ${overId}`);

      const store = written(items, activeId, plan.parentId, rank);
      expect(shape(applyMovePlan(lists, plan))).toEqual(shape(store));
      expect(shape(store)).not.toEqual(shape(lists)); // each of these really moves
    }
  });

  it('carries the subtree along and re-depths it', () => {
    // B (with B1, B2) nested under A: the children were depth 1 and are now 2.
    const plan = { item: items[1], parentId: 'A', index: 0 };
    expect(shape(applyMovePlan(lists, plan))).toEqual(['A:0', 'B:1', 'B1:2', 'B2:2', 'C:0']);
  });

  it('hands back the same forest when the plan no longer fits it', () => {
    // Deleted on another device between the drop and the render: there is no
    // order to show, and identity is how the caller tells.
    expect(applyMovePlan(lists, { item: item('gone', null, 'z'), parentId: null, index: 0 })).toBe(
      lists,
    );
    expect(applyMovePlan(lists, { item: items[0], parentId: 'gone', index: 0 })).toBe(lists);
  });

  it('does not mutate the forest it was given', () => {
    const before = shape(lists);
    applyMovePlan(lists, { item: items[0], parentId: 'B', index: 1 });
    expect(shape(lists)).toEqual(before);
  });

  // A destination inside the dragged subtree is not a place the row can land:
  // the plan is stale, and the forest comes back as it was.
  it('refuses a destination inside the subtree being moved', () => {
    expect(applyMovePlan(lists, { item: items[1], parentId: 'B1', index: 0 })).toBe(lists);
  });

  // The Lists table renders this in the drop's own render, over a forest as deep
  // as the library's `parentId` chain (tree.ts) — so it copies on its own stack.
  it('moves a row out of a chain deeper than the call stack', () => {
    const DEPTH = 50_000;
    const id = (i: number) => `n${String(i).padStart(6, '0')}`;
    const deep = Array.from({ length: DEPTH }, (_, i) =>
      item(id(i), i === 0 ? null : id(i - 1), 'a'),
    );
    const forest = buildTree(deep);

    const moved = applyMovePlan(forest, { item: deep[1], parentId: null, index: 1 });

    expect(moved.map((node) => `${node.item.id}:${node.depth}`)).toEqual([
      `${id(0)}:0`,
      `${id(1)}:0`,
    ]);
    const rows = flattenToRows(moved, NONE);
    expect(rows).toHaveLength(DEPTH);
    expect(rows[DEPTH - 1]).toMatchObject({ item: { id: id(DEPTH - 1) }, depth: DEPTH - 2 });
  });
});
