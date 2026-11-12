// The server tier's read-mode copy, through the real mutations into fake-indexeddb. What
// is pinned is what nothing else would notice going wrong:
//
//   - a copy is stored as a `files/` blob the extraction NAMES (`readModeId`), gzipped
//     like every other tier's, with the facet `done` at the `server` tier;
//   - a copy that already exists — or lands while the request runs — is never replaced
//     (it may be a live-page capture, a better tier; and highlights will anchor to it);
//   - a settled reason is recorded `permanent` with its `reason`, a passing one `failed`;
//     and a server `failed` never overwrites a better tier's settled answer;
//   - a transport failure records nothing.
import {
  decodeReaderImages,
  type ExtractClient,
  extractionFileIds,
  EXTRACTIONS_PREFIX,
  type ExtractResult,
  FILES_PREFIX,
  type LinkItem,
  LINKS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  READER_STORE_MAX_BLOCKS,
  type ReaderDoc,
  UnreadablePathError,
} from '@stxapps/shared';

import { db } from '../data/db';
import { writeExtraction, writeSettingsGeneral } from '../data/mutations';
import { readExtraction } from '../data/queries';
import { recordUnreadablePaths, seedNewAccount } from '../data/sync-store';
import { decodeReaderDoc } from './reader-doc-bytes';
import { encodeReaderImage } from './reader-image';
import { runServerReadMode } from './server-read-mode';
import { storeReadModeCopy } from './store-read-mode';

// The image encoder needs a canvas jsdom doesn't have; a seam, so the storing around
// it runs for real (store-read-mode.ts, through the real mutations).
jest.mock('./reader-image', () => ({ encodeReaderImage: jest.fn() }));

