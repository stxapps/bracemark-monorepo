import { detectTextImportFormat } from './detect';
import { parseLinkwardenExport } from './linkwarden';
import { parseImportText } from './parse';
import { assertImportFolderDepth } from './project';
import { IMPORT_MAX_FOLDER_DEPTH, ImportFolderDepthError, ListResolver } from './resolve';

// LinkWarden's backup.json, rule by rule.
//
// THE SPECIMEN IS NEXT DOOR NOW. This header used to open by saying there wasn't
// one — that these fixtures came from LinkWarden's export controller
// (`exportData.ts` returns the user's Prisma row minus `password` and the user's
// id) plus two second-hand readings of it, and so agreed with our parser by
// construction. `linkwarden-export.spec.ts` and
// `__fixtures__/linkwarden-export.json` are the escape from that, and they
// settled two things this file had wrong by inheritance: the archived copies ARE
// exported (as server-side paths, on the pinned rows only), and `createdAt` is
// the wrong date to read. Rules still belong HERE, one per case, where a fixture
// can be shaped to reach them — the specimen holds the relations a real library
// has and cannot be edited to test an edge.
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

  // `importDate` is the date the link was SAVED, carried over from wherever
  // LinkWarden imported it from; `createdAt` is when LinkWarden minted the row.
  // For anyone who arrived by import — most people — the second is the day they
  // switched apps, identical across their whole library. Both orders are here
  // because the fallback is what a link added by hand relies on.
  it('prefers importDate over createdAt, and falls back when there is none', () => {
    const dated = JSON.stringify({
      collections: [
        {
          id: 1,
          name: 'C',
          parentId: null,
          links: [
            {
              id: 1,
              url: 'https://example.com/imported',
              tags: [],
              importDate: '2019-06-01T00:00:00.000Z',
              createdAt: '2024-03-01T10:00:00.000Z',
            },
            {
              id: 2,
              url: 'https://example.com/added-here',
              tags: [],
              importDate: null,
              createdAt: '2024-03-01T10:00:00.000Z',
            },
          ],
        },
      ],
    });

    expect(parseLinkwardenExport(dated).map((link) => link.createdAt)).toEqual([
      Date.parse('2019-06-01T00:00:00.000Z'),
      Date.parse('2024-03-01T10:00:00.000Z'),
    ]);
  });

  // A `name` is LinkWarden's own scrape of the page's `<title>`, stored without
  // decoding — so an HTML entity in a JSON string is the producer's artifact, and
  // the title is the ONLY field it can be in: `description` is typed by the user
  // and so is a tag name.
  it('decodes an entity in the title and leaves the typed fields alone', () => {
    const escaped = JSON.stringify({
      collections: [
        {
          id: 1,
          name: 'C',
          parentId: null,
          links: [
            {
              id: 1,
              name: 'Ben &amp; Jerry&rsquo;s',
              url: 'https://example.com/e',
              description: 'Typed with an &amp; in it',
              tags: [{ id: 1, name: 'R&amp;D' }],
            },
          ],
        },
      ],
    });

    const [link] = parseLinkwardenExport(escaped);
    expect(link.customTitle).toBe('Ben & Jerry’s');
    expect(link.note).toBe('Typed with an &amp; in it');
    expect(link.tagNames).toEqual(['R&amp;D']);
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

  // WHERE it stops, which the case above declines to say and the parser's
  // comment does. Settling each collection once takes ONE edge out of a loop —
  // the parent of the collection that closes the first climb to reach it — so
  // every collection keeps one path — its parent's plus its own name, except
  // the one the cut files at the root — and here, where every collection is
  // named and holds a link, the loop mints a list per collection. The walk
  // before this one gave each member the whole loop rotated to end in itself:
  // three chains of three here, nine lists for the loop's three collections and
  // a tenth for T, which is what the resolver count refuses.
  //
  // And which edge goes is the FILE'S ORDER, not a property of the loop: the
  // same four collections listed from B are cut at a different edge. That is the
  // half nobody would guess, so it is pinned rather than left to be rediscovered
  // as a bug — a walk made order-independent has to change this case on purpose.
  //
  // A → B → C → A by `parentId`, and T hanging off B from outside the loop.
  it('cuts a parentId cycle at one edge, chosen by the order of the file', () => {
    const collection = { A: [1, 2], B: [2, 3], C: [3, 1], T: [4, 2] } as const;
    type Name = keyof typeof collection;
    const pathsIn = (order: Name[]) => {
      const links = parseLinkwardenExport(
        JSON.stringify({
          collections: order.map((name) => ({
            id: collection[name][0],
            name,
            parentId: collection[name][1],
            links: [{ id: 9, url: `https://example.com/${name}`, tags: [] }],
          })),
        }),
      );
      return Object.fromEntries(
        links.map((link) => [new URL(link.url).pathname.slice(1), link.folderPath]),
      );
    };
    const minted = (paths: Record<string, string[]>) => {
      let next = 0;
      const resolver = new ListResolver([], 0, () => `list-${next++}`);
      for (const path of Object.values(paths)) resolver.resolve(path);
      return resolver.created.length;
    };

    const fromA = pathsIn(['A', 'B', 'C', 'T']);
    expect(fromA).toEqual({ A: ['C', 'B', 'A'], B: ['C', 'B'], C: ['C'], T: ['C', 'B', 'T'] });
    expect(minted(fromA)).toBe(4);

    const fromB = pathsIn(['B', 'C', 'A', 'T']);
    expect(fromB).toEqual({
      A: ['A'],
      C: ['A', 'C'],
      B: ['A', 'C', 'B'],
      T: ['A', 'C', 'B', 'T'],
    });
    expect(minted(fromB)).toBe(4);

    // A climb that starts BELOW the loop cuts it where it came in: T enters at
    // B, so this is the listing from B again however the rest are ordered.
    expect(pathsIn(['T', 'A', 'B', 'C'])).toEqual(fromB);
  });

  // A chain of collections, each the parent of the next. `name` null leaves a
  // collection out of every path; `everyLink` puts a link in each collection
  // rather than only in the last.
  const chainOf = (length: number, name: (i: number) => string | null, everyLink = false) =>
    JSON.stringify({
      collections: Array.from({ length }, (_, i) => ({
        id: i + 1,
        name: name(i),
        parentId: i === 0 ? null : i,
        links:
          everyLink || i === length - 1
            ? [{ id: 9000 + i, url: `https://example.com/${i}`, tags: [] }]
            : [],
      })),
    });

  // FINISHING again, by the other road: no cycle, just depth. The walk used to
  // climb the whole chain from every collection, so the cost was the chain's
  // length per collection — and the depth rule could not help, because it reads
  // the rows this parse returns. Half a megabyte of nested EMPTY collections
  // took 25 seconds to parse.
  //
  // Pinned by what settling each collection ONCE leaves behind, not by a clock:
  // jest cannot time out a synchronous test, so a slow parse would only make
  // this file slow. A collection's path is its parent's plus one name, so paths
  // are shared — every collection past the depth limit holds the very same
  // array. Climb the chain again per collection and each gets its own.
  it('settles each collection of a long chain once', () => {
    const links = parseLinkwardenExport(chainOf(5_000, (i) => `c${i}`, true));

    expect(links).toHaveLength(5_000);
    // Not the whole chain — only enough of it to be refused (below).
    expect(links[4_999].folderPath.length).toBe(IMPORT_MAX_FOLDER_DEPTH + 1);
    expect(links[4_999].folderPath.slice(0, 3)).toEqual(['c0', 'c1', 'c2']);
    expect(new Set(links.map((link) => link.folderPath)).size).toBe(IMPORT_MAX_FOLDER_DEPTH + 1);
  });

  // The same chain with nothing to stop on: a collection with no name adds
  // nothing to a path, so a walk bounded only by NAMES would still climb all of
  // it from every collection. One shared empty path says it did not.
  it('settles a chain of unnamed collections once as well', () => {
    const links = parseLinkwardenExport(chainOf(5_000, () => null, true));

    expect(links).toHaveLength(5_000);
    expect(links[4_999].folderPath).toEqual([]);
    expect(new Set(links.map((link) => link.folderPath)).size).toBe(1);
  });

  // The parser stops extending a path once it is past the limit, which is only
  // sound if "past the limit" is still what the import refuses on — and if a
  // chain exactly AT the limit still arrives whole, name for name.
  it('carries a chain at the depth limit whole, and one past it far enough to be refused', () => {
    const names = Array.from({ length: IMPORT_MAX_FOLDER_DEPTH }, (_, i) => `c${i}`);
    const atLimit = parseLinkwardenExport(chainOf(IMPORT_MAX_FOLDER_DEPTH, (i) => `c${i}`));
    const pastLimit = parseLinkwardenExport(chainOf(IMPORT_MAX_FOLDER_DEPTH + 1, (i) => `c${i}`));

    expect(atLimit[0].folderPath).toEqual(names);
    expect(() => assertImportFolderDepth(atLimit)).not.toThrow();
    expect(() => assertImportFolderDepth(pastLimit)).toThrow(ImportFolderDepthError);
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
