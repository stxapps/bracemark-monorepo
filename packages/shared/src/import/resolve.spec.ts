import { LINK_TAGS_MAX, LIST_NAME_MAX, TAG_NAME_MAX } from '../sync/entities';
import { ranksBetween } from '../sync/rank';
import { MY_LIST_ID, TRASH_ID } from '../sync/system-lists';
import { TREE_MAX_DEPTH } from '../sync/tree';
import { capFolderPath, ListResolver, type ResolverNode, TagResolver } from './resolve';

// Deterministic stand-in for the platform's newId (web-crypto / expo-crypto).
function idMinter(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

// Real fractional-index order keys — rankForIndex validates the siblings it
// ranks against.
const RANKS = ranksBetween(null, null, 3);

function node(over: Partial<ResolverNode> & { id: string; name: string }): ResolverNode {
  return { parentId: null, rank: RANKS[0], ...over };
}

describe('ListResolver', () => {
  it('sends an empty folder path to the default list without minting anything', () => {
    const resolver = new ListResolver([], 100, idMinter());
    expect(resolver.resolve([])).toBe(MY_LIST_ID);
    expect(resolver.created).toEqual([]);
  });

  it('matches an existing list case-insensitively', () => {
    const resolver = new ListResolver([node({ id: 'l1', name: 'Reading  ' })], 100, idMinter());
    expect(resolver.resolve(['reading'])).toBe('l1');
    expect(resolver.created).toEqual([]);
  });

  it('creates a missing folder and files it under the items path', () => {
    const resolver = new ListResolver([], 100, idMinter());
    expect(resolver.resolve(['Recipes'])).toBe('new-1');
    expect(resolver.created).toEqual([
      {
        path: 'lists/new-1.enc',
        data: expect.objectContaining({
          id: 'new-1',
          name: 'Recipes',
          parentId: null,
          createdAt: 100,
          updatedAt: 100,
        }),
      },
    ]);
  });

  // The stateful-over-one-run property: the second row reuses the first's folder.
  it('reuses a folder it created earlier in the run', () => {
    const resolver = new ListResolver([], 100, idMinter());
    expect(resolver.resolve(['Recipes'])).toBe('new-1');
    expect(resolver.resolve(['Recipes'])).toBe('new-1');
    expect(resolver.created).toHaveLength(1);
  });

  it('walks a nested path, parenting each segment to the one above', () => {
    const resolver = new ListResolver([], 100, idMinter());
    expect(resolver.resolve(['A', 'B'])).toBe('new-2');
    expect(resolver.created.map((entry) => entry.data.parentId)).toEqual([null, 'new-1']);
    // A sibling under the same parent reuses A and mints only C.
    expect(resolver.resolve(['A', 'C'])).toBe('new-3');
    expect(resolver.created).toHaveLength(3);
  });

  // Sibling groups are keyed by parent; matching across the whole tree would adopt
  // any list that merely shares a name with a segment.
  it('matches a segment against its OWN parent’s children, not every list', () => {
    const resolver = new ListResolver(
      [node({ id: 'root-archive', name: 'Archive' })],
      100,
      idMinter(),
    );
    // "Work/Archive" must mint a child of Work — filing those rows into the
    // account's unrelated root-level "Archive" would be invisible in the import
    // report and wrong on every row.
    expect(resolver.resolve(['Work', 'Archive'])).toBe('new-2');
    expect(resolver.created.map((entry) => entry.data.parentId)).toEqual([null, 'new-1']);
  });

  // The memo key is NUL-joined so a slash in a name can't collide with nesting.
  it('does not confuse ["a/b"] with ["a", "b"]', () => {
    const resolver = new ListResolver([], 100, idMinter());
    expect(resolver.resolve(['a/b'])).not.toBe(resolver.resolve(['a', 'b']));
  });

  // Importing live bookmarks into deletion staging is never wanted.
  it('never matches Trash, creating a regular list instead', () => {
    const resolver = new ListResolver([node({ id: TRASH_ID, name: 'Trash' })], 100, idMinter());
    expect(resolver.resolve(['Trash'])).toBe('new-1');
  });

  it('ranks a new folder after its existing siblings', () => {
    const existing = [
      node({ id: 'l1', name: 'A', rank: RANKS[0] }),
      node({ id: 'l2', name: 'B', rank: RANKS[1] }),
    ];
    const resolver = new ListResolver(existing, 100, idMinter());
    resolver.resolve(['C']);
    expect(resolver.created[0].data.rank > RANKS[1]).toBe(true);
  });
});

describe('TagResolver', () => {
  it('matches existing tags case-insensitively and mints the rest', () => {
    const resolver = new TagResolver([node({ id: 't1', name: 'Design' })], 100, idMinter());
    expect(resolver.resolve(['design', 'Rust'])).toEqual(['t1', 'new-1']);
    expect(resolver.created).toEqual([
      {
        path: 'tags/new-1.enc',
        data: expect.objectContaining({ id: 'new-1', name: 'Rust', parentId: null }),
      },
    ]);
  });

  it('collapses repeats within a row and skips blank names', () => {
    const resolver = new TagResolver([], 100, idMinter());
    expect(resolver.resolve(['x', 'X', '  ', 'x'])).toEqual(['new-1']);
    expect(resolver.created).toHaveLength(1);
  });

  it('reuses a tag it created earlier in the run', () => {
    const resolver = new TagResolver([], 100, idMinter());
    expect(resolver.resolve(['x'])).toEqual(['new-1']);
    expect(resolver.resolve(['x'])).toEqual(['new-1']);
    expect(resolver.created).toHaveLength(1);
  });

  it('ranks each new tag after the one it just minted', () => {
    // The stateful-over-one-run half of ranking: a file naming ten new tags must
    // produce ten ASCENDING keys, not ten copies of the same one. Equal ranks don't
    // throw — compareRank falls back to id — so the only symptom is a tag list
    // ordered by id instead of by the order the import created them.
    const resolver = new TagResolver([], 100, idMinter());
    resolver.resolve(['a', 'b', 'c']);
    const ranks = resolver.created.map((entry) => entry.data.rank);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(3);
  });

  // New tags are root-level, ranked after the existing ROOT siblings only.
  it('ranks after existing root siblings, ignoring nested ones', () => {
    const existing = [
      node({ id: 't1', name: 'A', rank: RANKS[0] }),
      node({ id: 't2', name: 'B', parentId: 't1', rank: RANKS[2] }),
    ];
    const resolver = new TagResolver(existing, 100, idMinter());
    resolver.resolve(['C']);
    expect(resolver.created[0].data.rank > RANKS[0]).toBe(true);
    // The nested sibling's rank is ignored — only root siblings bound the new tag.
    expect(resolver.created[0].data.rank < RANKS[2]).toBe(true);
  });
});

// The writers' limits, which an import is one of (docs/data-limits.md): a name
// past its cap is cut, never refused, and a row's tags stop at LINK_TAGS_MAX.
describe('the import’s limits', () => {
  it('cuts a list name past LIST_NAME_MAX and matches it as cut', () => {
    const resolver = new ListResolver([], 100, idMinter());
    const long = 'a'.repeat(LIST_NAME_MAX) + 'tail';
    const id = resolver.resolve([long]);
    expect(resolver.created.map((entry) => entry.data.name)).toEqual(['a'.repeat(LIST_NAME_MAX)]);
    // Another name sharing the first LIST_NAME_MAX characters is the same list.
    expect(resolver.resolve(['a'.repeat(LIST_NAME_MAX) + 'other'])).toBe(id);
  });

  it('cuts a tag name past TAG_NAME_MAX', () => {
    const resolver = new TagResolver([], 100, idMinter());
    resolver.resolve(['t'.repeat(TAG_NAME_MAX + 10)]);
    expect(resolver.created.map((entry) => entry.data.name)).toEqual(['t'.repeat(TAG_NAME_MAX)]);
  });

  it('keeps a row’s first LINK_TAGS_MAX tags and mints none past them', () => {
    const resolver = new TagResolver([], 100, idMinter());
    const names = Array.from({ length: LINK_TAGS_MAX + 5 }, (_, i) => `t${i}`);
    expect(resolver.resolve(names)).toHaveLength(LINK_TAGS_MAX);
    expect(resolver.created).toHaveLength(LINK_TAGS_MAX);
    expect(resolver.created.at(-1)?.data.name).toBe(`t${LINK_TAGS_MAX - 1}`);
  });

  it('caps a folder path at the first TREE_MAX_DEPTH names and the row’s own', () => {
    const path = Array.from({ length: TREE_MAX_DEPTH + 7 }, (_, i) => `f${i}`);
    expect(capFolderPath(path)).toEqual([...path.slice(0, TREE_MAX_DEPTH), path.at(-1)]);
    // Idempotent, and a path within the limit is untouched.
    expect(capFolderPath(capFolderPath(path))).toEqual(capFolderPath(path));
    expect(capFolderPath(path.slice(0, TREE_MAX_DEPTH + 1))).toEqual(
      path.slice(0, TREE_MAX_DEPTH + 1),
    );
  });
});
