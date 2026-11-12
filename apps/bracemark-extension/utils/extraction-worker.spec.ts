import { UnreadablePathError } from '@stxapps/shared';
import type { ExtractionFacet } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import { runExtraction } from './extraction-worker';

// One facet of one link, captured from the ACTIVE TAB and written back. What is only
// true here — the captures themselves are pinned in capture.spec.ts, the write
// primitives in web-react — is the bookkeeping around them, and every rule in it is
// invisible when broken:
//
//   - THE WRITER SPLIT. This never touches `links/{id}.enc`, the user's file. Title,
//     image, read-mode and screenshot refs all land in `extractions/{id}.enc`
//     alongside the facet's own done/failed state, so a capture can't clobber a
//     concurrent user edit (docs/link-extraction.md).
//   - CONTENT BEFORE METADATA. `writeFile` precedes the `extractions/` write that
//     references it; the other order leaves a synced reference to a blob that
//     doesn't exist.
//   - THE STALE-TAB GUARD THROWS EARLY, before the try. `extension:fg` is `tierOf`'s
//     ceiling, so another page's title stored here can never be superseded — and
//     because it is OUR mistake rather than the host's, it must NOT burn the facet's
//     backoff. That distinction has no visible symptom: both paths throw.
//   - THE TITLE IS ITS OWN PASS. Written fields-only, with the facet left pending, so
//     a failure fetching the image can't cost the title.

// Typed with an open argument list: the source calls these with its own arguments
// and nothing here asserts on their shape.
const mockReadLinkById = jest.fn<Promise<unknown>, unknown[]>();
const mockWriteExtraction = jest.fn<Promise<void>, unknown[]>();
// The question a capture asks before it fetches or writes anything (web-react's
// assertExtractionWritable): resolves unless a test says the link may not be written.
const mockAssertExtractionWritable = jest.fn<Promise<void>, unknown[]>();
const mockWriteFile = jest.fn<Promise<void>, unknown[]>();
const mockResizeImage = jest.fn<Promise<Uint8Array>, unknown[]>();
const mockNewId = jest.fn<string, unknown[]>();
const mockStoreReadModeCopy = jest.fn<Promise<void>, unknown[]>();
const mockCollectReaderImages = jest.fn<Promise<unknown[]>, unknown[]>();
const mockReadSettingsGeneral = jest.fn<Promise<unknown>, unknown[]>();
const mockFetchReaderImage = jest.fn<Promise<Uint8Array | undefined>, unknown[]>();

const mockCaptureTitleImage = jest.fn<Promise<unknown>, unknown[]>();
const mockCaptureReadMode = jest.fn<Promise<unknown>, unknown[]>();
const mockCaptureScreenshot = jest.fn<Promise<Uint8Array>, unknown[]>();

// Each export is a GETTER over its spy rather than the spy itself. `jest.mock` is
// hoisted above these `const`s and the module under test is imported at the top, so
// a factory naming a spy directly would read it inside its own temporal dead zone;
// a getter defers that read to the property access the call site makes anyway. Same
// shape in every spec here.
jest.mock('@stxapps/web-react', () => ({
  get assertExtractionWritable() {
    return mockAssertExtractionWritable;
  },
  get readLinkById() {
    return mockReadLinkById;
  },
  get writeExtraction() {
    return mockWriteExtraction;
  },
  get writeFile() {
    return mockWriteFile;
  },
  get resizeImage() {
    return mockResizeImage;
  },
  get storeReadModeCopy() {
    return mockStoreReadModeCopy;
  },
  get collectReaderImages() {
    return mockCollectReaderImages;
  },
  get readSettingsGeneral() {
    return mockReadSettingsGeneral;
  },
}));
jest.mock('@stxapps/web-crypto', () => ({
  get newId() {
    return mockNewId;
  },
}));
jest.mock('./capture', () => ({
  get captureTitleImage() {
    return mockCaptureTitleImage;
  },
  get captureReadMode() {
    return mockCaptureReadMode;
  },
  get captureScreenshot() {
    return mockCaptureScreenshot;
  },
  get fetchReaderImage() {
    return mockFetchReaderImage;
  },
}));

