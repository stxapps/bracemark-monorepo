import { parseImportText } from '../import/parse';
import { assertImportFolderDepth } from '../import/project';
import type { ListItem } from '../sync/items';
import {
  bundleFromLibrary,
  EXPORT_MAX_FOLDER_DEPTH,
  type ExportBundle,
  type ExportFolder,
  type ExportLinkRow,
  foldersPastMaxDepth,
} from './bundle';
import { toRaindropCsv } from './csv';
import { toNetscapeHtml } from './netscape';

function link(over: Partial<ExportLinkRow> = {}): ExportLinkRow {
  return {
    url: 'https://example.com/a',
    title: 'Example',
    tagNames: [],
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    updatedAt: Date.UTC(2026, 0, 2, 3, 4, 6),
    ...over,
  };
}

function folder(
  name: string,
  links: ExportLinkRow[] = [],
  children: ExportFolder[] = [],
): ExportFolder {
  return { name, links, children };
}

function bundle(folders: ExportFolder[]): ExportBundle {
  return { folders, exportedAt: 0 };
}

describe('toRaindropCsv', () => {
  it('emits only the header for an empty bundle, CRLF-terminated', () => {
    expect(toRaindropCsv(bundle([]))).toBe('url,folder,title,note,tags,created\r\n');
  });

  it('writes one row per link with the slash-joined folder path and ISO created', () => {
    const csv = toRaindropCsv(bundle([folder('Parent', [], [folder('Child', [link()])])]));
    const rows = csv.trimEnd().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe('https://example.com/a,Parent/Child,Example,,,2026-01-02T03:04:05.000Z');
  });

  it('joins tag names with commas inside one quoted cell', () => {
    const csv = toRaindropCsv(bundle([folder('L', [link({ tagNames: ['a', 'b'] })])]));
    expect(csv).toContain(',"a,b",');
  });

  it('quotes fields containing commas, quotes, or newlines and doubles inner quotes', () => {
    const csv = toRaindropCsv(
      bundle([folder('A,B', [link({ title: 'say "hi"', note: 'line1\nline2' })])]),
    );
    expect(csv).toContain('"A,B"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('carries the note — the reason this format exists beside Netscape HTML', () => {
    // csv.ts's header says CSV is preferred for Raindrop precisely because HTML
    // has no slot for `note`, and nothing checked that the note reaches its
    // column. The quoting test above passes a note but only asserts its quoting.
    const csv = toRaindropCsv(bundle([folder('L', [link({ note: 'why I saved this' })])]));
    const row = csv.trimEnd().split('\r\n')[1];

    expect(row).toBe('https://example.com/a,L,Example,why I saved this,,2026-01-02T03:04:05.000Z');
  });

  it('writes a top-level folder with no leading slash', () => {
    // The `parentPath === ''` branch: the only test of the path join used a
    // Parent/Child pair, so a root link emitting `/Parent` would have passed.
    const csv = toRaindropCsv(bundle([folder('Parent', [link()])]));
    expect(csv.trimEnd().split('\r\n')[1]).toContain(',Parent,');
  });

  it('emits rows in walk order — a folder’s own links before its children’s', () => {
    const csv = toRaindropCsv(
      bundle([
        folder(
          'A',
          [link({ url: 'https://a.test/1' }), link({ url: 'https://a.test/2' })],
          [folder('B', [link({ url: 'https://b.test/1' })])],
        ),
        folder('C', [link({ url: 'https://c.test/1' })]),
      ]),
    );
    const urls = csv
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((row) => row.split(',')[0]);

    expect(urls).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://b.test/1',
      'https://c.test/1',
    ]);
  });
});

// The serializers in export/ and the parsers in import/ are documented as read
// mirrors of each other (both bundle.ts headers say so), and nothing tested the
// pair: every assertion above is a substring of the written file. A user
// exporting their library and importing it back is the one path that exercises
// both halves, and it goes through DETECTION too — a file we write but do not
// recognise re-imports as the wrong format.
// What a stored library can hold that no export this app writes would produce.
// Both arrive by a restored backup or a sync from another device, and both used
// to end the export with an exception instead of a file.
describe('toRaindropCsv over a library the import edges would now refuse', () => {
  it('leaves the created cell empty for a date the calendar cannot name', () => {
    // `toISOString` throws on it. One such link must cost one cell, not the file.
    const csv = toRaindropCsv(
      bundle([
        folder('F', [
          link({ url: 'https://example.com/before', title: 'Before' }),
          link({ url: 'https://example.com/odd', title: 'Odd', createdAt: 8.64e15 + 1 }),
          link({ url: 'https://example.com/after', title: 'After' }),
        ]),
      ]),
    );

    expect(csv.trimEnd().split('\r\n').slice(1)).toEqual([
      'https://example.com/before,F,Before,,,2026-01-02T03:04:05.000Z',
      'https://example.com/odd,F,Odd,,,',
      'https://example.com/after,F,After,,,2026-01-02T03:04:05.000Z',
    ]);
  });

  it('writes a list chain deeper than the call stack, library to file', () => {
    // bundleFromLibrary and the serializer both walked the tree recursively.
    const DEPTH = 20_000;
    const rows = toRaindropCsv(bundleFromLibrary([storedLink(DEPTH - 1)], chain(DEPTH), []))
      .trimEnd()
      .split('\r\n');

    expect(rows).toHaveLength(2);
    // The deepest list keeps its own name, under the ancestors the depth allows.
    const path = [...names(EXPORT_MAX_FOLDER_DEPTH - 1), `f${DEPTH - 1}`].join('/');
    expect(rows[1]).toBe(
      `https://example.com/f${DEPTH - 1},${path},Deep,,,2026-01-02T03:04:05.000Z`,
    );
  });
});

