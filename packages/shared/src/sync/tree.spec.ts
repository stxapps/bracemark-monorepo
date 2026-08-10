import { TRASH_ID } from './system-lists';
import {
  ancestorIds,
  buildTree,
  childrenOf,
  flattenToPathRows,
  flattenToRows,
  flattenTree,
  forbiddenParentIds,
  type TreeItem,
  treeNameMap,
} from './tree';

// Minimal tree item; `name` rides along to prove the whole entity is carried.
interface Node extends TreeItem {
  name: string;
}
const n = (id: string, parentId: string | null, rank: string, name = id): Node => ({
  id,
  parentId,
  rank,
  name,
});

// The flattened (id, depth) shape — the order/nesting the UI renders.
const shape = (nodes: ReturnType<typeof buildTree<Node>>) =>
  flattenTree(nodes).map((node) => ({ id: node.item.id, depth: node.depth }));

describe('buildTree', () => {
  it('orders roots by rank, then by id on a tie', () => {
    const out = buildTree([
      n('c', null, 'b'),
      n('a', null, 'a'),
      n('b', null, 'a'), // ties with `a` on rank → id breaks it
    ]);
    expect(out.map((node) => node.item.id)).toEqual(['a', 'b', 'c']);
  });

  it('nests children under their parent and assigns depth', () => {
    const out = buildTree([
      n('root', null, 'a'),
      n('child', 'root', 'a'),
      n('grandchild', 'child', 'a'),
    ]);
    expect(shape(out)).toEqual([
      { id: 'root', depth: 0 },
      { id: 'child', depth: 1 },
      { id: 'grandchild', depth: 2 },
    ]);
  });

  it('promotes an orphan (missing parent) to the root', () => {
    const out = buildTree([n('a', 'ghost', 'a')]);
    expect(shape(out)).toEqual([{ id: 'a', depth: 0 }]);
  });

  it('promotes a child of a no-children id (e.g. Trash) to the root', () => {
    const out = buildTree([n('trash', null, 'b'), n('a', 'trash', 'a')], {
      noChildrenIds: new Set(['trash']),
    });
    expect(shape(out)).toEqual([
      { id: 'a', depth: 0 },
      { id: 'trash', depth: 0 },
    ]);
  });

  it('breaks a cycle by detaching its members to the root', () => {
    // a → b → a, with c hanging off b.
    const out = buildTree([n('a', 'b', 'a'), n('b', 'a', 'a'), n('c', 'b', 'a')]);
    // No crash, every node present, none lost. `c` stays under `b`; the cycle
    // members surface at the root.
    const flat = shape(out);
    expect(flat.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    const byId = Object.fromEntries(flat.map((x) => [x.id, x.depth]));
    expect(byId.c).toBe(byId.b + 1);
  });

  it('is deterministic regardless of input order', () => {
    const items = [n('a', null, 'a'), n('b', 'a', 'a'), n('c', 'a', 'b')];
    const forward = shape(buildTree(items));
    const reversed = shape(buildTree([...items].reverse()));
    expect(forward).toEqual(reversed);
  });
});

// A small fixture forest shared by the projection tests. Distinct ids and names
// so the id-vs-name distinction is observable:
//   work (Work)
//     cooking (Cooking)
//       recipes (Recipes)
//     travel (Travel)
//   home (Home)
const fixture = () =>
  buildTree([
    n('work', null, 'a', 'Work'),
    n('cooking', 'work', 'a', 'Cooking'),
    n('recipes', 'cooking', 'a', 'Recipes'),
    n('travel', 'work', 'b', 'Travel'),
    n('home', null, 'b', 'Home'),
  ]);

describe('treeNameMap', () => {
  it('maps every id to its name across all depths', () => {
    const map = treeNameMap(fixture());
    expect(map.size).toBe(5);
    expect(map.get('recipes')).toBe('Recipes');
    expect(map.get('home')).toBe('Home');
  });
});

describe('flattenToPathRows', () => {
  it('carries each row ancestors names on the path down to it', () => {
    const rows = flattenToPathRows(fixture());
    expect(rows.map((r) => ({ id: r.item.id, depth: r.depth, ancestors: r.ancestors }))).toEqual([
      { id: 'work', depth: 0, ancestors: [] },
      { id: 'cooking', depth: 1, ancestors: ['Work'] },
      { id: 'recipes', depth: 2, ancestors: ['Work', 'Cooking'] },
      { id: 'travel', depth: 1, ancestors: ['Work'] },
      { id: 'home', depth: 0, ancestors: [] },
    ]);
  });

  it('drops an excluded row but still descends into its subtree', () => {
    const rows = flattenToPathRows(fixture(), ['cooking']);
    expect(rows.map((r) => r.item.id)).toEqual(['work', 'recipes', 'travel', 'home']);
    // The dropped ancestor still contributes its name to descendants' paths.
    expect(rows.find((r) => r.item.id === 'recipes')?.ancestors).toEqual(['Work', 'Cooking']);
  });
});

describe('flattenToRows', () => {
  it('tags each row with its effective parent, sibling group, and index', () => {
    const rows = flattenToRows(fixture(), new Set());
    expect(
      rows.map((r) => ({
        id: r.item.id,
        parentId: r.parentId,
        hasChildren: r.hasChildren,
        index: r.index,
        siblings: r.siblings.map((s) => s.id),
      })),
    ).toEqual([
      { id: 'work', parentId: null, hasChildren: true, index: 0, siblings: ['work', 'home'] },
      {
        id: 'cooking',
        parentId: 'work',
        hasChildren: true,
        index: 0,
        siblings: ['cooking', 'travel'],
      },
      {
        id: 'recipes',
        parentId: 'cooking',
        hasChildren: false,
        index: 0,
        siblings: ['recipes'],
      },
      {
        id: 'travel',
        parentId: 'work',
        hasChildren: false,
        index: 1,
        siblings: ['cooking', 'travel'],
      },
      { id: 'home', parentId: null, hasChildren: false, index: 1, siblings: ['work', 'home'] },
    ]);
  });

  it('skips the subtree under a collapsed id but still renders that id row', () => {
    const rows = flattenToRows(fixture(), new Set(['cooking']));
    expect(rows.map((r) => r.item.id)).toEqual(['work', 'cooking', 'travel', 'home']);
  });
});

describe('childrenOf', () => {
  it('returns the root group for null and a node ordered children otherwise', () => {
    expect(childrenOf(fixture(), null).map((i) => i.id)).toEqual(['work', 'home']);
    expect(childrenOf(fixture(), 'work').map((i) => i.id)).toEqual(['cooking', 'travel']);
    expect(childrenOf(fixture(), 'recipes')).toEqual([]);
    expect(childrenOf(fixture(), 'missing')).toEqual([]);
  });
});

describe('forbiddenParentIds', () => {
  it('forbids the id, its whole subtree, and the no-children containers', () => {
    const forbidden = forbiddenParentIds(fixture(), 'work');
    expect([...forbidden].sort()).toEqual(
      [TRASH_ID, 'cooking', 'recipes', 'travel', 'work'].sort(),
    );
    expect(forbidden.has('home')).toBe(false);
  });

  it('accepts a custom no-children set (e.g. an empty one for tag trees)', () => {
    const forbidden = forbiddenParentIds(fixture(), 'cooking', new Set());
    expect([...forbidden].sort()).toEqual(['cooking', 'recipes']);
  });
});

describe('ancestorIds', () => {
  it('lists the ids from the root down to (not including) the target', () => {
    expect(ancestorIds(fixture(), 'recipes')).toEqual(['work', 'cooking']);
    expect(ancestorIds(fixture(), 'work')).toEqual([]);
    expect(ancestorIds(fixture(), 'missing')).toEqual([]);
  });
});
