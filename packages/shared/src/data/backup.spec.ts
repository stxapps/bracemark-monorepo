import { syncPathSchema } from '../sync/endpoints';
import { FILES_PREFIX, pathFromId } from '../sync/paths';
import { ranksBetween } from '../sync/rank';
import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  BRACEMARK_BACKUP_FORMAT,
  BRACEMARK_BACKUP_VERSION,
  type BundleEntry,
  classifyBundleLine,
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
    ['extraction', 'extractedAt'],
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