// One `parentId` chain of `depth` lists named f0, f1, … root first, and a link
// filed in the list at `index`.
function chain(depth: number): ListItem[] {
  return Array.from({ length: depth }, (_, i) => ({
    path: `lists/l${i}.enc`,
    id: `l${i}`,
    name: `f${i}`,
    parentId: i === 0 ? null : `l${i - 1}`,
    rank: 'a',
    createdAt: 0,
    updatedAt: 0,
  }));
}

function storedLink(index: number) {
  return {
    link: {
      url: `https://example.com/f${index}`,
      listId: `l${index}`,
      tagIds: [],
      customTitle: 'Deep',
      createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    },
    extraction: undefined,
  };
}

const names = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);

// Every row repeats its folder's path, so an unbounded chain made the file grow
// with the square of its depth: 10,000 nested lists, a link in each, ended the
// export in `RangeError: Invalid string length` with nothing saved.
describe('toRaindropCsv past EXPORT_MAX_FOLDER_DEPTH', () => {
  it('writes a list past the depth beside its parent’s children, under its own name', () => {
    const depth = EXPORT_MAX_FOLDER_DEPTH + 2;
    const links = [depth - 3, depth - 2, depth - 1].map(storedLink);
    const rows = toRaindropCsv(bundleFromLibrary(links, chain(depth), []))
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((row) => row.split(',')[1]);

    const top = names(EXPORT_MAX_FOLDER_DEPTH - 1);
    expect(rows).toEqual([
      [...top, `f${depth - 3}`].join('/'),
      [...top, `f${depth - 2}`].join('/'),
      [...top, `f${depth - 1}`].join('/'),
    ]);
  });

  it('writes 10,000 nested lists into a file this app’s import accepts', () => {
    const depth = 10_000;
    const links = Array.from({ length: depth }, (_, i) => storedLink(i));
    const bundle = bundleFromLibrary(links, chain(depth), []);
    const rows = parseImportText(toRaindropCsv(bundle)).links;

    expect(rows).toHaveLength(depth);
    expect(() => assertImportFolderDepth(rows)).not.toThrow();
    expect(rows.at(-1)?.folderPath).toEqual([
      ...names(EXPORT_MAX_FOLDER_DEPTH - 1),
      `f${depth - 1}`,
    ]);
    expect(foldersPastMaxDepth(bundle.folders)).toBe(depth - EXPORT_MAX_FOLDER_DEPTH);
  });
});

describe('toRaindropCsv → parseImportText', () => {
  const reimport = (text: string) => parseImportText(text).links;

  it('re-imports a library whose titles contain markup', () => {
    // What the detection reorder in import/detect.ts protects: a saved page
    // titled `Fixing a stray </a>` used to route this whole file to the Netscape
    // tokenizer, which found no anchors and imported ZERO links — the user's
    // entire library, silently. The end-to-end assertion belongs here, where the
    // file is produced, and not only in detect.spec.ts.
    const csv = toRaindropCsv(
      bundle([
        folder('Work', [
          link({ url: 'https://example.com/1', title: 'Fixing a stray </a>' }),
          link({ url: 'https://example.com/2', title: 'A <b>bold</b> title' }),
          link({ url: 'https://example.com/3', title: '<!DOCTYPE NETSCAPE-Bookmark-file-1>' }),
        ]),
      ]),
    );

    expect(reimport(csv).map((row) => [row.url, row.customTitle])).toEqual([
      ['https://example.com/1', 'Fixing a stray </a>'],
      ['https://example.com/2', 'A <b>bold</b> title'],
      ['https://example.com/3', '<!DOCTYPE NETSCAPE-Bookmark-file-1>'],
    ]);
  });

  it('recovers every field the format carries, detection included', () => {
    const csv = toRaindropCsv(
      bundle([
        folder('Parent', [], [folder('Child', [link({ note: 'a note', tagNames: ['x', 'y'] })])]),
      ]),
    );

    expect(reimport(csv)).toEqual([
      {
        url: 'https://example.com/a',
        customTitle: 'Example',
        note: 'a note',
        tagNames: ['x', 'y'],
        folderPath: ['Parent', 'Child'],
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      },
    ]);
  });

  it('keeps the note and the full millisecond createdAt that Netscape drops', () => {
    // This is the concrete trade-off csv.ts claims: HTML has no note slot, and
    // ADD_DATE is whole seconds. Asserting both halves here keeps the claim from
    // becoming stale in a comment.
    const created = Date.UTC(2026, 0, 2, 3, 4, 5) + 500;
    const rows = [link({ note: 'a note', createdAt: created })];
    const viaCsv = reimport(toRaindropCsv(bundle([folder('L', rows)])))[0];
    const viaHtml = reimport(toNetscapeHtml(bundle([folder('L', rows)])))[0];

    expect(viaCsv?.note).toBe('a note');
    expect(viaCsv?.createdAt).toBe(created);
    expect(viaHtml?.note).toBeUndefined();
    expect(viaHtml?.createdAt).toBe(created - 500);
  });

  // Two lossy cases inherent to the format rather than bugs — a separator is the
  // only structure a cell has. Pinned so the loss is a known property with a
  // test naming it, not a surprise in a bug report.
  it('cannot round-trip a separator inside a folder or tag name', () => {
    const csv = toRaindropCsv(bundle([folder('A/B', [link({ tagNames: ['a,b'] })])]));
    const row = reimport(csv)[0];

    expect(row?.folderPath).toEqual(['A', 'B']); // one list, read back as two
    expect(row?.tagNames).toEqual(['a', 'b']); // one tag, read back as two
  });
});
