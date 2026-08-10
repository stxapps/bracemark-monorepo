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

  // Older archives stay readable — that's the whole point of gating on `>`.
  it('accepts an older version', () => {
    const text = JSON.stringify({ format: BRACEMARK_BACKUP_FORMAT, version: 0, counts: {} });
    expect(parseBackupManifest(text).version).toBe(0);
  });
});

describe('classifyBundleLine', () => {
  it('classifies each namespace by its path', () => {
    expect(classifyBundleLine(jsonlLine('links/a.enc', link))?.kind).toBe('link');
    expect(
      classifyBundleLine(
        jsonlLine('lists/a.enc', {
          id: 'a',
          name: 'A',
          parentId: null,
          rank: RANKS[0],
          createdAt: 1,
          updatedAt: 1,
        }),
      )?.kind,
    ).toBe('list');
    expect(
      classifyBundleLine(
        jsonlLine('settings/general.enc', { linksLayout: 'list', createdAt: 1, updatedAt: 1 }),
      )?.kind,
    ).toBe('settings');
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
});