const URL_ = 'https://example.com/post';
const IMAGE = new Uint8Array([1, 2, 3]);
const BYTES = new Uint8Array([4, 5, 6]);
const DOC = { version: 1, capturedAt: 1, sourceUrl: URL_, blocks: [] };
const SOURCES = [{ key: 'i0', url: 'https://cdn.example/a.jpg' }];
const ENTRY = { key: 'i0', type: 'image/jpeg', width: 800, height: 400, bytes: BYTES };

let fake: FakeBrowser;

/** The tab the popup was opened on, still showing this link's page. */
function onThePage(overrides: Record<string, unknown> = {}): void {
  fake.tabs.query.mockResolvedValue([{ id: 11, windowId: 99, url: URL_, ...overrides }]);
}

const run = (facet: ExtractionFacet) => runExtraction('alice', 'link-1', facet);

/** The patch argument of every `extractions/` write, in order. */
type ExtractionWrite = {
  fields?: Record<string, unknown>;
  facet?: string;
  state?: Record<string, unknown>;
};
const writes = (): ExtractionWrite[] =>
  mockWriteExtraction.mock.calls.map((call) => call[2] as ExtractionWrite);

beforeEach(() => {
  mockAssertExtractionWritable.mockReset();
  mockAssertExtractionWritable.mockResolvedValue(undefined);
  // Before the fake is installed: `resetAllMocks` reaches every spy in the
  // registry, the fake browser's included.
  jest.resetAllMocks();
  fake = installFakeBrowser();
  mockReadLinkById.mockResolvedValue({ url: URL_, listId: 'inbox' });
  mockWriteExtraction.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockResizeImage.mockImplementation(async (bytes) => bytes as Uint8Array);
  mockNewId.mockReturnValue('new-file-id');
  mockCaptureTitleImage.mockResolvedValue({});
  mockCaptureReadMode.mockResolvedValue({ doc: DOC, images: SOURCES });
  mockStoreReadModeCopy.mockResolvedValue(undefined);
  mockCollectReaderImages.mockResolvedValue([ENTRY]);
  mockReadSettingsGeneral.mockResolvedValue(undefined);
  mockCaptureScreenshot.mockResolvedValue(BYTES);
  onThePage();
});

describe('the guards that run before any capture', () => {
  it('refuses a link that is not in the local store', async () => {
    mockReadLinkById.mockResolvedValue(undefined);

    await expect(run('titleImage')).rejects.toThrow('not found locally');
    expect(mockCaptureTitleImage).not.toHaveBeenCalled();
  });

  it('refuses when there is no active tab to read', async () => {
    fake.tabs.query.mockResolvedValue([]);

    await expect(run('titleImage')).rejects.toThrow('No active tab');
    expect(mockCaptureTitleImage).not.toHaveBeenCalled();
  });

  it('refuses when the active tab has moved to another page', async () => {
    onThePage({ url: 'https://example.com/somewhere-else' });

    await expect(run('titleImage')).rejects.toThrow('no longer this link');
    expect(mockCaptureTitleImage).not.toHaveBeenCalled();
  });

  it('refuses a link whose extraction this device could not open, before any capture or write', async () => {
    // Not the host's fault, so it burns no backoff: the catch below would try to record a
    // `failed` facet with the very write the store refuses, and a blob written first would
    // be left with no extraction naming it.
    mockAssertExtractionWritable.mockRejectedValue(new UnreadablePathError('extractions/l1.enc'));

    await expect(run('titleImage')).rejects.toThrow(UnreadablePathError);

    expect(mockCaptureTitleImage).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWriteExtraction).not.toHaveBeenCalled();
  });

  it('does NOT record a failed facet for the stale tab — that would burn the backoff', async () => {
    // Our mistake, not the host's: the link stays pending for a later pass, here or
    // at a lower tier. Both paths throw, so nothing but this write distinguishes them.
    onThePage({ url: 'https://example.com/somewhere-else' });

    await expect(run('titleImage')).rejects.toThrow();
    expect(mockWriteExtraction).not.toHaveBeenCalled();
  });

  it('compares the tab through normalizeUrl, as the popup stored it', async () => {
    // The popup writes the normalized URL; `tab.url` is raw. Comparing raw strings
    // would reject the very page the user is standing on.
    mockReadLinkById.mockResolvedValue({ url: 'https://example.com/post' });
    onThePage({ url: '  https://example.com/post  ' });

    await expect(run('titleImage')).resolves.toBeUndefined();
  });
});

