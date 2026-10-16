import { TRASH_ID } from './system-lists';
import {
  ancestorIds,
  buildTree,
  childrenOf,
  deepestDepthFor,
  findNode,
  flattenToPathRows,
  flattenToRows,
  flattenTree,
  forbiddenParentIds,
  parentsPastMaxDepth,
  TREE_MAX_DEPTH,
  TREE_PATH_CUT,
  TREE_ROW_MAX_LEVELS,
  type TreeItem,
  treeNameMap,
  withoutSubtrees,
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
    // The tied pair is fed in REVERSE id order deliberately. Array.sort is
    // stable, so with the ids in their expected order the assertion passes
    // whether or not the tie-break runs at all — and the tie-break is the whole
    // reason two devices render the same order, since input order here is the
    // local store's iteration order, not something the devices share.
    const out = buildTree([
      n('c', null, 'b'),
      n('b', null, 'a'),
      n('a', null, 'a'), // ties with `b` on rank → id breaks it
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

  // How many nodes a forest holds must not be something the data chooses. Parents
  // resolve by id, so every copy of a repeated id was once a child of its parent
  // AND a parent of everything naming it: each copy of a level got its own copy
  // of the level below. Kept small on purpose — the unbounded build doubles per
  // level, and at this size it still finishes, with 2,046 nodes where 10 belong.
  describe('given ids that repeat', () => {
    const LEVELS = 10;
    const COPIES = 2;
    const id = (level: number) => `l${String(level).padStart(2, '0')}`;
    const repeated = Array.from({ length: LEVELS }, (_, level) =>
      Array.from({ length: COPIES }, (_, copy) =>
        n(id(level), level === 0 ? null : id(level - 1), 'a', `${id(level)}#${copy}`),
      ),
    ).flat();

    it('places each id once, so a forest never outgrows the set it was built from', () => {
      const flat = flattenTree(buildTree(repeated));

      expect(repeated).toHaveLength(LEVELS * COPIES);
      expect(flat.map((node) => node.item.id)).toEqual(
        Array.from({ length: LEVELS }, (_, i) => id(i)),
      );
      expect(flat.map((node) => node.depth)).toEqual(Array.from({ length: LEVELS }, (_, i) => i));
    });

    it('places the last item holding an id, the one parents are resolved against', () => {
      const flat = flattenTree(buildTree(repeated));

      expect(flat.map((node) => node.item.name)).toEqual(
        Array.from({ length: LEVELS }, (_, i) => `${id(i)}#${COPIES - 1}`),
      );
    });

    // The same OBJECT twice is still one id twice — a rule that compared items
    // rather than ids would place both.
    it('places an item handed in twice once', () => {
      const root = n('root', null, 'a');
      const child = n('child', 'root', 'a');

      expect(shape(buildTree([root, root, child, child]))).toEqual([
        { id: 'root', depth: 0 },
        { id: 'child', depth: 1 },
      ]);
    });
  });

  // WHICH edge a cycle is cut at is part of the contract: every device must cut
  // the same one, or the same library renders as two different trees. The rule is
  // the scan below — ids in sorted order, detach each one whose walk does not
  // reach a root at its turn. buildTree used to run it literally, re-walking the
  // chain from every id, which is quadratic in depth; it now computes the same
  // answer in one pass. This is that scan kept as an oracle, so the faster form
  // cannot quietly start choosing a different edge.
  function rootsByTheSortedScan(items: Node[]): string[] {
    const ids = new Set(items.map((i) => i.id));
    const parentOf = new Map<string, string | null>();
    for (const i of items)
      parentOf.set(i.id, i.parentId !== null && ids.has(i.parentId) ? i.parentId : null);
    for (const id of [...ids].sort()) {
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
    return [...ids].filter((id) => parentOf.get(id) === null).sort();
  }
  const roots = (items: Node[]) =>
    buildTree(items)
      .map((node) => node.item.id)
      .sort();

  // A tail leading INTO a cycle is the case with two answers: the tail's own node
  // is detached when its id sorts before everything it leads to, and left in
  // place when something nearer the cycle was detached first. `t` → a ⇄ b.
  it.each([
    ['the tail sorts first', 'a0', ['a0', 'b1']],
    ['the tail sorts last', 'z9', ['b1']],
  ])('cuts a cycle with a tail the way the sorted scan does (%s)', (_, tail, expected) => {
    const items = [n('b1', 'c2', 'a'), n('c2', 'b1', 'a'), n(tail, 'b1', 'a')];

    expect(rootsByTheSortedScan(items)).toEqual(expected);
    expect(roots(items)).toEqual(expected);
  });

  it('agrees with the sorted scan on generated graphs, cycles and tails included', () => {
    // A fixed-seed generator, so a failure names a graph that can be replayed.
    let seed = 0x2f6e2b1;
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % bound;
    };

    for (let round = 0; round < 400; round++) {
      const size = 1 + next(12);
      // Ids whose sort order is unrelated to their position in any chain.
      const ids = Array.from(
        { length: size },
        (_, i) => `${String.fromCharCode(97 + next(26))}${i}`,
      );
      // Mostly parented, so chains run long enough to close on themselves; a
      // sixth point at an id that is not in the set (an orphan).
      const items = ids.map((id) => {
        const pick = next(size + 3);
        const parentId = pick < size ? ids[pick] : pick === size ? 'ghost' : null;
        return n(id, parentId, 'a');
      });

      expect({ round, roots: roots(items) }).toEqual({ round, roots: rootsByTheSortedScan(items) });
      // And no entity is lost or duplicated by the cut.
      expect(
        shape(buildTree(items))
          .map((x) => x.id)
          .sort(),
      ).toEqual([...ids].sort());
    }
  });
});

// A tree is as deep as its `parentId` chain, and the chain is data: a backup
// restores it verbatim and another device can sync any chain. Every reader here
// used to take one call frame per level, and `useLists` builds the tree in render
// under a provider that sits above every signed-in screen — so one deep chain was
// a stack overflow on every launch. The depth below is several times what any
// engine's stack holds; the old walks throw RangeError on it.
describe('a chain deeper than the call stack', () => {
  const DEPTH = 50_000;
  const id = (i: number) => `n${String(i).padStart(6, '0')}`;
  const chain = Array.from({ length: DEPTH }, (_, i) => n(id(i), i === 0 ? null : id(i - 1), 'a'));
  const leaf = id(DEPTH - 1);
  // Built once, from the leaf up, so the builder cannot lean on input order.
  const tree = buildTree([...chain].reverse());

  it('builds, with every entity at its own depth', () => {
    const flat = flattenTree(tree);

    expect(flat).toHaveLength(DEPTH);
    expect(flat[0]).toMatchObject({ item: { id: id(0) }, depth: 0 });
    expect(flat[DEPTH - 1]).toMatchObject({ item: { id: leaf }, depth: DEPTH - 1 });
  });

  it('is readable by every walker the screens use', () => {
    expect(treeNameMap(tree).size).toBe(DEPTH);
    expect(flattenToRows(tree, new Set())).toHaveLength(DEPTH);
    expect(flattenToRows(tree, new Set([id(2)]))).toHaveLength(3);
    expect(findNode(tree, leaf)?.depth).toBe(DEPTH - 1);
    expect(childrenOf(tree, id(DEPTH - 2)).map((item) => item.id)).toEqual([leaf]);
    expect(ancestorIds(tree, leaf)).toHaveLength(DEPTH - 1);
    expect(ancestorIds(tree, id(2))).toEqual([id(0), id(1)]);
    expect(forbiddenParentIds(tree, id(1), new Set()).size).toBe(DEPTH - 1);
    expect(flattenTree(withoutSubtrees(tree, new Set([id(3)])))).toHaveLength(3);
  });

  // The walk that is NOT in the list above, because for a long time it could not
  // be: it handed every row a copy of its whole ancestor chain, so this tree cost
  // DEPTH² / 2 names — over a billion here, and 600 MB at a fifth of the depth.
  // No stack overflow, so the app launched, and the cost landed on the first
  // list picker opened. What bounds it is that the rows past the cut SHARE one
  // path.
  it('gives the list pickers a path per row without copying the chain per row', () => {
    const rows = flattenToPathRows(tree);

    expect(rows).toHaveLength(DEPTH);
    expect(rows[DEPTH - 1].depth).toBe(DEPTH - 1);
    expect(new Set(rows.map((row) => row.ancestors)).size).toBe(TREE_ROW_MAX_LEVELS + 2);
  });

  it('breaks a cycle that long without re-walking it from every member', () => {
    // The whole chain closed into one loop: the least id is cut, the rest hang
    // from it. The literal scan walks DEPTH entities DEPTH times here.
    const loop = chain.map((item, i) => (i === 0 ? { ...item, parentId: leaf } : item));
    const out = buildTree(loop);

    expect(out.map((node) => node.item.id)).toEqual([id(0)]);
    expect(flattenTree(out)).toHaveLength(DEPTH);
  });
});

describe('withoutSubtrees', () => {
  it('drops each named node with everything under it, and nothing else', () => {
    const out = withoutSubtrees(fixture(), new Set(['cooking']));

    expect(shape(out)).toEqual([
      { id: 'work', depth: 0 },
      { id: 'travel', depth: 1 },
      { id: 'home', depth: 0 },
    ]);
  });

  it('does not mutate the forest it was given', () => {
    const forest = fixture();
    const before = shape(forest);
    withoutSubtrees(forest, new Set(['cooking', 'home']));

    expect(shape(forest)).toEqual(before);
  });

  // The sidebar memoizes on the result; a fresh array per render for the common
  // "nothing is hidden" case would repaint the whole list tree every time.
  it('hands back the same forest when there is nothing to drop', () => {
    const forest = fixture();

    expect(withoutSubtrees(forest, new Set())).toBe(forest);
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

  // The bound is on what a row SHOWS. A path cut one level early would name the
  // wrong parent for a row a person can actually reach, and one cut without the
  // marker would name the wrong parent for every row below it — so both edges
  // are pinned, and so is the row's own depth, which the cut must not touch.
  it('names every ancestor down to the row bound, and marks the cut past it', () => {
    const names = Array.from({ length: TREE_ROW_MAX_LEVELS + 3 }, (_, i) => `L${i}`);
    const rows = flattenToPathRows(
      buildTree(names.map((name, i) => n(name, i === 0 ? null : names[i - 1], 'a'))),
    );

    const atBound = rows[TREE_ROW_MAX_LEVELS];
    expect(atBound.ancestors).toEqual(names.slice(0, TREE_ROW_MAX_LEVELS));

    const cut = [...names.slice(0, TREE_ROW_MAX_LEVELS), TREE_PATH_CUT];
    expect(rows[TREE_ROW_MAX_LEVELS + 1].ancestors).toEqual(cut);
    expect(rows[TREE_ROW_MAX_LEVELS + 2].ancestors).toEqual(cut);
    expect(rows[TREE_ROW_MAX_LEVELS + 2].depth).toBe(TREE_ROW_MAX_LEVELS + 2);
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

  // The depth rule: a parent whose level leaves no room for the moving list's
  // subtree within TREE_MAX_DEPTH. c{i} sits on level i + 1.
  it('forbids every parent too deep for the subtree being moved', () => {
    const forest = buildTree([...deepChain(TREE_MAX_DEPTH), n('leaf', null, 'z')]);
    // A leaf fits under the list on level 99, not under the one on level 100.
    const forLeaf = forbiddenParentIds(forest, 'leaf', new Set());
    expect(forLeaf.has(`c${TREE_MAX_DEPTH - 2}`)).toBe(false);
    expect(forLeaf.has(`c${TREE_MAX_DEPTH - 1}`)).toBe(true);

    // Two levels tall, it needs one more level of room.
    const tall = buildTree([
      ...deepChain(TREE_MAX_DEPTH),
      n('top', null, 'z'),
      n('kid', 'top', 'a'),
    ]);
    const forTall = forbiddenParentIds(tall, 'top', new Set());
    expect(forTall.has(`c${TREE_MAX_DEPTH - 3}`)).toBe(false);
    expect(forTall.has(`c${TREE_MAX_DEPTH - 2}`)).toBe(true);
  });
});

// c0 on level 1 down to c{length-1} on level `length`.
function deepChain(length: number): Node[] {
  return Array.from({ length }, (_, i) => n(`c${i}`, i === 0 ? null : `c${i - 1}`, 'a'));
}

describe('deepestDepthFor', () => {
  it('leaves room for the whole subtree under the limit', () => {
    const forest = buildTree([n('a', null, 'a'), n('b', 'a', 'a'), n('c', 'b', 'a')]);
    expect(deepestDepthFor(forest, 'a')).toBe(TREE_MAX_DEPTH - 3);
    expect(deepestDepthFor(forest, 'c')).toBe(TREE_MAX_DEPTH - 1);
  });

  // A subtree already past the limit — stored before it, or met in sync — may
  // still move anywhere no deeper than it sits: lifting it is never refused.
  it('never refuses a move that does not deepen a subtree already past the limit', () => {
    const forest = buildTree(deepChain(TREE_MAX_DEPTH + 10));
    expect(deepestDepthFor(forest, 'c5')).toBe(5);
    expect(deepestDepthFor(forest, 'c0')).toBe(0);
  });
});

describe('parentsPastMaxDepth', () => {
  it('maps every node past the limit to its ancestor on the level above it', () => {
    const forest = buildTree([...deepChain(TREE_MAX_DEPTH + 2), n('side', null, 'z')]);
    expect(parentsPastMaxDepth(forest)).toEqual(
      new Map([
        [`c${TREE_MAX_DEPTH}`, `c${TREE_MAX_DEPTH - 2}`],
        [`c${TREE_MAX_DEPTH + 1}`, `c${TREE_MAX_DEPTH - 2}`],
      ]),
    );
  });

  it('maps nothing in a tree within the limit', () => {
    expect(parentsPastMaxDepth(buildTree(deepChain(TREE_MAX_DEPTH))).size).toBe(0);
  });
});

describe('ancestorIds', () => {
  it('lists the ids from the root down to (not including) the target', () => {
    expect(ancestorIds(fixture(), 'recipes')).toEqual(['work', 'cooking']);
    expect(ancestorIds(fixture(), 'work')).toEqual([]);
    expect(ancestorIds(fixture(), 'missing')).toEqual([]);
  });
});
