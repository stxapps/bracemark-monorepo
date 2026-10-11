import { type Link, LINK_NOTE_MAX } from '../sync/entities';
import {
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  LISTS_PREFIX,
  pathFromId,
  PINS_PREFIX,
} from '../sync/paths';
import { ranksBetween } from '../sync/rank';
import { ARCHIVE_ID, MY_LIST_ID, TRASH_ID } from '../sync/system-lists';
import type { ImportedLink } from './bundle';
import {
  PROJECT_CHUNK,
  type ProjectedImport,
  projectImportedLinks,
  projectImportedLinksInChunks,
  type ProjectImportOptions,
} from './project';
import { IMPORT_MAX_FOLDER_DEPTH, ImportFolderDepthError } from './resolve';

// The pure half of an import: rows in, every blob the run will write out. It is
// where an import's USER-VISIBLE behaviour is decided — which list a row lands in,
// which title is held above extraction, how a pin is ranked — and it has to
// decide it identically on web and expo, which is the whole reason it isn't in
// either orchestrator.
//
// Almost everything here is silent when wrong: an import that files a row in the
// wrong list, dates it 1970, or drops a pin still finishes and still reports the
// same counts. The two orchestrators' own tests can only see the counts.

const NOW = 1_700_000_000_000;

// Deterministic stand-in for the platform's newId (web-crypto / expo-crypto).
function idMinter(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

function row(over: Partial<ImportedLink> & { url: string }): ImportedLink {
  return { tagNames: [], folderPath: [], ...over };
}

function project(over: Partial<ProjectImportOptions> = {}): ProjectedImport {
  return projectImportedLinks({
    rows: [],
    lists: [],
    tags: [],
    existingPinRanks: [],
    images: new Map(),
    newId: idMinter(),
    now: NOW,
    ...over,
  });
}

const under = (result: ProjectedImport, prefix: string) =>
  result.entries.filter((entry) => entry.path.startsWith(prefix));
const linksOf = (result: ProjectedImport) =>
  under(result, LINKS_PREFIX).map((entry) => entry.data as Link);

describe('projectImportedLinks', () => {
  it('orders the write so nothing ever references an entity that is not stored yet', () => {
    // Lists and tags, then links with their extractions, then pins. The orchestrators
    // write this in CHUNKS, so a boundary in the wrong place leaves a link pointing at
    // a list that does not exist — survivable (the read layer skips it) but free to
    // avoid, and invisible unless the order is asserted here.
    const result = project({
      rows: [
        row({
          url: 'https://example.com/a',
          title: 'A',
          folderPath: ['Work'],
          tagNames: ['dev'],
          pinRank: 'aa',
        }),
      ],
    });

    expect(result.entries.map((entry) => entry.path.split('/')[0])).toEqual([
      'lists',
      'tags',
      'links',
      'extractions',
      'pins',
    ]);
    expect(result).toMatchObject({ linkCount: 1, listCount: 1, tagCount: 1, invalidCount: 0 });
  });

  it('stamps undated rows descending from now, so the file’s order is the library’s', () => {
    // Every interop format has rows with no date at all (a plain URL list, a CSV
    // with no `created` column). Giving them all `now` would leave the library
    // ordered by nothing in particular the moment the import lands.
    const result = project({
      rows: [
        row({ url: 'https://example.com/a' }),
        row({ url: 'https://example.com/b' }),
        row({ url: 'https://example.com/c' }),
      ],
    });

    expect(linksOf(result).map((link) => link.createdAt)).toEqual([NOW, NOW - 1, NOW - 2]);
  });

  it('keeps a row’s own dates, and never lets updatedAt precede createdAt', () => {
    // Real exports carry both (a Brace revision, a Raindrop row), and some carry an
    // `updatedAt` older than the creation stamp. Storing that inverted pair puts a
    // link's own history out of order for every later LWW comparison.
    const result = project({
      rows: [
        row({ url: 'https://example.com/a', createdAt: 5_000, updatedAt: 1_000 }),
        row({ url: 'https://example.com/b', createdAt: 5_000, updatedAt: 9_000 }),
        row({ url: 'https://example.com/c', createdAt: 5_000 }),
      ],
    });

    expect(linksOf(result).map((link) => [link.createdAt, link.updatedAt])).toEqual([
      [5_000, 5_000],
      [5_000, 9_000],
      [5_000, 5_000],
    ]);
  });

  it('sends a row with no folder to the default list, minting nothing', () => {
    const result = project({ rows: [row({ url: 'https://example.com/a' })] });

    expect(linksOf(result)[0].listId).toBe(MY_LIST_ID);
    expect(result.listCount).toBe(0);
  });

  it('builds the whole folder chain as a tree, on every plan', () => {
    // The projection takes NO entitlement: a path is the tree it describes, and the
    // `nestedLists` paywall lives on the reparent affordances instead (see the
    // header). This used to flatten to one root list named "Work/Specs" for an
    // unentitled account, so the assertion is the regression guard for a gate that
    // was removed on purpose — it is not a substitute for one that is missing.
    const rows = [row({ url: 'https://example.com/a', folderPath: ['Work', 'Specs'] })];

    const result = project({ rows });

    expect(result.listCount).toBe(2);
    expect(under(result, 'lists/').map((entry) => entry.data)).toEqual([
      expect.objectContaining({ name: 'Work', parentId: null }),
      expect.objectContaining({ name: 'Specs' }),
    ]);
    // The deeper segment hangs off the shallower one, not off the root.
    const [work, specs] = under(result, 'lists/').map(
      (entry) => entry.data as { id: string; parentId: string | null },
    );
    expect(specs.parentId).toBe(work.id);
    expect(linksOf(result)[0].listId).toBe(specs.id);
  });

  it('files a system-list row by ID, ignoring any folder name it carries', () => {
    // Named, never name-matched: resolving `['Archive']` by name would mint a
    // duplicate list on an account whose Archive was renamed, and Trash is
    // deliberately unmatchable there.
    const result = project({
      rows: [
        row({ url: 'https://example.com/a', systemList: 'archive', folderPath: ['Archive'] }),
        row({ url: 'https://example.com/b', systemList: 'trash', folderPath: ['Whatever'] }),
      ],
    });

    expect(linksOf(result).map((link) => link.listId)).toEqual([ARCHIVE_ID, TRASH_ID]);
    expect(result.listCount).toBe(0);
  });

  it('reuses the library’s existing list and tag instead of minting a twin', () => {
    const [rank] = ranksBetween(null, null, 1);
    const result = project({
      rows: [row({ url: 'https://example.com/a', folderPath: ['work'], tagNames: ['DEV'] })],
      lists: [{ id: 'l1', name: 'Work', parentId: null, rank }],
      tags: [{ id: 't1', name: 'dev', parentId: null, rank }],
    });

    expect(linksOf(result)[0]).toMatchObject({ listId: 'l1', tagIds: ['t1'] });
    expect(result).toMatchObject({ listCount: 0, tagCount: 0 });
  });

  it('writes one blob per distinct image reference and shares it between rows', () => {
    // Two links can point at one image (a Brace export does this), and a row whose
    // reference has no bytes must still import — just without its custom image.
    const bytes = new Uint8Array([1, 2, 3]);
    const result = project({
      rows: [
        row({ url: 'https://example.com/a', imageRef: 'kept.png' }),
        row({ url: 'https://example.com/b', imageRef: 'kept.png' }),
        row({ url: 'https://example.com/c', imageRef: 'missing.png' }),
      ],
      images: new Map([['kept.png', bytes]]),
    });

    const links = linksOf(result);
    expect(links[0].customImageId).toBeDefined();
    expect(links[1].customImageId).toBe(links[0].customImageId);
    expect(links[2].customImageId).toBeUndefined();
    expect(result.files).toEqual([
      { path: pathFromId(links[0].customImageId as string, FILES_PREFIX), data: bytes },
    ]);
    expect(result.linkCount).toBe(3);
  });

  // The orchestrators write `files` BEFORE `entries` and both write edges queue a
  // put for each, so a blob selected for a row that is then refused is stored,
  // uploaded and charged to the account with no link naming it. Nothing reports
  // it: the receipt counts the refused row, and the image is simply there. The
  // refusal below is a fractional date, which the schema still refuses outright.
  const REFUSED = { createdAt: 1.5 };

  it('selects no blob for a row the schema refuses', () => {
    const result = project({
      rows: [row({ url: 'https://example.com/bad', imageRef: 'only.png', ...REFUSED })],
      images: new Map([['only.png', new Uint8Array([1, 2, 3])]]),
    });

    expect(result).toMatchObject({ invalidCount: 1, linkCount: 0 });
    expect(result.files).toEqual([]);
  });

  // A refused row and an accepted one can name the same image, in either order.
  // Refused-first is the case a "skip the ref once seen" map gets wrong: the
  // refused row would claim the reference and the accepted row's image would be
  // dropped with it.
  it.each([
    ['refused first', ['bad', 'good']],
    ['accepted first', ['good', 'bad']],
  ] as const)('keeps one blob for an image shared with a refused row (%s)', (_, order) => {
    const bytes = new Uint8Array([4, 5, 6]);
    const result = project({
      rows: order.map((name) =>
        row({
          url: `https://example.com/${name}`,
          imageRef: 'shared.png',
          ...(name === 'bad' ? REFUSED : {}),
        }),
      ),
      images: new Map([['shared.png', bytes]]),
    });

    const [good] = linksOf(result);
    expect(result).toMatchObject({ invalidCount: 1, linkCount: 1 });
    expect(good.url).toBe('https://example.com/good');
    expect(result.files).toEqual([
      { path: pathFromId(good.customImageId as string, FILES_PREFIX), data: bytes },
    ]);
  });

  // A date the calendar cannot name passes `z.number().int()` and then throws in
  // whichever reader first asks for it as a string — the web list row did, in
  // render. It arrives legitimately: a microsecond timestamp read as milliseconds
  // is one. The row is the user's bookmark either way, so it is kept and dated as
  // an undated row would be.
  describe('a date outside the calendar', () => {
    const LAST_INSTANT = 8.64e15;

    it('is treated as no date, each of the two on its own', () => {
      const result = project({
        rows: [
          row({ url: 'https://example.com/both', createdAt: LAST_INSTANT + 1, updatedAt: -9e15 }),
          row({ url: 'https://example.com/created', createdAt: LAST_INSTANT + 1, updatedAt: 500 }),
          row({ url: 'https://example.com/updated', createdAt: 400, updatedAt: LAST_INSTANT + 1 }),
        ],
      });

      expect(result).toMatchObject({ invalidCount: 0, linkCount: 3 });
      expect(linksOf(result).map(({ createdAt, updatedAt }) => ({ createdAt, updatedAt }))).toEqual(
        [
          // Both gone: the undated row's descending stamp.
          { createdAt: NOW, updatedAt: NOW },
          // The stamp replaces createdAt; updatedAt may not precede it.
          { createdAt: NOW - 1, updatedAt: NOW - 1 },
          { createdAt: 400, updatedAt: 400 },
        ],
      );
    });

    // The control: a gate that dropped every unusual date would pass the case
    // above. The last representable instant on each side is a real date.
    it('keeps the last instant the calendar can name, on both sides', () => {
      const result = project({
        rows: [
          row({ url: 'https://example.com/late', createdAt: LAST_INSTANT }),
          row({ url: 'https://example.com/early', createdAt: -LAST_INSTANT, updatedAt: 0 }),
        ],
      });

      expect(linksOf(result).map(({ createdAt, updatedAt }) => ({ createdAt, updatedAt }))).toEqual(
        [
          { createdAt: LAST_INSTANT, updatedAt: LAST_INSTANT },
          { createdAt: -LAST_INSTANT, updatedAt: 0 },
        ],
      );
    });

    it('never reaches the extraction or the pin written beside the link', () => {
      const result = project({
        rows: [
          row({
            url: 'https://example.com/a',
            title: 'A',
            pinRank: 'aa',
            createdAt: LAST_INSTANT + 1,
            updatedAt: LAST_INSTANT + 2,
          }),
        ],
      });

      const stamps = [...under(result, EXTRACTIONS_PREFIX), ...under(result, PINS_PREFIX)].map(
        (entry) => entry.data as { createdAt: number; updatedAt: number },
      );
      expect(stamps).toHaveLength(2);
      for (const { createdAt, updatedAt } of stamps) {
        expect(createdAt).toBe(NOW);
        expect(updatedAt).toBe(NOW);
      }
    });
  });

  // Every segment of a folder path becomes a list, so the file decides how deep
  // the library's tree is unless something says otherwise. The whole file is
  // refused, before anything is minted: a refusal that came after resolution
  // would leave the half-built chain behind as empty lists.
  describe('a folder chain past the import limit', () => {
    const chain = (depth: number) => Array.from({ length: depth }, (_, i) => `f${i}`);

    it('builds a chain exactly at the limit', () => {
      const result = project({
        rows: [row({ url: 'https://example.com/a', folderPath: chain(IMPORT_MAX_FOLDER_DEPTH) })],
      });

      expect(result).toMatchObject({ linkCount: 1, listCount: IMPORT_MAX_FOLDER_DEPTH });
      expect(under(result, LISTS_PREFIX)).toHaveLength(IMPORT_MAX_FOLDER_DEPTH);
    });

    it('refuses the file one level deeper, before minting anything', () => {
      let minted = 0;
      const run = () =>
        project({
          rows: [
            row({ url: 'https://example.com/shallow', folderPath: ['Work'] }),
            row({
              url: 'https://example.com/deep',
              folderPath: chain(IMPORT_MAX_FOLDER_DEPTH + 1),
            }),
          ],
          newId: () => `new-${++minted}`,
        });

      expect(run).toThrow(ImportFolderDepthError);
      expect(minted).toBe(0);
    });

    it('rejects the chunked projection the orchestrators call, too', async () => {
      await expect(
        projectImportedLinksInChunks(
          {
            rows: [
              row({ url: 'https://example.com/a', folderPath: chain(IMPORT_MAX_FOLDER_DEPTH + 1) }),
            ],
            lists: [],
            tags: [],
            existingPinRanks: [],
            images: new Map(),
            newId: idMinter(),
            now: NOW,
          },
          async () => undefined,
        ),
      ).rejects.toThrow(ImportFolderDepthError);
    });

    it('does not count the path of a system-list row, which is never resolved', () => {
      const result = project({
        rows: [
          row({
            url: 'https://example.com/a',
            systemList: 'archive',
            folderPath: chain(IMPORT_MAX_FOLDER_DEPTH + 1),
          }),
        ],
      });

      expect(result).toMatchObject({ linkCount: 1, listCount: 0 });
    });
  });

  it('keeps the source extractor’s title provisional and the user’s own title deliberate', () => {
    // A source that keeps the two apart (Brace) hands over both: the title the
    // user saw lands in `customTitle`, above the extraction our background
    // extractor may still upgrade. Collapsing the two would either freeze a page
    // title as a user edit or let extraction overwrite one.
    const result = project({
      rows: [
        row({
          url: 'https://example.com/a',
          title: '  The   page \n title ',
          customTitle: ' What I called it ',
        }),
      ],
    });

    expect(linksOf(result)[0].customTitle).toBe('What I called it');
    const [extraction] = under(result, EXTRACTIONS_PREFIX);
    expect(extraction.data).toMatchObject({ id: 'new-1', title: 'The page title', facets: {} });
    // The extraction shadows the link's own path — same id, different namespace.
    expect(extraction.path).toBe('extractions/new-1.enc');
  });

  it('leaves a source extractor’s title OUT of customTitle', () => {
    // The other half of the same rule: `title` is only ever what the SOURCE's
    // extractor found, and a machine's title held as `customTitle` would outrank
    // ours forever. (A format that can't tell the two apart sends its one title as
    // `customTitle` instead — see ImportedLink.customTitle.)
    const result = project({ rows: [row({ url: 'https://example.com/a', title: 'Page title' })] });

    expect(linksOf(result)[0].customTitle).toBeUndefined();
    expect(under(result, EXTRACTIONS_PREFIX)[0].data).toMatchObject({ title: 'Page title' });
  });

  it('writes no extraction for a row with no usable title', () => {
    // An empty extraction would mark the link as having a machine-derived title of
    // nothing, where an ABSENT one leaves it pending for the real extractor.
    const result = project({
      rows: [
        row({ url: 'https://example.com/a' }),
        row({ url: 'https://example.com/b', title: '  ' }),
      ],
    });

    expect(under(result, EXTRACTIONS_PREFIX)).toEqual([]);
    expect(linksOf(result).every((link) => link.customTitle === undefined)).toBe(true);
  });

  // What a producer writes when it has no title is the address — Delicious names
  // a bare-domain bookmark after its domain (__fixtures__/netscape). Held as
  // `customTitle` it shows nothing the host fallback wouldn't, and blocks the
  // page's real title for good; left out, the link waits for extraction.
  it('drops a title that only restates the address', () => {
    const result = project({
      rows: [
        row({ url: 'http://fontfamily.io/', customTitle: 'fontfamily.io' }),
        row({ url: 'https://www.example.com/a/', customTitle: 'https://www.example.com/a' }),
        row({ url: 'https://example.com/a', customTitle: 'Example.com' }),
        row({ url: 'https://example.com/b', customTitle: 'example.com/b — notes' }),
      ],
    });

    expect(linksOf(result).map((link) => link.customTitle)).toEqual([
      undefined,
      undefined,
      undefined,
      'example.com/b — notes',
    ]);
  });

  it('truncates an over-long note instead of failing the row', () => {
    // The row is a stranger's data — a Raindrop note can be paragraphs. Truncating
    // keeps the link; handing the schema 4 KB would count it invalid and drop it.
    const result = project({
      rows: [row({ url: 'https://example.com/a', note: 'x'.repeat(LINK_NOTE_MAX + 50) })],
    });

    expect(linksOf(result)[0].note).toHaveLength(LINK_NOTE_MAX);
    expect(result.invalidCount).toBe(0);
  });

  it('counts a row the schema refuses and writes nothing at all for it', () => {
    // "Reported, never fatal" — one unusable row must not sink the import, and it
    // must not leave an extraction behind pointing at a link that was never written.
    const result = project({
      rows: [
        row({ url: 'https://example.com/bad', title: 'Bad', createdAt: 1.5 }),
        row({ url: 'https://example.com/good', title: 'Good' }),
      ],
    });

    expect(result).toMatchObject({ invalidCount: 1, linkCount: 1 });
    expect(linksOf(result).map((link) => link.url)).toEqual(['https://example.com/good']);
    expect(under(result, EXTRACTIONS_PREFIX)).toHaveLength(1);
  });

  it('re-ranks pins into this library’s keyspace, after the ones already pinned', () => {
    // The source's ranks are OPAQUE (Brace stores LexoRank): only their sequence
    // survives. Carrying the strings themselves would interleave a foreign keyspace
    // with this one, and appending before the user's existing pins would reorder a
    // shelf they arranged by hand.
    const existing = ranksBetween(null, null, 2);
    const result = project({
      rows: [
        row({ url: 'https://example.com/third', pinRank: 'ccc' }),
        row({ url: 'https://example.com/first', pinRank: 'aaa' }),
        row({ url: 'https://example.com/second', pinRank: 'bbb' }),
      ],
      existingPinRanks: existing,
    });

    const pins = under(result, PINS_PREFIX).map(
      (entry) => entry.data as { id: string; rank: string },
    );
    const idByUrl = new Map(linksOf(result).map((link, i) => [link.url, `new-${i + 1}`]));

    // Ordered by the source's sequence, not the file's row order.
    expect(pins.map((pin) => pin.id)).toEqual([
      idByUrl.get('https://example.com/first'),
      idByUrl.get('https://example.com/second'),
      idByUrl.get('https://example.com/third'),
    ]);
    // Fresh keys, ascending, all after every existing pin.
    expect(pins.map((pin) => pin.rank)).not.toEqual(['aaa', 'bbb', 'ccc']);
    expect([...pins.map((pin) => pin.rank)].sort()).toEqual(pins.map((pin) => pin.rank));
    expect(pins[0].rank > existing[1]).toBe(true);
    // A pin shadows its link's path — same id, different namespace.
    expect(under(result, PINS_PREFIX).map((entry) => entry.path)).toEqual(
      pins.map((pin) => `pins/${pin.id}.enc`),
    );
  });

  it('pins nothing when no row was pinned', () => {
    const result = project({ rows: [row({ url: 'https://example.com/a' })] });
    expect(under(result, PINS_PREFIX)).toEqual([]);
  });
});

// The chunked driver web awaits so a big import doesn't freeze the page
// (docs/data-lifecycle.md, _main-thread cost_). Both drivers run one generator,
// and these pin the two ways that could still go wrong: the chunked run
// producing a different import, and the pause never being taken — which would
// look like success everywhere except a frozen tab.
describe('projectImportedLinksInChunks', () => {
  // A mix that exercises every branch whose state spans rows — the list and tag
  // resolvers, the shared image, the pins — across more than one chunk boundary.
  const rows = Array.from({ length: PROJECT_CHUNK * 2 + 7 }, (_, i) =>
    row({
      url: `https://example.com/${i}`,
      title: `Title ${i}`,
      folderPath: [`Folder ${i % 5}`],
      tagNames: [`tag-${i % 3}`],
      ...(i % 400 === 0 ? { pinRank: String(i).padStart(6, '0') } : {}),
      ...(i % 250 === 0 ? { imageRef: 'shared' } : {}),
    }),
  );
  const options = (): ProjectImportOptions => ({
    rows,
    lists: [],
    tags: [],
    existingPinRanks: [],
    images: new Map([['shared', new Uint8Array([1, 2, 3])]]),
    newId: idMinter(),
    now: NOW,
  });

  it('produces exactly what the synchronous projection produces', async () => {
    const chunked = await projectImportedLinksInChunks(options(), async () => undefined);
    expect(chunked).toEqual(projectImportedLinks(options()));
  });

  it('pauses between chunks, and only between them', async () => {
    let pauses = 0;
    await projectImportedLinksInChunks(options(), async () => {
      pauses += 1;
    });
    expect(pauses).toBe(Math.ceil(rows.length / PROJECT_CHUNK) - 1);
  });
});