describe('titleImage', () => {
  it('writes the title on its own pass, leaving the facet pending', async () => {
    mockCaptureTitleImage.mockResolvedValue({ title: 'A post', image: IMAGE });

    await run('titleImage');

    // Pass 1 carries no facet state, so pass 2 still sets the terminal one — a
    // failure between them costs the image, never the title.
    expect(writes()[0]).toEqual({ fields: { title: 'A post' } });
  });

  it('resizes the image, stores it, and marks the facet done with its id', async () => {
    mockCaptureTitleImage.mockResolvedValue({ title: 'A post', image: IMAGE });
    mockResizeImage.mockResolvedValue(new Uint8Array([9]));

    await run('titleImage');

    expect(mockResizeImage).toHaveBeenCalledWith(IMAGE);
    expect(mockWriteFile).toHaveBeenCalledWith('alice', 'new-file-id', new Uint8Array([9]));
    expect(writes()[1]).toEqual({
      fields: { imageId: 'new-file-id' },
      facet: 'titleImage',
      state: expect.objectContaining({ status: 'done', extractedBy: 'extension:fg' }),
    });
  });

  it('stores the bytes BEFORE the reference to them', async () => {
    mockCaptureTitleImage.mockResolvedValue({ image: IMAGE });

    await run('titleImage');

    const fileWrite = mockWriteFile.mock.invocationCallOrder[0];
    const refWrite = mockWriteExtraction.mock.invocationCallOrder[0];
    expect(fileWrite).toBeLessThan(refWrite);
  });

  it('still marks the facet done when the page yielded a title but no image', async () => {
    mockCaptureTitleImage.mockResolvedValue({ title: 'A post' });

    await run('titleImage');

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(writes()[1]).toEqual({
      fields: {},
      facet: 'titleImage',
      state: expect.objectContaining({ status: 'done' }),
    });
  });

  it('marks the facet done even when the page yielded neither', async () => {
    // Done, not failed: the capture worked and this page simply has nothing to
    // extract. Recording it as failed would retry a page that will never answer.
    await run('titleImage');

    expect(writes()).toEqual([
      { fields: {}, facet: 'titleImage', state: expect.objectContaining({ status: 'done' }) },
    ]);
  });
});

