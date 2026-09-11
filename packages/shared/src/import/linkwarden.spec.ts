import { detectTextImportFormat } from './detect';
import { parseLinkwardenExport } from './linkwarden';
import { parseImportText } from './parse';

// LinkWarden's backup.json, rule by rule.
//
// NO REAL SPECIMEN, and that is stated here rather than left to be discovered:
// the shape these fixtures are built from comes from LinkWarden's own export
// controller (`exportData.ts` returns the user's Prisma row minus `password` and
// the user's id) and is corroborated by two independent readers of real
// backups — karakeep's zod schema for its LinkWarden importer, and the community
// `backup.json` → Netscape converter. That is a stronger footing than memory and
// a weaker one than a file: everything below agrees with our parser by
// construction, which is exactly the limit `brace-export.spec.ts` and
// `netscape-exports.spec.ts` exist to escape for the formats where we DO have
// one. A real export (`docs/testing.md`, _import specimens_) replaces the first
// case here and nothing else.
//
// The fixtures deliberately put the user's scalar columns FIRST, because that is
// where a real file puts them and it is what the detection probe has to survive.
const BACKUP = JSON.stringify({
  name: 'Ada',
  username: 'ada',
  email: 'ada@example.com',
  emailVerified: null,
  collections: [
    {
      id: 1,
      name: 'Reading',
      parentId: null,
      description: 'things to read',
      links: [
        {
          id: 10,
          name: 'The hunt for the fish pirates',
          url: 'https://example.com/fish',
          description: 'A note the user typed',
          tags: [
            { id: 5, name: 'oceans' },
            { id: 6, name: 'story' },
          ],
          createdAt: '2024-03-01T10:00:00.000Z',
          updatedAt: '2024-03-02T10:00:00.000Z',
        },
        {
          // An uploaded PDF: LinkWarden stores the document, and the row has no
          // address at all.
          id: 11,
          name: 'A scanned paper',
          url: null,
          type: 'pdf',
          tags: [],
          createdAt: '2024-03-01T10:00:00.000Z',
        },
      ],
    },
    {
      id: 2,
      name: 'Specs',
      parentId: 1,
      links: [
        {
          id: 12,
          name: '',
          url: 'https://example.com/spec',
          description: '   ',
          tags: [],
          createdAt: '2024-01-05T00:00:00.000Z',
        },
      ],
    },
  ],
  pinnedLinks: [{ id: 12 }, { id: 10 }],
});

