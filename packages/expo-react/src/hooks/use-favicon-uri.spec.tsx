// Specs for the favicon read edge — what a link row is handed to render, and when it asks
// for a fetch. What is under test is the ONE property web's `use-favicon-url` cannot get
// wrong and this port did: THE VALUE IS DERIVED FROM THE HOST. Web returns the cached
// bytes, which are whoever's they are; here the bytes are a file and the hook returns
// `faviconFileFor(host).uri`, so a verdict about one host applied to another becomes a
// path — a well-formed `file://` uri with nothing behind it.
//
// That is reachable because the caller is a FlashList-recycled row. The same hook
// instance is handed the next link's host, and a live read holds its previous value for
// a beat after its deps change. A row recycled from an icon'd host onto an icon-less one
// rendered the icon-less host's path for that beat: expo-image failed the load
// (`open failed: ENOENT`), its `onError` marked the uri broken in link-media.tsx, and on
// Android the failure callback could race the view's own teardown into a Glide
// `IllegalStateException`. None of it fails a test, a type or a lint rule — it is a line
// in the device log, on a scroll.
//
// The store and the provider are mocked: favicon-store.spec.ts covers what a verdict IS,
// favicon-provider.spec.tsx which hosts are fetched. Here a "host with an icon" is an
// `ok` row plus a file, which is the pair `readFavicon` guarantees.

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { DB_NAME } from '../data/db';
import { type FaviconRecord } from '../data/favicon-store';
import { useFaviconUri } from './use-favicon-uri';

// Every `mock`-prefixed binding is closed over by a jest.mock factory below.
const mockListeners: ((event: { databaseFilePath: string; tableName: string }) => void)[] = [];
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (
    listener: (event: { databaseFilePath: string; tableName: string }) => void,
  ) => {
    mockListeners.push(listener);
    return { remove: () => undefined };
  },
}));

const mockRequestFavicon = jest.fn((_host: string) => undefined);
jest.mock('../contexts/favicon-provider', () => ({
  useFavicon: () => ({ requestFavicon: mockRequestFavicon }),
}));

const mockRows = new Map<string, FaviconRecord>();
const mockOnDisk = new Set<string>();
// A host listed here has its read held open until `release()` — the beat, made as long
// as the assertion needs.
const mockHeld = new Map<string, () => void>();
const mockUriFor = (host: string) => `file:///documents/bracemark-favicons/${host}`;

jest.mock('../data/favicon-store', () => ({
  readFavicon: (host: string) =>
    mockHeld.has(host)
      ? new Promise<FaviconRecord | undefined>((resolve) => {
          mockHeld.set(host, () => resolve(mockRows.get(host)));
        })
      : Promise.resolve(mockRows.get(host)),
  // Unknown is stale and nothing else is: the TTL is the store's, covered there.
  isFaviconStale: (record: FaviconRecord | undefined) => record === undefined,
  faviconFileFor: (host: string) => ({ uri: mockUriFor(host), exists: mockOnDisk.has(host) }),
}));

function withIcon(host: string): void {
  mockRows.set(host, { host, status: 'ok', fetchedAt: 1 });
  mockOnDisk.add(host);
}

function hold(host: string): void {
  mockHeld.set(host, () => undefined);
}

async function release(host: string): Promise<void> {
  const resolve = mockHeld.get(host);
  mockHeld.delete(host);
  await act(async () => {
    resolve?.();
    await Promise.resolve();
  });
}

function emitFaviconsChange(): void {
  for (const listener of mockListeners) {
    listener({ databaseFilePath: `/data/databases/${DB_NAME}`, tableName: 'favicons' });
  }
}