describe('the file-backed facets', () => {
  // The two blobs and the extraction fields are storeReadModeCopy's (web-react, with
  // its own spec). What is this file's is what it is HANDED: the document as captured,
  // the images this tab could give, and the tier.
  it('hands the read-mode capture and its images to the one writer, at this tier', async () => {
    // Images are off by default (KEEP_ON_SAVE_DEFAULTS); this account turned them on.
    mockReadSettingsGeneral.mockResolvedValue({ keepReadModeImages: true });

    await run('readMode');

    expect(mockStoreReadModeCopy).toHaveBeenCalledWith(
      'alice',
      'link-1',
      DOC,
      [ENTRY],
      'extension:fg',
    );
    // Fetched FROM THE PAGE the document was taken from, so a tab that has moved on
    // is not asked for another page's images.
    const fetchBytes = mockCollectReaderImages.mock.calls[0][1] as (url: string) => unknown;
    expect(mockCollectReaderImages.mock.calls[0][0]).toEqual(SOURCES);
    await fetchBytes('https://cdn.example/a.jpg');
    expect(mockFetchReaderImage).toHaveBeenCalledWith(11, 'https://cdn.example/a.jpg', URL_);
  });

  it('keeps the words alone when the account has images off — nothing is fetched', async () => {
    // The default, stated: an absent setting is off.
    mockReadSettingsGeneral.mockResolvedValue(undefined);

    await run('readMode');

    expect(mockCollectReaderImages).not.toHaveBeenCalled();
    expect(mockStoreReadModeCopy).toHaveBeenCalledWith('alice', 'link-1', DOC, [], 'extension:fg');
  });

  it('a failure fetching images costs the copy its pictures, never its words', async () => {
    mockCollectReaderImages.mockRejectedValue(new Error('tab closed'));

    await run('readMode');

    expect(mockStoreReadModeCopy).toHaveBeenCalledWith('alice', 'link-1', DOC, [], 'extension:fg');
    expect(writes()).toEqual([]);
  });

  it('settles a page that is not an article, storing nothing', async () => {
    mockCaptureReadMode.mockResolvedValue(undefined);

    await run('readMode');

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(writes()).toEqual([
      {
        facet: 'readMode',
        state: expect.objectContaining({ status: 'permanent', reason: 'not-an-article' }),
      },
    ]);
  });

  it('screenshots the WINDOW, then caps it before storing', async () => {
    // captureVisibleTab takes a windowId — it photographs whatever is frontmost.
    mockResizeImage.mockResolvedValue(IMAGE);

    await run('screenshot');

    expect(mockCaptureScreenshot).toHaveBeenCalledWith(99);
    expect(mockResizeImage).toHaveBeenCalledWith(
      BYTES,
      expect.objectContaining({ maxDimension: expect.any(Number) }),
    );
    expect(mockWriteFile).toHaveBeenCalledWith('alice', 'new-file-id', IMAGE);
    expect(writes()[0]).toMatchObject({ fields: { screenshotId: 'new-file-id' } });
  });

  it('does not capture a page copy', async () => {
    // A DOM serialized without its assets isn't a copy, and rendering it would fetch
    // every resource it names (capture.ts). Refused like any facet this tier lacks.
    await expect(run('pageCopy')).rejects.toThrow('not an active-page capture');

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('when a capture fails', () => {
  it('records the facet as failed and rethrows', async () => {
    mockCaptureScreenshot.mockRejectedValue(new Error('tab closed'));

    await expect(run('screenshot')).rejects.toThrow('tab closed');

    expect(writes()).toEqual([
      {
        facet: 'screenshot',
        state: expect.objectContaining({ status: 'failed', extractedBy: 'extension:fg' }),
      },
    ]);
  });

  it('stamps extractedAt so the pending query can back the retry off', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mockCaptureScreenshot.mockRejectedValue(new Error('tab closed'));

    await expect(run('screenshot')).rejects.toThrow();

    expect(writes()[0].state).toMatchObject({ extractedAt: 1_700_000_000_000, attempts: 0 });
    jest.restoreAllMocks();
  });

  it('keeps a title that pass 1 already wrote when the image half throws', async () => {
    mockCaptureTitleImage.mockResolvedValue({ title: 'A post', image: IMAGE });
    mockWriteFile.mockRejectedValue(new Error('quota'));

    await expect(run('titleImage')).rejects.toThrow('quota');

    expect(writes()[0]).toEqual({ fields: { title: 'A post' } });
    expect(writes()[1]).toMatchObject({ facet: 'titleImage', state: { status: 'failed' } });
  });

  it('records a facet this tier cannot capture as failed rather than silently doing nothing', async () => {
    await expect(run('favicon' as ExtractionFacet)).rejects.toThrow('not an active-page capture');

    expect(writes()[0]).toMatchObject({ facet: 'favicon', state: { status: 'failed' } });
  });
});
