// Specs for the preview-image read edge — the uri a link row's image slot renders, and
// when it asks for the content to be fetched. Web's `use-image-file-url` returns one
// `undefined` for "nothing to show"; this port returns TWO sentinels, and the difference
// between them is the whole file:
//
//   - `undefined` — the read for THIS id is in flight. The slot blanks.
//   - `null`      — no image here: none asked for, or nothing local yet. The slot falls
//                   back to the monogram.
//
// It matters because the caller is a FlashList-recycled row. The same hook instance is
// handed the next link's `imageId`, and a live read holds its previous value for a beat
// after its deps change — so a recycled row went on reporting the PREVIOUS link's uri,
// and the slot painted the wrong photo under the right title until the read landed.
// Collapsing that beat into `null` instead would trade it for the monogram flashing
// between two photos on every recycle; hence a state of its own. Nothing fails either
// way — it is a frame of the wrong picture, on a scroll.
//
// `readFileUri` and the content provider are mocked: queries.spec.ts covers what counts
// as local, and the provider what a request does.

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useImageFileUri } from './use-image-file-uri';

jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: () => ({ remove: () => undefined }),
}));

// Every `mock`-prefixed binding is closed over by a jest.mock factory below.
const mockRequestFileContent = jest.fn((_fileId: string) => undefined);
jest.mock('../contexts/file-content-provider', () => ({
  useFileContent: () => ({ requestFileContent: mockRequestFileContent }),
}));

const mockLocal = new Set<string>();
// An id listed here has its read held open until `release()` — the beat, made as long as
// the assertion needs.
const mockHeld = new Map<string, () => void>();
const mockUriFor = (fileId: string) => `file:///documents/bracemark-files/${fileId}`;
const mockReadFileUri = jest.fn((fileId: string) => {
  const answer = () => (mockLocal.has(fileId) ? mockUriFor(fileId) : undefined);
  return mockHeld.has(fileId)
    ? new Promise<string | undefined>((resolve) => {
        mockHeld.set(fileId, () => resolve(answer()));
      })
    : Promise.resolve(answer());
});
jest.mock('../data/queries', () => ({
  readFileUri: (fileId: string) => mockReadFileUri(fileId),
}));

function hold(fileId: string): void {
  mockHeld.set(fileId, () => undefined);
}

async function release(fileId: string): Promise<void> {
  const resolve = mockHeld.get(fileId);
  mockHeld.delete(fileId);
  await act(async () => {
    resolve?.();
    await Promise.resolve();
  });
}

// Every render is recorded, not just the settled one: the defect was a single commit.
function renderSlot(fileId: string | undefined) {
  const seen: { fileId: string | undefined; uri: string | null | undefined }[] = [];
  const view = renderHook(
    (props: { fileId: string | undefined }) => {
      const uri = useImageFileUri(props.fileId);
      seen.push({ fileId: props.fileId, uri });
      return uri;
    },
    { initialProps: { fileId } },
  );
  return {
    ...view,
    urisFor: (id: string | undefined) => seen.filter((s) => s.fileId === id).map((s) => s.uri),
  };
}

// Comfortably past the hook's settle delay, whatever it is tuned to.
const PAST_SETTLE_MS = 5_000;

// Under fake timers. Two steps, because a read that lands inside an `act` only commits
// when that `act` returns — which is when the effect arming the settle timer runs, and a
// single advance would have spent its time before the timer existed.
async function passSettleDelay(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(PAST_SETTLE_MS);
  });
}

// Under real timers: let reads already started land, and their renders commit.
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

beforeEach(() => {
  mockLocal.clear();
  mockHeld.clear();
  mockReadFileUri.mockClear();
  mockRequestFileContent.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a recycled row', () => {
  // THE SPECIMEN. Both links have their image on this device. The row that showed the
  // first is handed the second: until the second's read lands it is IN FLIGHT — never
  // the first link's uri, and not `null` either, which would send the slot to its
  // fallback for a beat between two photos.
  it("reports in flight for the next link, never the previous link's uri", async () => {
    mockLocal.add('f_first');
    mockLocal.add('f_second');
    const { result, rerender, urisFor } = renderSlot('f_first');
    await waitFor(() => expect(result.current).toBe(mockUriFor('f_first')));

    hold('f_second');
    rerender({ fileId: 'f_second' });
    expect(result.current).toBeUndefined();
    await release('f_second');

    await waitFor(() => expect(result.current).toBe(mockUriFor('f_second')));
    expect(urisFor('f_second')).not.toContain(mockUriFor('f_first'));
    expect(urisFor('f_second')).not.toContain(null);
  });

  // Recycled onto a link with no image at all: there is nothing to read, so the answer
  // is known in the render that changed the link — `null`, the fallback, with neither
  // the previous photo nor a blank beat in front of it.
  it('reports no image at once for a link without one', async () => {
    mockLocal.add('f_first');
    const { result, rerender, urisFor } = renderSlot('f_first');
    await waitFor(() => expect(result.current).toBe(mockUriFor('f_first')));

    rerender({ fileId: undefined });
    await settle();

    expect(urisFor(undefined)).toEqual(urisFor(undefined).map(() => null));
    expect(urisFor(undefined).length).toBeGreaterThan(0);
  });
});

describe('the two sentinels', () => {
  // A first mount is in flight, then resolved: an image this device hasn't materialized
  // is `null` (fall back and fetch), and it must not be mistaken for still loading.
  it('is undefined while the read is in flight and null once it resolves empty', async () => {
    hold('f_remote');
    const { result } = renderSlot('f_remote');
    expect(result.current).toBeUndefined();

    await release('f_remote');

    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe('the request', () => {
  // The fetch gate reads the same value, so the same beat applied: a row recycled off a
  // link whose image wasn't local asked for the NEXT link's content on the strength of
  // the previous one's "nothing local" — a download for an image already on disk, had
  // the provider not caught it. It asks only once its own read resolves empty.
  it('asks for content on its own answer, not while that answer is in flight', async () => {
    jest.useFakeTimers();
    const { rerender } = renderSlot('f_remote');
    await passSettleDelay();
    expect(mockRequestFileContent).toHaveBeenCalledWith('f_remote');
    mockRequestFileContent.mockClear();

    hold('f_also_remote');
    rerender({ fileId: 'f_also_remote' });
    await passSettleDelay();
    expect(mockRequestFileContent).not.toHaveBeenCalled();

    await release('f_also_remote');
    await passSettleDelay();
    expect(mockRequestFileContent).toHaveBeenCalledWith('f_also_remote');
  });

  it('never asks for a local image, or for a link without one', async () => {
    jest.useFakeTimers();
    mockLocal.add('f_first');
    const { rerender } = renderSlot('f_first');
    await passSettleDelay();
    rerender({ fileId: undefined });
    await passSettleDelay();

    expect(mockRequestFileContent).not.toHaveBeenCalled();
  });
});
