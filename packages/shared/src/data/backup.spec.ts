import { syncPathSchema } from '../sync/endpoints';
import { APP_LOCK_ID } from '../sync/lock-coverage';
import { FILES_PREFIX, LISTS_PREFIX, pathFromId, TAGS_PREFIX } from '../sync/paths';
import { ranksBetween } from '../sync/rank';
import { ALL_ID, MY_LIST_ID, RESERVED_LIST_IDS, TRASH_ID } from '../sync/system-lists';
import { buildTree, flattenToRows, flattenTree, TREE_MAX_DEPTH } from '../sync/tree';
import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  BRACEMARK_BACKUP_FORMAT,
  BRACEMARK_BACKUP_VERSION,
  type BundleEntry,
  classifyBundleLine,
  firstLinePerPath,
  flattenBackupTree,
  jsonlLine,
  parseBackupManifest,
  referencedFileIds,
  serializeBackupItems,
  serializeBackupManifest,
} from './backup';

// Real fractional-index order keys — the schemas' `rank` is validated as one.
const RANKS = ranksBetween(null, null, 3);

const link = { url: 'https://a.test/', listId: 'my-list', tagIds: [], createdAt: 1, updatedAt: 2 };

// One valid entity per namespace — the six kinds an archive can carry.
const ENTITIES = {
  link: { path: 'links/lnk1.enc', data: link },
  list: {
    path: 'lists/lst1.enc',
    data: { id: 'lst1', name: 'A', parentId: null, rank: RANKS[0], createdAt: 1, updatedAt: 1 },
  },
  tag: {
    path: 'tags/tag1.enc',
    data: { id: 'tag1', name: 'T', parentId: null, rank: RANKS[1], createdAt: 1, updatedAt: 1 },
  },
  pin: {
    path: 'pins/lnk1.enc',
    data: { id: 'lnk1', rank: RANKS[2], createdAt: 1, updatedAt: 1 },
  },
  extraction: {
    path: 'extractions/lnk1.enc',
    data: { id: 'lnk1', facets: {}, imageId: 'img-a', createdAt: 1, updatedAt: 1 },
  },
  settings: {
    path: 'settings/general.enc',
    data: { linksLayout: 'list' as const, createdAt: 1, updatedAt: 1 },
  },
} as const;

describe('the archive layout', () => {
  it('names its fixed entries', () => {
    expect(BACKUP_MANIFEST_ENTRY).toBe('manifest.json');
    expect(BACKUP_ITEMS_ENTRY).toBe('items.jsonl');
  });

  // The zip carries DECRYPTED bytes, so the `.enc` of the items path is dropped.
  it('keys a blob entry by bare id', () => {
    expect(backupFileEntry('abc')).toBe('files/abc');
  });

  it('terminates a non-empty items body and leaves an empty one empty', () => {
    expect(serializeBackupItems(['a', 'b'])).toBe('a\nb\n');
    expect(serializeBackupItems([])).toBe('');
  });
});

// The promise the whole file exists for, and the one thing no test composed: what
// the EXPORTER writes, the IMPORTER reads back — every kind, unchanged, with the
// version bump that would break it landing on both platforms at once. Each piece
// was covered alone; a mismatch between them (a prefix renamed on one side, a
// namespace dropped from BUNDLE_NAMESPACES) passed every existing assertion.
describe('the items.jsonl round trip', () => {
  // The reader half both importers actually run — including the blank-line skip
  // that pairs with serializeBackupItems' trailing newline. That skip lives
  // duplicated in web-react and expo-react import-all-data.ts and in no shared
  // function, so this is the only place the pairing is stated.
  const read = (text: string): (BundleEntry | undefined)[] =>
    text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(classifyBundleLine);

  it('reads every namespace back with its kind and path intact', () => {
    const kinds = Object.keys(ENTITIES) as (keyof typeof ENTITIES)[];
    const body = serializeBackupItems(
      kinds.map((k) => jsonlLine(ENTITIES[k].path, ENTITIES[k].data)),
    );

    const entries = read(body);

    expect(entries).toHaveLength(kinds.length);
    expect(entries.map((e) => e?.kind)).toEqual(kinds);
    for (const [i, kind] of kinds.entries()) {
      expect(entries[i]?.path).toBe(ENTITIES[kind].path);
      expect(entries[i]?.data).toEqual(ENTITIES[kind].data);
    }
  });

  it('does not count the trailing newline as an invalid line', () => {
    // serializeBackupItems terminates the body, so a reader that classifies every
    // split segment would report one invalid row on EVERY backup — a number in the
    // corner of a clean restore, with nothing wrong.
    const body = serializeBackupItems([jsonlLine(ENTITIES.link.path, ENTITIES.link.data)]);

    expect(body.endsWith('\n')).toBe(true);
    expect(read(body)).toHaveLength(1);
    expect(classifyBundleLine('')).toBeUndefined(); // …which is why the skip is needed
  });

  it('survives an empty archive', () => {
    expect(read(serializeBackupItems([]))).toEqual([]);
  });
});

