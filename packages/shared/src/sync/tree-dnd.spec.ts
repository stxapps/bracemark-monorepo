import { LIST_NO_CHILDREN_IDS, TRASH_ID } from './system-lists';
import { buildTree, flattenToRows, type TreeItem, type TreeNode, type TreeRow } from './tree';
import {
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