describe('parseLinkwardenExport', () => {
  it('reads collections, tags, notes and dates out of a backup', () => {
    const links = parseLinkwardenExport(BACKUP);

    expect(links).toEqual([
      {
        url: 'https://example.com/fish',
        customTitle: 'The hunt for the fish pirates',
        note: 'A note the user typed',
        tagNames: ['oceans', 'story'],
        folderPath: ['Reading'],
        createdAt: Date.parse('2024-03-01T10:00:00.000Z'),
        updatedAt: Date.parse('2024-03-02T10:00:00.000Z'),
        pinRank: '000001',
      },
      {
        url: 'https://example.com/spec',
        // An empty `name` is not a title, and a whitespace-only `description` is
        // not a note — LinkWarden shows the URL for the first and nothing for
        // the second, and writing either through would put a blank string where
        // the display fold expects an absence.
        tagNames: [],
        folderPath: ['Reading', 'Specs'],
        createdAt: Date.parse('2024-01-05T00:00:00.000Z'),
        pinRank: '000000',
      },
    ]);
  });

  it('files a link under its whole collection chain, root first', () => {
    const deep = JSON.stringify({
      collections: [
        { id: 1, name: 'A', parentId: null, links: [] },
        { id: 2, name: 'B', parentId: 1, links: [] },
        {
          id: 3,
          name: 'C',
          parentId: 2,
          links: [{ id: 9, url: 'https://example.com/c', tags: [] }],
        },
      ],
    });

    expect(parseLinkwardenExport(deep)[0].folderPath).toEqual(['A', 'B', 'C']);
  });

  // The one that isn't about correctness of the result but about the import
  // FINISHING: a `parentId` cycle makes the parent walk non-terminating, and an
  // import that hangs reports nothing, retries nothing and looks like a hung app.
  // Reachable from a hand-edited backup or a restore that reparented two
  // collections into each other.
  it('terminates on a parentId cycle instead of walking forever', () => {
    const cyclic = JSON.stringify({
      collections: [
        {
          id: 1,
          name: 'A',
          parentId: 2,
          links: [{ id: 9, url: 'https://example.com/a', tags: [] }],
        },
        { id: 2, name: 'B', parentId: 1, links: [] },
      ],
    });

    const links = parseLinkwardenExport(cyclic);
    expect(links).toHaveLength(1);
    // Each name appears once; which end the walk stops at is not the point.
    expect([...links[0].folderPath].sort()).toEqual(['A', 'B']);
  });

  it('ends the chain at a parent the file does not contain', () => {
    // LinkWarden can share a collection whose parent belongs to someone else, so
    // a dangling parentId is a NORMAL file rather than a corrupt one.
    const orphan = JSON.stringify({
      collections: [
        {
          id: 7,
          name: 'Shared',
          parentId: 999,
          links: [{ id: 9, url: 'https://example.com/s', tags: [] }],
        },
      ],
    });

    expect(parseLinkwardenExport(orphan)[0].folderPath).toEqual(['Shared']);
  });

  // Pins are a separate relation holding the SAME rows, so the failure to guard
  // against is importing each pinned link twice — and the ranks have to sort in
  // the file's order, which a bare index stringifies wrong past nine.
  it('marks pinned rows without importing them twice, in the order the file lists', () => {
    const many = JSON.stringify({
      collections: [
        {
          id: 1,
          name: 'C',
          parentId: null,
          links: Array.from({ length: 12 }, (_unused, index) => ({
            id: index,
            url: `https://example.com/${index}`,
            tags: [],
          })),
        },
      ],
      pinnedLinks: Array.from({ length: 12 }, (_unused, index) => ({ id: 11 - index })),
    });

    const links = parseLinkwardenExport(many);
    expect(links).toHaveLength(12);

    const ranked = links
      .filter((link) => link.pinRank !== undefined)
      .sort((a, b) => (a.pinRank ?? '').localeCompare(b.pinRank ?? ''));
    expect(ranked).toHaveLength(12);
    expect(ranked.map((link) => link.url)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => `https://example.com/${11 - index}`),
    );
  });

  it('yields nothing for an object that carries no collections', () => {
    expect(parseLinkwardenExport('{"name":"Ada"}')).toEqual([]);
    expect(parseLinkwardenExport('{"collections":{}}')).toEqual([]);
  });

  it('skips a collection whose links are missing, and a row that is not an object', () => {
    const ragged = JSON.stringify({
      collections: [
        { id: 1, name: 'No links', parentId: null },
        {
          id: 2,
          name: 'Ragged',
          parentId: null,
          links: [null, 3, { url: 'https://example.com/ok' }],
        },
      ],
    });

    expect(parseLinkwardenExport(ragged).map((link) => link.url)).toEqual([
      'https://example.com/ok',
    ]);
  });
});

describe('a LinkWarden backup through the dispatch', () => {
  // The whole reason the format exists as a branch: without the probe this file
  // is TEXT, and the URL-extracting parser mines the raw JSON — no collections,
  // no tags, no dates, and no error to notice. The count is the tell: text
  // mining finds every URL-shaped string in the file, not the ones it declares.
  it('is routed by structure, not mined as text', () => {
    expect(detectTextImportFormat(BACKUP, 'backup.json')).toBe('linkwarden');

    const bundle = parseImportText(BACKUP, 'backup.json');
    expect(bundle.images.size).toBe(0);
    expect(bundle.links.map((link) => link.folderPath)).toEqual([
      ['Reading'],
      ['Reading', 'Specs'],
    ]);
  });

  // A link's `name` carries whatever the page's <title> did, which is how the
  // two scans below get triggered on a file that is neither. Same hazard the
  // Brace.to probe documents, one format over.
  it('outranks the `</a>` scan and the CSV header row on a title that looks like either', () => {
    const nasty = JSON.stringify({
      name: 'Ada',
      collections: [
        {
          id: 1,
          name: 'C',
          parentId: null,
          links: [
            { id: 1, name: 'Closing </a> in a title', url: 'https://example.com/a', tags: [] },
            { id: 2, name: 'url,folder,title,note', url: 'https://example.com/b', tags: [] },
          ],
        },
      ],
    });

    expect(detectTextImportFormat(nasty, 'backup.json')).toBe('linkwarden');
    expect(parseImportText(nasty, 'backup.json').links).toHaveLength(2);
  });

  it('leaves a JSON object with no collections to the text parser, as before', () => {
    // Karakeep's own export is `{ bookmarks: [...] }` — not ours to parse, and
    // the degrade it gets is the one every unknown format gets.
    const karakeep = JSON.stringify({ bookmarks: [{ content: { url: 'https://example.com/k' } }] });
    expect(detectTextImportFormat(karakeep, 'karakeep.json')).toBe('text');
  });
});