describe('the manifest round trip', () => {
  const counts = { links: 2, lists: 1, tags: 0, pins: 0, extractions: 1, files: 3 };

  it('reads back what it wrote', () => {
    const manifest = parseBackupManifest(serializeBackupManifest(counts));
    expect(manifest.format).toBe(BRACEMARK_BACKUP_FORMAT);
    expect(manifest.version).toBe(BRACEMARK_BACKUP_VERSION);
    expect(manifest.counts).toEqual(counts);
    expect(manifest.exportedAt).toBeGreaterThan(0);
  });

  it('rejects unreadable JSON, a foreign format, and a future version', () => {
    expect(() => parseBackupManifest('{oops')).toThrow(/unreadable manifest/);
    expect(() => parseBackupManifest(JSON.stringify({ format: 'other', version: 1 }))).toThrow(
      /unrecognized format/,
    );
    expect(() =>
      parseBackupManifest(
        JSON.stringify({ format: BRACEMARK_BACKUP_FORMAT, version: BRACEMARK_BACKUP_VERSION + 1 }),
      ),
    ).toThrow(/newer version of Bracemark/);
  });

  it('gives the user-facing message for a manifest that is JSON but not an object', () => {
    // `JSON.parse` succeeds on `null`, and reading `.format` off it threw a raw
    // TypeError — from the one function whose entire job is to produce the
    // message the import view renders verbatim.
    for (const text of ['null', '123', '"bracemark-backup"']) {
      expect(() => parseBackupManifest(text)).toThrow(/isn’t a Bracemark backup/);
    }
  });

  // A damaged `version` and a FUTURE `version` are different diagnoses with
  // different advice, and they shared one branch: a manifest whose version was a
  // string or missing entirely was reported as "created by a newer version of
  // Bracemark. Update the app and try again" — advice no update can satisfy,
  // sending the user to the store to fix a truncated file.
  it.each([
    ['a string version', '1'],
    ['a null version', null],
    ['a missing version', undefined],
    ['an object version', {}],
  ])('reports %s as a damaged manifest, not a newer app', (_label, version) => {
    const text = JSON.stringify({ format: BRACEMARK_BACKUP_FORMAT, version, counts: {} });

    expect(() => parseBackupManifest(text)).toThrow(/invalid manifest version/);
    expect(() => parseBackupManifest(text)).not.toThrow(/Update the app/);
  });

  it('reserves the update advice for a version this app genuinely cannot read', () => {
    const text = JSON.stringify({
      format: BRACEMARK_BACKUP_FORMAT,
      version: BRACEMARK_BACKUP_VERSION + 1,
    });

    expect(() => parseBackupManifest(text)).toThrow(/newer version of Bracemark/);
    expect(() => parseBackupManifest(text)).toThrow(/Update the app and try again/);
  });

  // Older archives stay readable — that's the whole point of gating on `>`.
  it('accepts an older version', () => {
    const text = JSON.stringify({ format: BRACEMARK_BACKUP_FORMAT, version: 0, counts: {} });
    expect(parseBackupManifest(text).version).toBe(0);
  });
});

