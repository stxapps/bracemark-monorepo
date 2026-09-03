import type { ExtractionFacet } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import { runExtraction } from './extraction-worker';

// One facet of one link, captured from the ACTIVE TAB and written back. What is only
// true here — the captures themselves are pinned in capture.spec.ts, the write
// primitives in web-react — is the bookkeeping around them, and every rule in it is
// invisible when broken:
//
//   - THE WRITER SPLIT. This never touches `links/{id}.enc`, the user's file. Title,
//     image, screenshot and page-copy refs all land in `extractions/{id}.enc`
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
const mockWriteFile = jest.fn<Promise<void>, unknown[]>();
const mockResizeImage = jest.fn<Promise<Uint8Array>, unknown[]>();
const mockNewId = jest.fn<string, unknown[]>();

const mockCaptureTitleImage = jest.fn<Promise<unknown>, unknown[]>();
const mockCaptureReadMode = jest.fn<Promise<Uint8Array>, unknown[]>();
const mockCaptureScreenshot = jest.fn<Promise<Uint8Array>, unknown[]>();
const mockCapturePageCopy = jest.fn<Promise<Uint8Array>, unknown[]>();

// Each export is a GETTER over its spy rather than the spy itself. `jest.mock` is
// hoisted above these `const`s and the module under test is imported at the top, so
// a factory naming a spy directly would read it inside its own temporal dead zone;
// a getter defers that read to the property access the call site makes anyway. Same
// shape in every spec here.
jest.mock('@stxapps/web-react', () => ({
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
  get capturePageCopy() {
    return mockCapturePageCopy;
  },
}));

const URL_ = 'https://example.com/post';
const IMAGE = new Uint8Array([1, 2, 3]);
const HTML = new Uint8Array([4, 5, 6]);

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
  mockCaptureReadMode.mockResolvedValue(HTML);
  mockCaptureScreenshot.mockResolvedValue(HTML);
  mockCapturePageCopy.mockResolvedValue(HTML);
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
  it('stores read-mode HTML and records the file id on the facet, with no display field', async () => {
    await run('readMode');

    expect(mockWriteFile).toHaveBeenCalledWith('alice', 'new-file-id', HTML);
    // No display field references read mode yet; the id rides on the facet so a
    // future reader can find it.
    expect(writes()[0]).toEqual({
      fields: undefined,
      facet: 'readMode',
      state: expect.objectContaining({ status: 'done', fileId: 'new-file-id' }),
    });
  });

  it('screenshots the WINDOW, not the tab', async () => {
    // captureVisibleTab takes a windowId — it photographs whatever is frontmost.
    await run('screenshot');

    expect(mockCaptureScreenshot).toHaveBeenCalledWith(99);
    expect(writes()[0]).toMatchObject({ fields: { screenshotId: 'new-file-id' } });
  });

  it('stores the page copy under its own display field', async () => {
    await run('pageCopy');

    expect(mockCapturePageCopy).toHaveBeenCalledWith(11);
    expect(writes()[0]).toMatchObject({
      fields: { pageCopyId: 'new-file-id' },
      facet: 'pageCopy',
    });
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