const USER = 'alice';
const URL_A = 'https://example.com/a';
const LINK: LinkItem = {
  path: pathFromId('l_1', LINKS_PREFIX),
  url: URL_A,
  listId: MY_LIST_ID,
  tagIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const DOC: ReaderDoc = {
  version: 1,
  capturedAt: 5,
  sourceUrl: URL_A,
  blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept words.' }] }],
};

function client(result: Partial<ExtractResult> | (() => Promise<ExtractResult>)): ExtractClient {
  const extractReadMode = jest.fn(
    typeof result === 'function' ? result : async () => ({ url: URL_A, ok: true, ...result }),
  );
  return { extractReadMode } as unknown as ExtractClient;
}

const readFileBytes = async (id: string) =>
  (await db.items.get(pathFromId(id, FILES_PREFIX)))?.data as Uint8Array | undefined;

beforeEach(async () => {
  await db.syncMeta.clear();
  await seedNewAccount(USER);
  await Promise.all([db.items.clear(), db.pendingOps.clear()]);
});

it('stores the copy as a gzipped blob the extraction names, at the server tier', async () => {
  expect(await runServerReadMode(USER, LINK, client({ readMode: DOC }))).toEqual({ kind: 'kept' });

  const extraction = await readExtraction('l_1');
  expect(extraction?.readModeId).toEqual(expect.any(String));
  expect(extraction?.facets.readMode).toMatchObject({ status: 'done', extractedBy: 'server' });
  const bytes = await readFileBytes(extraction?.readModeId ?? '');
  expect(bytes).toBeDefined();
  expect(await decodeReaderDoc(bytes ?? new Uint8Array())).toEqual(DOC);
});

it('asks nothing of the extractor, and stores nothing, for a link whose extraction this device could not open', async () => {
  // A refusal after the round trip would leave the pack and the text uploaded with no
  // extraction naming them, so the question is asked first.
  await recordUnreadablePaths(USER, [
    { path: pathFromId('l_1', EXTRACTIONS_PREFIX), updatedAt: 1 },
  ]);
  const extractor = client({ readMode: DOC });

  await expect(runServerReadMode(USER, LINK, extractor)).rejects.toThrow(UnreadablePathError);

  expect(extractor.extractReadMode).not.toHaveBeenCalled();
  expect(await db.items.count()).toBe(0);
  expect(await db.pendingOps.count()).toBe(0);
});

it('keeps nothing, and writes no blob, when the store itself is handed a copy past the ceilings', async () => {
  // The browser extension's walker runs in the page's isolated world and calls the store
  // directly, so the store applies the ceilings itself, before any blob is written.
  const blocks = Array.from({ length: READER_STORE_MAX_BLOCKS + 1 }, (_, i) => ({
    id: `b${i}`,
    kind: 'rule',
  }));

  await expect(
    storeReadModeCopy(USER, 'l_1', { ...DOC, blocks }, [], 'extension:fg'),
  ).resolves.toBe(false);

  expect(await db.items.count()).toBe(0);
  expect(await db.pendingOps.count()).toBe(0);
});

it('settles a document past the store edge’s size ceilings as not an article, storing nothing', async () => {
  // The extractor is another machine; what it returns is held to the same ceilings as a capture.
  const blocks = Array.from({ length: READER_STORE_MAX_BLOCKS + 1 }, (_, i) => ({
    id: `b${i}`,
    kind: 'rule',
  }));

  const outcome = await runServerReadMode(USER, LINK, client({ readMode: { ...DOC, blocks } }));

  expect(outcome).toEqual({ kind: 'none', status: 'permanent', reason: 'not-an-article' });
  const extraction = await readExtraction('l_1');
  expect(extraction?.readModeId).toBeUndefined();
  expect(extraction?.facets.readMode).toMatchObject({ status: 'permanent', extractedBy: 'server' });
  expect(await db.items.where('path').startsWith('files/').count()).toBe(0);
});

describe('the article’s images', () => {
  const ILLUSTRATED: ReaderDoc = {
    version: 1,
    capturedAt: 5,
    sourceUrl: URL_A,
    blocks: [
      { id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept words.' }] },
      { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0' },
      { id: 'b2', kind: 'figure', text: 'A photo', image: 'i1' },
    ],
  };
  const SOURCES = [
    { key: 'i0', url: 'https://cdn.example/chart.png' },
    { key: 'i1', url: 'https://cdn.example/photo.jpg' },
  ];
  const JPEG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3,
  ]);

  function illustrated(fetchImage: ExtractClient['fetchImage']): ExtractClient {
    return {
      extractReadMode: jest.fn(async () => ({
        url: URL_A,
        ok: true,
        readMode: ILLUSTRATED,
        readModeImages: SOURCES,
      })),
      fetchImage,
    } as unknown as ExtractClient;
  }

  beforeEach(() => {
    jest
      .mocked(encodeReaderImage)
      .mockResolvedValue({ bytes: JPEG, type: 'image/jpeg', width: 640, height: 320 });
  });

  it('keeps what the proxy could fetch in ONE pack the extraction names', async () => {
    const fetchImage = jest.fn(async (url: string) => {
      if (url.endsWith('photo.jpg')) throw new Error('429');
      return new Uint8Array([9]);
    });

    await writeSettingsGeneral(USER, { keepReadModeImages: true });

    expect(await runServerReadMode(USER, LINK, illustrated(fetchImage))).toEqual({ kind: 'kept' });

    const extraction = await readExtraction('l_1');
    // A field of the EXTRACTION: the orphan sweep, the backup and the destroy paths
    // find a blob's references there, and nowhere inside the document.
    expect(extraction?.readModeImagesId).toEqual(expect.any(String));
    expect(extractionFileIds(extraction)).toContain(extraction?.readModeImagesId);
    const pack = decodeReaderImages(
      (await readFileBytes(extraction?.readModeImagesId ?? '')) ?? new Uint8Array(),
    );
    expect(pack).toEqual([{ key: 'i0', type: 'image/jpeg', width: 640, height: 320, bytes: JPEG }]);

    const doc = await decodeReaderDoc(
      (await readFileBytes(extraction?.readModeId ?? '')) ?? new Uint8Array(),
    );
    expect(doc?.blocks).toEqual([
      { id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept words.' }] },
      { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0', width: 640, height: 320 },
      // The proxy refused this one: a placeholder, with no key to a picture it lacks.
      { id: 'b2', kind: 'figure', text: 'A photo' },
    ]);
    // The addresses were for the fetch. Nothing stored names one.
    expect(JSON.stringify(doc)).not.toContain('cdn.example');
    expect(JSON.stringify(extraction)).not.toContain('cdn.example');
  });

  it('with images off (the default), fetches none and stores a document that names none', async () => {
    const fetchImage = jest.fn(async () => new Uint8Array([9]));

    await runServerReadMode(USER, LINK, illustrated(fetchImage));

    expect(fetchImage).not.toHaveBeenCalled();
    const extraction = await readExtraction('l_1');
    expect(extraction?.readModeImagesId).toBeUndefined();
    const doc = await decodeReaderDoc(
      (await readFileBytes(extraction?.readModeId ?? '')) ?? new Uint8Array(),
    );
    expect(JSON.stringify(doc)).not.toMatch(/"image"/);
  });

  it('keeps the words when every image fails', async () => {
    await writeSettingsGeneral(USER, { keepReadModeImages: true });
    const fetchImage = jest.fn(async () => {
      throw new Error('offline');
    });

    expect(await runServerReadMode(USER, LINK, illustrated(fetchImage))).toEqual({ kind: 'kept' });

    const extraction = await readExtraction('l_1');
    expect(extraction?.readModeId).toEqual(expect.any(String));
    expect(extraction?.readModeImagesId).toBeUndefined();
  });
});

it('never replaces a copy that exists, and asks the server nothing for it', async () => {
  await writeExtraction(USER, 'l_1', { fields: { readModeId: 'mine' } });
  const extractor = client({ readMode: DOC });

  expect(await runServerReadMode(USER, LINK, extractor)).toEqual({ kind: 'exists' });
  expect(extractor.extractReadMode).not.toHaveBeenCalled();
  expect((await readExtraction('l_1'))?.readModeId).toBe('mine');
});

it('leaves a copy that landed while the request ran', async () => {
  const extractor = client(async () => {
    await writeExtraction(USER, 'l_1', { fields: { readModeId: 'extension' } });
    return { url: URL_A, ok: true, readMode: DOC };
  });

  expect(await runServerReadMode(USER, LINK, extractor)).toEqual({ kind: 'exists' });
  expect((await readExtraction('l_1'))?.readModeId).toBe('extension');
});

it.each([['not-an-article'], ['not-html'], ['robots-disallowed']])(
  'settles %s as permanent, with the reason on the facet',
  async (reason) => {
    const outcome = await runServerReadMode(USER, LINK, client({ readModeReason: reason }));
    expect(outcome).toEqual({ kind: 'none', status: 'permanent', reason });
    expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({
      status: 'permanent',
      extractedBy: 'server',
      reason,
    });
  },
);

it('records an unreadable robots.txt — or a reason it does not know — as failed', async () => {
  await runServerReadMode(USER, LINK, client({ readModeReason: 'robots-unavailable' }));
  expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({ status: 'failed' });

  const outcome = await runServerReadMode(
    USER,
    LINK,
    client({ readModeReason: 'from-the-future' }),
  );
  expect(outcome).toMatchObject({ kind: 'none', status: 'failed' });
});

it('settles a 404 the way the title does', async () => {
  const outcome = await runServerReadMode(
    USER,
    LINK,
    client(async () => ({ url: URL_A, ok: false, error: 'bad_status', status: 404 })),
  );
  expect(outcome).toMatchObject({ kind: 'none', status: 'permanent' });
});

it('never overwrites a better tier’s settled answer with a server failure', async () => {
  await writeExtraction(USER, 'l_1', {
    facet: 'readMode',
    state: {
      status: 'permanent',
      extractedBy: 'extension:fg',
      extractedAt: 1,
      attempts: 0,
      reason: 'not-an-article',
    },
  });

  await runServerReadMode(USER, LINK, client({ readModeReason: 'robots-unavailable' }));
  expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({
    status: 'permanent',
    extractedBy: 'extension:fg',
  });
});

it('records nothing on a transport failure — it throws instead', async () => {
  const extractor = client(async () => {
    throw new TypeError('network');
  });
  await expect(runServerReadMode(USER, LINK, extractor)).rejects.toThrow('network');
  expect(await readExtraction('l_1')).toBeUndefined();
});