describe('classifyBundleLine', () => {
  // Every kind, not a sample of them: a namespace missing from BUNDLE_NAMESPACES
  // (or carrying the wrong prefix or schema) silently classifies as invalid, so
  // those entities vanish from a restore and land in the invalid COUNT instead —
  // the user's tags simply aren't there, with a number in the corner.
  it.each(Object.keys(ENTITIES) as (keyof typeof ENTITIES)[])('classifies %s', (kind) => {
    expect(classifyBundleLine(jsonlLine(ENTITIES[kind].path, ENTITIES[kind].data))?.kind).toBe(
      kind,
    );
  });

  it('rejects malformed lines', () => {
    expect(classifyBundleLine('not json')).toBeUndefined();
    expect(classifyBundleLine(JSON.stringify({ path: 'links/a.enc' }))).toBeUndefined();
    expect(classifyBundleLine(jsonlLine('other/a.enc', link))).toBeUndefined();
    // Fails its namespace schema (no url).
    expect(classifyBundleLine(jsonlLine('links/a.enc', { listId: 'x' }))).toBeUndefined();
  });

  // A path that isn't `{prefix}{plain-id}.enc` would poison the store/R2 key
  // space, so the id is gated to a plain token.
  it('rejects a path whose id is not a plain token', () => {
    expect(classifyBundleLine(jsonlLine('links/a/b.enc', link))).toBeUndefined();
    expect(classifyBundleLine(jsonlLine('links/.enc', link))).toBeUndefined();
    expect(classifyBundleLine(jsonlLine('links/a', link))).toBeUndefined();
    expect(classifyBundleLine(jsonlLine('links/../x.enc', link))).toBeUndefined();
  });

  // A list's or tag's identity is its path; the `id` inside is a copy. A line
  // whose copy disagrees claims an id it is not stored under — and a restore that
  // took its word kept two lists under one id, or a user list under Trash's.
  it.each(['list', 'tag', 'pin'] as const)(
    'refuses a %s line whose own id is not its path id',
    (kind) => {
      const { path, data } = ENTITIES[kind];

      expect(classifyBundleLine(jsonlLine(path, { ...data, id: 'other' }))).toBeUndefined();
      expect(classifyBundleLine(jsonlLine(path, data))?.kind).toBe(kind);
    },
  );

  // Show All's id, and the app lock's row in the lock table list locks share: a
  // list at either already means something else, and one the user locked would
  // replace the app lock. Lists only — a tag shares neither.
  it('refuses a list stored at a reserved id, and only a list', () => {
    expect([...RESERVED_LIST_IDS].sort()).toEqual([ALL_ID, APP_LOCK_ID].sort());
    for (const id of RESERVED_LIST_IDS) {
      const list = { ...ENTITIES.list.data, id };
      const tag = { ...ENTITIES.tag.data, id };

      expect(classifyBundleLine(jsonlLine(pathFromId(id, LISTS_PREFIX), list))).toBeUndefined();
      expect(classifyBundleLine(jsonlLine(pathFromId(id, TAGS_PREFIX), tag))?.kind).toBe('tag');
    }
  });

  it('refuses a user list claiming a system list id, and keeps the override stored at it', () => {
    const { path, data } = ENTITIES.list;

    expect(classifyBundleLine(jsonlLine(path, { ...data, id: 'trash' }))).toBeUndefined();
    expect(classifyBundleLine(jsonlLine('lists/trash.enc', { ...data, id: 'trash' }))?.kind).toBe(
      'list',
    );
  });

  // The ids INSIDE the data, which the path check above never sees. Each of these
  // four fields names a `files/{id}.enc` blob, so a restore turns it into a path
  // and a queued put — and any later delete of the link turns it into a queued
  // delete — with the archive's string in the middle. Listed by hand: this is
  // where a fifth ref field has to be added, though the gate asks
  // referencedFileIds and so cannot fall behind the importers on its own.
  const FILE_REFS = [
    ['link', 'customImageId'],
    ['extraction', 'imageId'],
    ['extraction', 'pageCopyId'],
    ['extraction', 'screenshotId'],
  ] as const;

  const withFileRef = (kind: 'link' | 'extraction', field: string, id: string): string =>
    jsonlLine(ENTITIES[kind].path, { ...ENTITIES[kind].data, [field]: id });

  // What both platforms' `newId` mints: a UUID.
  const MINTED_ID = '3f2b8c1e-9d4a-4e7b-a1c6-5d0f2e8b7a94';

  // Ids no first-party writer produces and no client can send. The first is the
  // likely one — a file written by something that isn't this app, keyed by
  // filename — and needs no attacker; the rest are what a hostile archive tries.
  const UNSENDABLE_IDS = ['cover.png', 'a/b', '../x', 'a b', 'é', ''];

  // An unsendable ref does not fail loudly. The blob's put (or, with no blob in
  // the archive, the delete a later edit queues) is rejected by the request
  // contract before it leaves the device, on every cycle, and the push that
  // carries it takes the metadata puts and the pull behind it down too — a
  // library that looks restored and has silently stopped syncing.
  it.each(FILE_REFS)('refuses the %s line whose %s cannot form a sync path', (kind, field) => {
    for (const id of UNSENDABLE_IDS) {
      expect(classifyBundleLine(withFileRef(kind, field, id))).toBeUndefined();
    }
  });

  // The control for the cluster above: a gate that refused every line carrying a
  // ref would pass it, and would empty the images out of every real backup.
  it.each(FILE_REFS)('keeps the %s line whose %s is an id this app mints', (kind, field) => {
    const entry = classifyBundleLine(withFileRef(kind, field, MINTED_ID));

    expect(entry?.kind).toBe(kind);
    expect(entry?.data).toEqual({ ...ENTITIES[kind].data, [field]: MINTED_ID });
  });

  // A timestamp the calendar cannot name passes every entity schema — they ask
  // for an integer — and then throws in the first reader that formats it. A
  // restore writes what it admits verbatim and syncs it to every device, so this
  // is the edge that has to refuse it. Listed by hand for the reason FILE_REFS
  // is: a new clock on an entity has to be added here.
  const CLOCKS = [
    ['link', 'createdAt'],
    ['link', 'updatedAt'],
    ['list', 'createdAt'],
    ['list', 'updatedAt'],
    ['tag', 'createdAt'],
    ['tag', 'updatedAt'],
    ['pin', 'createdAt'],
    ['pin', 'updatedAt'],
    ['extraction', 'createdAt'],
    ['extraction', 'updatedAt'],
    ['settings', 'createdAt'],
    ['settings', 'updatedAt'],
  ] as const;
  const LAST_INSTANT = 8.64e15;

  const withClock = (kind: (typeof CLOCKS)[number][0], field: string, value: number): string =>
    jsonlLine(ENTITIES[kind].path, { ...ENTITIES[kind].data, [field]: value });

  it.each(CLOCKS)('refuses the %s line whose %s is outside the calendar', (kind, field) => {
    expect(classifyBundleLine(withClock(kind, field, LAST_INSTANT + 1))).toBeUndefined();
    expect(classifyBundleLine(withClock(kind, field, -LAST_INSTANT - 1))).toBeUndefined();
  });

  // The control: the last instant on each side is a date, and a line carrying it
  // comes back with the value untouched — refused or verbatim, never re-dated.
  it.each(CLOCKS)('keeps the %s line whose %s is the last instant either way', (kind, field) => {
    for (const value of [LAST_INSTANT, -LAST_INSTANT]) {
      const entry = classifyBundleLine(withClock(kind, field, value));

      expect(entry?.kind).toBe(kind);
      expect(entry?.data).toEqual({ ...ENTITIES[kind].data, [field]: value });
    }
  });

  // An extraction's third clock is per FACET — `facets.<name>.extractedAt`, where
  // the schema defines it. A gate that looked for it on the extraction itself
  // would check a field no writer produces and pass every real one.
  const withFacetClock = (extractedAt: number): string =>
    jsonlLine(ENTITIES.extraction.path, {
      ...ENTITIES.extraction.data,
      facets: {
        titleImage: { status: 'done', attempts: 1, extractedAt: 1 },
        screenshot: { status: 'failed', attempts: 2, extractedAt },
      },
    });

  it('refuses the extraction line with a facet extracted outside the calendar', () => {
    expect(classifyBundleLine(withFacetClock(LAST_INSTANT + 1))).toBeUndefined();
    expect(classifyBundleLine(withFacetClock(-LAST_INSTANT - 1))).toBeUndefined();
  });

  // "A bad line is reported, never fatal" has to hold for a line built to break
  // the gate itself. JSON.parse makes `__proto__` an ordinary own key, the record
  // schema skips it unvalidated, and the gate walks the raw object — so a value
  // there that cannot be turned into a number must be passed over, not handed to
  // `Date`, which would throw and take the whole restore with it.
  it('does not throw on a facet key the schema never validated', () => {
    const line =
      '{"path":"extractions/lnk1.enc","data":{"id":"lnk1","createdAt":1,"updatedAt":1,' +
      '"facets":{"__proto__":{"extractedAt":{"valueOf":1,"toString":1}}}}}';

    expect(() => classifyBundleLine(line)).not.toThrow();
  });

  it('keeps the extraction line whose facets were extracted inside it', () => {
    expect(classifyBundleLine(withFacetClock(LAST_INSTANT))?.kind).toBe('extraction');
    expect(classifyBundleLine(withFacetClock(1_700_000_000_000))?.kind).toBe('extraction');
  });

  // The gate and the wire contract are one question asked at two edges, and this
  // is where they are held against each other. An id the reader admits and
  // `syncPathSchema` refuses is the unsendable op itself; the reverse is a backup
  // this app wrote and cannot read back.
  it.each([...UNSENDABLE_IDS, MINTED_ID, 'aZ09_-'])(
    'admits the ref %j exactly when the wire contract can send its path',
    (id) => {
      const sendable = syncPathSchema.safeParse(pathFromId(id, FILES_PREFIX)).success;

      for (const [kind, field] of FILE_REFS) {
        expect(classifyBundleLine(withFileRef(kind, field, id)) !== undefined).toBe(sendable);
      }
    },
  );
});