// Every render is recorded, not just the settled one: the defect was a single commit.
function renderRow(host: string) {
  const seen: { host: string; uri: string | undefined }[] = [];
  const view = renderHook(
    (props: { host: string }) => {
      const uri = useFaviconUri(props.host);
      seen.push({ host: props.host, uri });
      return uri;
    },
    { initialProps: { host } },
  );
  return { ...view, urisFor: (h: string) => seen.filter((s) => s.host === h).map((s) => s.uri) };
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

beforeEach(() => {
  mockListeners.length = 0;
  mockRows.clear();
  mockOnDisk.clear();
  mockHeld.clear();
  mockRequestFavicon.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a recycled row', () => {
  // THE SPECIMEN. `icon.example` has an icon; `bare.example` was never fetched. The row
  // that showed the first is handed the second, and at no point — not for one render —
  // may it be given a path for the host that has no file.
  it("never yields a path for a host with no icon file, on the previous host's verdict", async () => {
    withIcon('icon.example');
    const { result, rerender, urisFor } = renderRow('icon.example');
    await waitFor(() => expect(result.current).toBe(mockUriFor('icon.example')));

    hold('bare.example');
    rerender({ host: 'bare.example' });
    await release('bare.example');

    expect(urisFor('bare.example').length).toBeGreaterThan(0);
    expect(urisFor('bare.example')).toEqual(urisFor('bare.example').map(() => undefined));
  });

  // The other half, and the reason the beat is answered from the DISK rather than left
  // blank: between two icon'd hosts the icon must swap in the render that changed the
  // host. Reporting "nothing yet" there drops the row to its fallback and back on every
  // recycle — a monogram flashing between two icons down a whole scroll.
  it("swaps straight to the next host's icon when that icon is on disk", async () => {
    withIcon('icon.example');
    withIcon('other.example');
    const { result, rerender, urisFor } = renderRow('icon.example');
    await waitFor(() => expect(result.current).toBe(mockUriFor('icon.example')));

    hold('other.example');
    rerender({ host: 'other.example' });
    expect(result.current).toBe(mockUriFor('other.example'));
    await release('other.example');

    expect(urisFor('other.example')).toEqual(
      urisFor('other.example').map(() => mockUriFor('other.example')),
    );
  });
});

describe('the verdict', () => {
  // The disk answers only WHILE the verdict is in flight. A file with no `ok` row behind
  // it (a wipe that took the table and crashed before the files) is not an icon the cache
  // knows about: once the read says so the uri goes, and the fetch gate re-asks.
  it('outranks the disk once it lands', async () => {
    mockOnDisk.add('orphan.example');
    const { result } = renderRow('orphan.example');
    expect(result.current).toBe(mockUriFor('orphan.example'));

    await waitFor(() => expect(result.current).toBeUndefined());
  });

  // Liveness, which the keyed read must not have cost: an icon that lands under a row
  // still showing its host appears without a remount.
  it('yields the uri when the icon lands under a mounted host', async () => {
    const { result } = renderRow('late.example');
    await waitFor(() => expect(mockListeners.length).toBeGreaterThan(0));
    expect(result.current).toBeUndefined();

    withIcon('late.example');
    act(() => emitFaviconsChange());

    await waitFor(() => expect(result.current).toBe(mockUriFor('late.example')));
  });
});

describe('the request', () => {
  // The fetch gate reads the same verdict, so the same beat applied: a row recycled off
  // an unresolved host asked for the NEXT host on the strength of the previous one's
  // "unknown". It is asked only once its own read resolves stale.
  it('asks for a host on its own verdict, not while that verdict is in flight', async () => {
    jest.useFakeTimers();
    const { rerender } = renderRow('unknown.example');
    await passSettleDelay();
    expect(mockRequestFavicon).toHaveBeenCalledWith('unknown.example');
    mockRequestFavicon.mockClear();

    hold('next.example');
    rerender({ host: 'next.example' });
    await passSettleDelay();
    expect(mockRequestFavicon).not.toHaveBeenCalled();

    await release('next.example');
    await passSettleDelay();
    expect(mockRequestFavicon).toHaveBeenCalledWith('next.example');
  });
});
