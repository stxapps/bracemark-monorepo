import { TREE_MAX_DEPTH } from '../sync/tree';
import { parseBraceExport } from './brace';

// A Brace.to export entry. `data` is whatever that file held — `{}` for the
// marker families (sslts/pins/tags), the link object for `links/`.
function entry(path: string, data: unknown = {}) {
  return { path, data };
}

function link(id: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, url, addedDT: parseInt(id.split('-')[0], 10), ...extra };
}

function exportText(entries: { path: string; data: unknown }[]): string {
  return JSON.stringify(entries, null, 2);
}

const SETTINGS = entry('settings1700000000000abcd.json', {
  doExtractContents: true,
  layoutType: 'LAYOUT_CARD',
  listNameMap: [
    { listName: 'My List', displayName: 'My List' },
    { listName: 'Trash', displayName: 'Trash' },
    { listName: 'Archive', displayName: 'Archive' },
    {
      listName: '1600000000000-aaaa-bbbb',
      displayName: 'Work',
      children: [{ listName: '1600000000001-cccc-dddd', displayName: 'Specs' }],
    },
  ],
  tagNameMap: [{ tagName: '1600000000002-eeee-ffff', displayName: 'to read', color: '#f00' }],
});

describe('parseBraceExport', () => {
  it('reads links, resolving list ids to display-name folder paths', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/1600000000001-cccc-dddd/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a'),
        ),
        SETTINGS,
      ]),
    );

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      url: 'https://example.com/a',
      folderPath: ['Work', 'Specs'],
      createdAt: 1700000000000,
    });
  });

  it('keeps only the newest revision of an edited link', () => {
    // Brace writes one file per revision, all sharing the first two id segments;
    // importing them all would land the same link three times.
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/v1'),
        ),
        entry(
          'links/My List/1700000000000-abcd-efgh-1700000009999.json',
          link('1700000000000-abcd-efgh-1700000009999', 'https://example.com/v3'),
        ),
        entry(
          'links/My List/1700000000000-abcd-efgh-1700000005555.json',
          link('1700000000000-abcd-efgh-1700000005555', 'https://example.com/v2'),
        ),
        SETTINGS,
      ]),
    );

    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/v3');
    expect(links[0].updatedAt).toBe(1700000009999);
  });

  it('takes list membership from the newest sslt, not the link path', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a'),
        ),
        entry(
          'sslts/1600000000000-aaaa-bbbb/1700000001000/1700000000000/1700000000000-abcd-efgh.json',
        ),
        entry('sslts/Archive/1700000002000/1700000000000/1700000000000-abcd-efgh.json'),
        SETTINGS,
      ]),
    );

    expect(links[0].systemList).toBe('archive');
    expect(links[0].folderPath).toEqual([]);
  });

  it('names Archive and Trash rather than matching them by folder name', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/Archive/1700000000000-aaaa-1111.json',
          link('1700000000000-aaaa-1111', 'https://example.com/archived'),
        ),
        entry(
          'links/Trash/1700000000001-bbbb-2222.json',
          link('1700000000001-bbbb-2222', 'https://example.com/trashed'),
        ),
        entry(
          'links/My List/1700000000002-cccc-3333.json',
          link('1700000000002-cccc-3333', 'https://example.com/inbox'),
        ),
        SETTINGS,
      ]),
    );

    expect(links.map((l) => l.systemList)).toEqual(['archive', 'trash', undefined]);
    // My List is the default inbox on both sides, so it contributes no folder.
    expect(links[2].folderPath).toEqual([]);
  });

  it('splits the user title from the extracted one', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a', {
            extractedResult: {
              url: 'https://example.com/a',
              extractedDT: 1700000000000,
              status: 'EXTRACT_OK',
              title: 'The page title',
              image: 'https://cdn.example.com/og.png',
            },
            custom: { title: 'What I called it' },
          }),
        ),
        SETTINGS,
      ]),
    );

    expect(links[0].title).toBe('The page title');
    expect(links[0].customTitle).toBe('What I called it');
    // A remote image URL is never carried over — our extraction.imageId is a
    // downloaded blob, and fetching at import would leak the library.
    expect(links[0].imageRef).toBeUndefined();
  });

  it('resolves tag ids to display names, ordered by rank', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a'),
        ),
        entry(
          'tags/unknown-tag-id/0i0002/1700000000000/1700000000000/1700000000000-abcd-efgh.json',
        ),
        entry(
          'tags/1600000000002-eeee-ffff/0i0001/1700000000000/1700000000000/1700000000000-abcd-efgh.json',
        ),
        SETTINGS,
      ]),
    );

    // Unknown tag ids keep their raw name rather than vanishing.
    expect(links[0].tagNames).toEqual(['to read', 'unknown-tag-id']);
  });

  it('carries pins as an opaque ordering key', () => {
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-aaaa-1111.json',
          link('1700000000000-aaaa-1111', 'https://example.com/a'),
        ),
        entry(
          'links/My List/1700000000001-bbbb-2222.json',
          link('1700000000001-bbbb-2222', 'https://example.com/b'),
        ),
        entry('pins/0i0002_/1700000000000/1700000000000/1700000000000-aaaa-1111.json'),
        SETTINGS,
      ]),
    );

    expect(links[0].pinRank).toBe('0i0002_');
    expect(links[1].pinRank).toBeUndefined();
  });

  it('decodes a custom image and keeps only referenced blobs', () => {
    // "hi" as base64 — enough to prove the data-URL decode, no image needed.
    const dataUrl = 'data:image/png;base64,aGk=';
    const { links, images } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a', {
            custom: { image: 'cdroot/images/kept.png' },
          }),
        ),
        entry('images/kept.png', dataUrl),
        entry('images/orphan.png', dataUrl),
        SETTINGS,
      ]),
    );

    expect(links[0].imageRef).toBe('images/kept.png');
    expect([...images.keys()]).toEqual(['images/kept.png']);
    expect(images.get('images/kept.png')).toEqual(new Uint8Array([0x68, 0x69]));
  });

  // The name maps come from the NEWEST settings file, and an export carries every
  // revision of it — nothing else here has more than one.
  it('reads the newest settings file, whatever order the export lists them in', () => {
    const older = entry('settings1600000000000zzzz.json', {
      listNameMap: [{ listName: '1600000000000-aaaa-bbbb', displayName: 'What it used to be' }],
    });
    const newer = entry('settings1700000000000aaaa.json', {
      listNameMap: [{ listName: '1600000000000-aaaa-bbbb', displayName: 'Work' }],
    });
    const linkEntry = entry(
      'links/1600000000000-aaaa-bbbb/1700000000000-abcd-efgh.json',
      link('1700000000000-abcd-efgh', 'https://example.com/a'),
    );

    // Both orders, because the export's own order is not sorted and taking the
    // first (or the last) file seen would pass exactly one of these.
    expect(parseBraceExport(exportText([linkEntry, older, newer])).links[0].folderPath).toEqual([
      'Work',
    ]);
    expect(parseBraceExport(exportText([linkEntry, newer, older])).links[0].folderPath).toEqual([
      'Work',
    ]);
  });

  it('keeps a list the name map no longer knows as a visible folder', () => {
    // A list deleted after the link was filed has no display name left. Dropping
    // the folder would silently pour those links into the default list, where the
    // user cannot tell them apart from everything else.
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/1600000000009-dead-beef/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a'),
        ),
        SETTINGS,
      ]),
    );

    expect(links[0].folderPath).toEqual(['1600000000009-dead-beef']);
  });

  it('keeps a deep list under its own name, placed at the depth limit', () => {
    // One chain of nested lists, `list-<i>` named `f<i>` at level i + 1. The walk
    // used to stop at depth 20, dropping everything below from the name map, so
    // a link there was filed under its raw list id at the top level.
    const depth = TREE_MAX_DEPTH + 5;
    let node: Record<string, unknown> | undefined;
    for (let i = depth - 1; i >= 0; i--) {
      node = { listName: `list-${i}`, displayName: `f${i}`, children: node ? [node] : [] };
    }
    const names = Array.from({ length: depth }, (_, i) => `f${i}`);
    const settings = entry('settings1700000000000abcd.json', { listNameMap: [node] });
    const folders: string[][] = [];
    const observer = {
      row: () => undefined,
      folder: (path: string[]) => folders.push(path),
      damage: () => undefined,
    };

    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/list-29/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/level-30'),
        ),
        entry(
          `links/list-${depth - 1}/1700000000001-abcd-efgh.json`,
          link('1700000000001-abcd-efgh', 'https://example.com/deepest'),
        ),
        settings,
      ]),
      observer,
    );

    expect(links[0].folderPath).toEqual(names.slice(0, 30));
    expect(links[1].folderPath).toEqual([...names.slice(0, TREE_MAX_DEPTH), `f${depth - 1}`]);
    expect(Math.max(...folders.map((path) => path.length))).toBe(TREE_MAX_DEPTH + 1);
    expect(folders).toHaveLength(depth);
  });

  it('names a re-tagged tag once, not once per tags/ file', () => {
    // Re-tagging writes a SECOND file at a new rank rather than moving the first,
    // so a link can carry two entries naming one tag — which would resolve to the
    // same display name twice and mint a duplicate on the way in.
    const { links } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a'),
        ),
        entry(
          'tags/1600000000002-eeee-ffff/0i0001/1700000000000/1700000000000/1700000000000-abcd-efgh.json',
        ),
        entry(
          'tags/1600000000002-eeee-ffff/0i0009/1700000009999/1700000000000/1700000000000-abcd-efgh.json',
        ),
        SETTINGS,
      ]),
    );

    expect(links[0].tagNames).toEqual(['to read']);
  });

  it('re-keys an image written at an absolute on-device path (a phone-made export)', () => {
    // Brace's MOBILE export writes the device path instead of the `images/<fname>`
    // key its own importer expects. Without the re-key the blob simply never
    // matches a link's reference and every custom image is dropped — silently, on
    // exactly the exports made by the app most people used.
    const { links, images } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a', {
            custom: { image: 'cdroot/images/kept.png' },
          }),
        ),
        entry(
          '/var/mobile/Containers/Data/Application/ABCD/Documents/images/kept.png',
          'data:image/png;base64,aGk=',
        ),
        SETTINGS,
      ]),
    );

    expect(links[0].imageRef).toBe('images/kept.png');
    expect([...images.keys()]).toEqual(['images/kept.png']);
  });

  it('imports the link without its image when the blob is not a base64 data URL', () => {
    // The two halves have to agree: the parser keeps the REFERENCE and yields no
    // bytes, and the projection treats a ref with no bytes as "no custom image"
    // (project.ts) rather than a broken pointer.
    const { links, images } = parseBraceExport(
      exportText([
        entry(
          'links/My List/1700000000000-abcd-efgh.json',
          link('1700000000000-abcd-efgh', 'https://example.com/a', {
            custom: { image: 'cdroot/images/kept.png' },
          }),
        ),
        entry('images/kept.png', 'https://cdn.example.com/kept.png'),
        SETTINGS,
      ]),
    );

    expect(links).toHaveLength(1);
    expect(links[0].imageRef).toBe('images/kept.png');
    expect(images.size).toBe(0);
  });

  it('drops unstorable urls and survives junk', () => {
    expect(parseBraceExport('not json at all').links).toEqual([]);
    expect(parseBraceExport('{"path":"links/x"}').links).toEqual([]);
    expect(
      parseBraceExport(
        exportText([
          entry('links/My List/1700000000000-abcd-efgh.json', {
            id: '1700000000000-abcd-efgh',
            url: 'javascript:alert(1)',
            addedDT: 1700000000000,
          }),
          entry('links/My List/broken.json', { url: 'https://example.com/x' }),
          SETTINGS,
        ]),
      ).links,
    ).toEqual([]);
  });
});