describe('referencedFileIds', () => {
  it('collects every blob ref a link or extraction carries, and nothing else', () => {
    const entries: BundleEntry[] = [
      { path: 'links/a.enc', kind: 'link', data: { ...link, customImageId: 'img-a' } },
      {
        path: 'extractions/a.enc',
        kind: 'extraction',
        data: {
          id: 'a',
          facets: {},
          imageId: 'img-b',
          pageCopyId: 'copy-a',
          screenshotId: 'shot-a',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { path: 'links/b.enc', kind: 'link', data: link },
      {
        path: 'pins/a.enc',
        kind: 'pin',
        data: { id: 'a', rank: RANKS[0], createdAt: 1, updatedAt: 1 },
      },
    ];
    expect(referencedFileIds(entries)).toEqual(new Set(['img-a', 'img-b', 'copy-a', 'shot-a']));
  });

  it('yields each id once even when two entities share a blob', () => {
    // The exporter writes one `files/{id}` entry per id, so a duplicate here
    // would write the same bytes into the archive twice.
    const entries: BundleEntry[] = [
      { path: 'links/a.enc', kind: 'link', data: { ...link, customImageId: 'img-a' } },
      { path: 'links/b.enc', kind: 'link', data: { ...link, customImageId: 'img-a' } },
    ];
    expect(referencedFileIds(entries)).toEqual(new Set(['img-a']));
  });

  it('yields nothing for no entries', () => {
    expect(referencedFileIds([])).toEqual(new Set());
  });
});

// A restore keeps a repeated path's first line, which is the one its writer
// keeps, so the depth rule after it measures what is written
// (docs/data-lifecycle.md, _a backup's list or tag chain_).
describe('firstLinePerPath', () => {
  const [RANK] = ranksBetween(null, null, 1);
  const list = (id: string, name: string): BundleEntry => ({
    kind: 'list',
    path: pathFromId(id, LISTS_PREFIX),
    data: { id, name, parentId: null, rank: RANK, createdAt: 1, updatedAt: 1 },
  });

  it('keeps the first line for each path, in file order', () => {
    const [a1, b, a2, c, b2] = [
      list('a', '1'),
      list('b', '1'),
      list('a', '2'),
      list('c', '1'),
      list('b', '2'),
    ];
    expect(firstLinePerPath([a1, b, a2, c, b2])).toEqual([a1, b, c]);
  });

  it('hands back a file with no repeats unchanged', () => {
    const lines = [list('a', '1'), list('b', '1')];
    expect(firstLinePerPath(lines)).toEqual(lines);
  });
});

// The depth rule a backup is held to: a list or tag line deeper than
// TREE_MAX_DEPTH, measured in the file, is restored AT that level — its
// `parentId` moved to its ancestor on the level above — and nothing else about
// the file changes (docs/data-limits.md). Each side of the bound is pinned, so
// a rule that counted one level off — or not at all — fails here.
describe('flattenBackupTree', () => {
  const [RANK] = ranksBetween(null, null, 1);
  const LIMIT = TREE_MAX_DEPTH;

  function node(kind: 'list' | 'tag', id: string, parentId: string | null): BundleEntry {
    return {
      kind,
      path: pathFromId(id, kind === 'list' ? LISTS_PREFIX : TAGS_PREFIX),
      data: { id, name: id, parentId, rank: RANK, createdAt: 1, updatedAt: 1 },
    };
  }

  // `length` ids chained root-first: c0 is the root, c{length-1} the deepest.
  function chain(kind: 'list' | 'tag', length: number, prefix = 'c', top: string | null = null) {
    return Array.from({ length }, (_, i) =>
      node(kind, `${prefix}${i}`, i === 0 ? top : `${prefix}${i - 1}`),
    );
  }

  const parentOf = (entries: BundleEntry[], id: string) =>
    (entries.find((entry) => entry.path.includes(`/${id}.`))?.data as { parentId: string | null })
      .parentId;
  const moved = (entries: BundleEntry[]) => [...flattenBackupTree(entries).flattenedPaths].sort();

  it.each(['list', 'tag'] as const)('leaves a %s chain of exactly the limit as it is', (kind) => {
    const entries = chain(kind, LIMIT);
    const result = flattenBackupTree(entries);
    expect(result.flattenedPaths.size).toBe(0);
    expect(result.entries).toEqual(entries);
  });

  // c100 and c101 sit on levels 101 and 102; both go beside c99, under c98 —
  // the deepest one following its parent there rather than staying inside it.
  it.each(['list', 'tag'] as const)('places a %s past the limit at it', (kind) => {
    const entries = chain(kind, LIMIT + 2);
    const result = flattenBackupTree(entries);
    const prefix = kind === 'list' ? LISTS_PREFIX : TAGS_PREFIX;
    expect([...result.flattenedPaths].sort()).toEqual(
      [pathFromId(`c${LIMIT}`, prefix), pathFromId(`c${LIMIT + 1}`, prefix)].sort(),
    );
    expect(parentOf(result.entries, `c${LIMIT}`)).toBe(`c${LIMIT - 2}`);
    expect(parentOf(result.entries, `c${LIMIT + 1}`)).toBe(`c${LIMIT - 2}`);
    expect(parentOf(result.entries, `c${LIMIT - 1}`)).toBe(`c${LIMIT - 2}`);
    // Only `parentId` moves; the line is otherwise the one the file holds.
    const before = entries[LIMIT].data as Record<string, unknown>;
    const after = result.entries[LIMIT].data as Record<string, unknown>;
    expect({ ...after, parentId: before.parentId }).toEqual(before);
    // Every other line is passed through untouched, in order.
    expect(result.entries.slice(0, LIMIT)).toEqual(entries.slice(0, LIMIT));
  });

  // A verdict about the file, not about the order its lines come in.
  it('moves the same lines in any line order', () => {
    const deep = chain('list', LIMIT + 3);
    expect(moved([...deep].reverse())).toEqual(moved(deep));
    const shuffled = deep.filter((_, i) => i % 2 === 0).concat(deep.filter((_, i) => i % 2));
    expect(moved(shuffled)).toEqual(moved(deep));
  });

  // A parent the file doesn't carry — a list only the library holds — ends the
  // chain where the file does.
  it('counts only the levels the file carries', () => {
    expect(moved(chain('list', LIMIT, 'c', 'not-in-file'))).toEqual([]);
  });

  // A system list's default stands in for one the file doesn't carry, so a
  // chain under My List is measured from the level My List sits on.
  it('counts a system list the file leaves out', () => {
    expect(moved(chain('list', LIMIT, 'c', MY_LIST_ID))).toEqual([
      pathFromId(`c${LIMIT - 1}`, LISTS_PREFIX),
    ]);
  });

  // Lists and tags are two trees: a tag naming a list as parent joins nothing.
  it('measures lists and tags apart', () => {
    const lists = chain('list', LIMIT, 'x');
    const tags = chain('tag', LIMIT, 'y', `x${LIMIT - 1}`);
    expect(moved([...lists, ...tags])).toEqual([]);
  });

  // A loop is cut where buildTree cuts it — the read edge's own rule — and
  // measured as the chain that leaves.
  it('measures a loop as the read edge cuts it', () => {
    const loop = (length: number) =>
      Array.from({ length }, (_, i) => node('list', `l${i}`, `l${(i + 1) % length}`));
    expect(moved(loop(LIMIT))).toEqual([]);
    expect(moved(loop(LIMIT + 1))).toHaveLength(1);
  });

  // ...and the cut is stored: a line the loop cut made a root is restored at
  // the top level, where every device already shows it, and nothing else on it
  // or on the rest of the loop changes. Not counted as placed.
  it('stores the cut a loop makes', () => {
    const loop = [node('list', 'l0', 'l1'), node('list', 'l1', 'l2'), node('list', 'l2', 'l0')];
    const result = flattenBackupTree(loop);
    expect(result.flattenedPaths.size).toBe(0);
    expect(result.entries).toEqual([
      { ...loop[0], data: { ...loop[0].data, parentId: null } },
      loop[1],
      loop[2],
    ]);
    expect(parentOf(flattenBackupTree([node('list', 'self', 'self')]).entries, 'self')).toBeNull();
  });

  // A root for any other reason keeps its line: a parent the file doesn't hold
  // may be one the library does, and Trash never takes a child.
  it('keeps a missing or a no-children parent as written', () => {
    const entries = [node('list', 'p', 'not-in-file'), node('list', 't', TRASH_ID)];
    expect(flattenBackupTree(entries).entries).toEqual(entries);
  });

  // A loop with tails, in the form that beat placement: a loop m1 ⇄ m2,
  // and chains of 99 whose tops the cut detaches (each top's id is below every
  // id after it on its walk), chain k+1 hanging off chain k's bottom. Measured
  // as cut, every chain is 99 levels and nothing is placed; stored as written,
  // one Move up on m1's row — which writes its effective parent, null — joined
  // them into one chain three hundred deep.
  it.each(['list', 'tag'] as const)(
    'restores a %s loop with tails as a tree no edit can release',
    (kind) => {
      const tails = 3;
      const entries = [node(kind, 'm1', 'm2'), node(kind, 'm2', 'm1')];
      let below = 'm2';
      for (let k = 1; k <= tails; k++) {
        const top = `a${tails - k + 1}`;
        entries.push(node(kind, top, below), ...chain(kind, LIMIT - 2, `z${k}-`, top));
        below = `z${k}-${LIMIT - 3}`;
      }
      const result = flattenBackupTree(entries);
      expect(result.flattenedPaths.size).toBe(0);
      for (const id of ['m1', 'a1', 'a2', 'a3']) expect(parentOf(result.entries, id)).toBeNull();

      const prefix = kind === 'list' ? LISTS_PREFIX : TAGS_PREFIX;
      const items = (lines: BundleEntry[]) =>
        lines.map((entry) => ({
          ...(entry.data as { parentId: string | null; rank: string }),
          id: entry.path.slice(prefix.length, -'.enc'.length),
        }));
      const levels = (lines: BundleEntry[]) =>
        flattenTree(buildTree(items(lines))).reduce((most, n) => Math.max(most, n.depth + 1), 0);
      // No stored edge the read edge ignores: every row sits under the parent
      // its line names, so the editors' own rule measures every later move.
      for (const row of flattenToRows(buildTree(items(result.entries)), new Set())) {
        expect(row.parentId).toBe(row.item.parentId);
      }
      const m1 = pathFromId('m1', prefix);
      const release = result.entries.map((entry) =>
        entry.path === m1 ? { ...entry, data: { ...entry.data, parentId: null } } : entry,
      );
      expect(levels(result.entries)).toBe(LIMIT - 1);
      expect(levels(release)).toBe(LIMIT - 1);
    },
  );

  // The file chooses the depth, so the walk must not take a call frame per
  // level: a hundred thousand chained lines would overflow the stack of one
  // that did. Pinned by that crash, never by a clock — the build and the walk
  // are buildTree's and parentsPastMaxDepth's, each on its own heap stack
  // (testing.md, _jest cannot time out a synchronous test_).
  it('settles a very deep chain without recursing', () => {
    const deep = chain('list', 100_000);
    expect(flattenBackupTree([...deep].reverse()).flattenedPaths.size).toBe(100_000 - LIMIT);
  });

  it('ignores every other kind', () => {
    expect(flattenBackupTree([])).toEqual({ entries: [], flattenedPaths: new Set() });
    const links: BundleEntry[] = Array.from({ length: LIMIT + 1 }, (_, i) => ({
      kind: 'link',
      path: `links/k${i}.enc`,
      data: { ...link, parentId: i === 0 ? null : `k${i - 1}` },
    }));
    expect(moved(links)).toEqual([]);
  });
});
