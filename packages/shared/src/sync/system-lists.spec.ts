import { listSchema } from './entities';
import { compareRank } from './rank';
import {
  ALL_ID,
  ARCHIVE_ID,
  DEFAULT_LIST_ID,
  isSystemListId,
  LIST_NO_CHILDREN_IDS,
  MY_LIST_ID,
  SYSTEM_LIST_DEFAULTS,
  SYSTEM_LIST_IDS,
  SYSTEM_LIST_NAMES,
  TRASH_ID,
} from './system-lists';

// The three lists every account has, as CODE DEFAULTS rather than seeded blobs.
// Almost everything here is a constant, so the tests are about the RELATIONS
// between them — which is where the failures live. Two in particular have no
// other guard:
//
//   - a default is written verbatim as an override blob the moment the user
//     renames or reorders one, so it has to satisfy `listSchema` at that point,
//     not at the point it was typed here;
//   - the reserved-id invariant is stated in prose at the top of system-lists.ts
//     and enforced nowhere, and a collision would mean one entity's blob quietly
//     standing in for another's.

describe('the system list ids', () => {
  it('names exactly My List, Archive and Trash', () => {
    expect(SYSTEM_LIST_IDS).toEqual(new Set([MY_LIST_ID, ARCHIVE_ID, TRASH_ID]));
  });

  it('are distinct from each other', () => {
    // They index `SYSTEM_LIST_NAMES` and key the override blobs; a duplicate
    // would collapse two lists onto one file.
    expect(SYSTEM_LIST_IDS.size).toBe(3);
  });

  it('does NOT include the Show-All pseudo-list', () => {
    // `all` is a list-PARAM value, not an entity id — it has no blob and no
    // name entry. Letting it into the set would make `isSystemListId('all')`
    // true and invite a writer to mint `lists/all.enc`, a file nothing reads.
    expect(isSystemListId(ALL_ID)).toBe(false);
    expect(SYSTEM_LIST_NAMES[ALL_ID]).toBeUndefined();
    expect(SYSTEM_LIST_DEFAULTS.some((list) => list.id === ALL_ID)).toBe(false);
  });

  it('recognizes its own ids and nothing else', () => {
    for (const id of SYSTEM_LIST_IDS) expect(isSystemListId(id)).toBe(true);
    // A user list id is an opaque random token; none of these is one.
    for (const id of ['', 'my list', 'My-List', 'aZ09_-', 'trash2']) {
      expect(isSystemListId(id)).toBe(false);
    }
  });

  it('are URL-safe literals, since they appear in `?list=`', () => {
    // Unlike a user list's opaque token these are the same on every account, so
    // they leak nothing — but that only holds while they stay plain literals.
    for (const id of SYSTEM_LIST_IDS) expect(id).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe('the defaults', () => {
  it('covers every system list, once, in the declared order', () => {
    expect(SYSTEM_LIST_DEFAULTS.map((list) => list.id)).toEqual([MY_LIST_ID, ARCHIVE_ID, TRASH_ID]);
  });

  it('ranks them My List < Archive < Trash', () => {
    // The seeded order, and it has to hold under the SAME comparator the tree
    // sorts siblings with — not just as declaration order, which nothing reads.
    const sorted = [...SYSTEM_LIST_DEFAULTS].sort(compareRank);
    expect(sorted.map((list) => list.id)).toEqual([MY_LIST_ID, ARCHIVE_ID, TRASH_ID]);
  });

  it('carries real, distinct fractional-index keys', () => {
    // In the same keyspace as user lists, so a newly created user list can rank
    // against or between them. Equal keys would leave the order to the id
    // tie-break, which alphabetizes to Archive, My List, Trash.
    const ranks = SYSTEM_LIST_DEFAULTS.map((list) => list.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const rank of ranks) expect(rank).not.toBe('');
  });

  it('are all root-level', () => {
    // `parentId` is explicitly null, never undefined — "top-level" has to be a
    // value a concurrent edit can't be confused about.
    for (const list of SYSTEM_LIST_DEFAULTS) expect(list.parentId).toBeNull();
  });

  it('validates as a real list entity', () => {
    // The one that would land far from here: rename or reorder a system list and
    // the client writes this shape, plus the edit, to `lists/{id}.enc` at the
    // reserved id. A default that doesn't satisfy the schema fails at that write,
    // not here.
    for (const list of SYSTEM_LIST_DEFAULTS) {
      expect(listSchema.safeParse(list).success).toBe(true);
    }
  });

  it('uses the shared name table rather than its own literals', () => {
    for (const list of SYSTEM_LIST_DEFAULTS) {
      expect(list.name).toBe(SYSTEM_LIST_NAMES[list.id]);
    }
  });

  it('stamps the genesis timestamps, not a build time', () => {
    // An untouched default never enters the store and never sorts by time — rank
    // orders the tree. A real `Date.now()` here would be a per-build value baked
    // into a value that is supposed to be identical on every device.
    for (const list of SYSTEM_LIST_DEFAULTS) {
      expect(list.createdAt).toBe(0);
      expect(list.updatedAt).toBe(0);
    }
  });
});

describe('the defaults a client depends on', () => {
  it('files a new link into My List', () => {
    // The default inbox, and the selection shown when no list is chosen. Pointing
    // it at Archive or Trash would file every new save out of sight.
    expect(DEFAULT_LIST_ID).toBe(MY_LIST_ID);
    expect(isSystemListId(DEFAULT_LIST_ID)).toBe(true);
  });

  it('forbids children under Trash and nowhere else', () => {
    // Trash is the deletion staging area, so nesting a list inside it is
    // incoherent; buildTree promotes anything naming it as a parent back to the
    // root. Adding My List here would flatten the user's whole tree.
    expect(LIST_NO_CHILDREN_IDS).toEqual(new Set([TRASH_ID]));
  });

  it('names every system list and nothing else', () => {
    expect(new Set(Object.keys(SYSTEM_LIST_NAMES))).toEqual(SYSTEM_LIST_IDS);
    for (const name of Object.values(SYSTEM_LIST_NAMES)) expect(name).not.toBe('');
  });
});
