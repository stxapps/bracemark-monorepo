import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import { ExtractionProvider, useExtraction } from './extraction-provider';

// THE GESTURED IN-FLIGHT TALLY — the half of the previews prompt that lives here.
//
// bracemark-expo's `features/links/previews-prompt.spec.tsx` pins the subtraction
// (raw pending minus this number, so the banner stops counting links the save path
// already owns). It mocks this context, so it cannot see the two properties that
// make the number usable, and both fail silently:
//
//   - COUNTED BEFORE THE FIRST AWAIT. The save writes an `items` row, which wakes
//     the banner's live read; `extractNow` is called in the next breath but claims
//     asynchronously. Increment after the await and the banner is briefly back to
//     counting the link being saved — the original flicker, shorter.
//   - RELEASED ALWAYS, AND BY WHAT IT COUNTED. The tally is subtracted from a count
//     the user is shown, so a leak is not a wasted fetch: it is an offer that never
//     appears again on this device, with nothing on screen to explain why. The
//     offline path is the one that finds it — nothing is recorded, so no wake
//     follows to paper over a stuck number.
//
// The drain itself is not exercised here: every test runs at `saves`, where
// `enabled` is false by construction (it needs `all`), which is also the only mode
// the banner arms in. What is under test is the gestured path, which runs anyway.
//
// Everything below the provider is mocked — the store, the counts, the fetch — the
// same seam favicon-provider.spec.tsx takes: this file is about one number.

let mockMode = 'saves';

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('./sync-provider', () => ({
  useSync: () => ({ storeStatus: 'ready', requestSync: jest.fn() }),
}));
jest.mock('./favicon-provider', () => ({
  useFavicon: () => ({ requestFaviconNow: jest.fn() }),
}));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ deviceExtractionMode: mockMode }),
}));
// The drain's two wake signals. Inert here — `enabled` is false at `saves` — but the
// provider still calls them on every render.
jest.mock('../hooks/use-live-read', () => ({ useLiveRead: () => [] }));

const mockReadPendingForPaths = jest.fn();
jest.mock('../data/queries', () => ({
  readLinksPendingTitleImageForLinkPaths: (...args: unknown[]) => mockReadPendingForPaths(...args),
  readLinksPendingTitleImagePage: jest.fn(),
  readRawPendingTitleImageCount: jest.fn(),
}));

const mockRunBatch = jest.fn();
jest.mock('../lib/device-extraction', () => ({
  runDeviceTitleImageBatch: (...args: unknown[]) => mockRunBatch(...args),
}));

// A promise the test resolves by hand, so "before the first await" is a moment the
// assertions can actually stand in rather than a race to out-run a microtask.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection here would fail the suite from outside a test; the
  // provider attaches its own catch when it awaits this.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const link = (path: string) => ({ path, url: `https://example.com/${path}` });

let extractNow: (linkPaths: string[]) => void = () => undefined;

// Renders the tally so a re-render is what the assertions read, and hands the
// gestured entry point out so a test can make the save.
function Probe() {
  const context = useExtraction();
  useEffect(() => {
    extractNow = context.extractNow;
  }, [context.extractNow]);
  return <Text>{`in flight: ${context.gesturedInFlightCount}`}</Text>;
}

const inFlight = (n: number) => `in flight: ${n}`;

const mount = () =>
  render(
    <ExtractionProvider>
      <Probe />
    </ExtractionProvider>,
  );

beforeEach(() => {
  mockMode = 'saves';
  extractNow = () => undefined;
  mockReadPendingForPaths.mockReset();
  mockRunBatch.mockReset();
  mockRunBatch.mockResolvedValue(1);
});

test('counts a save from before its first await until the run ends', async () => {
  const claim = deferred<ReturnType<typeof link>[]>();
  mockReadPendingForPaths.mockReturnValue(claim.promise);

  const { getByText } = mount();
  expect(getByText(inFlight(0))).toBeTruthy();

  act(() => {
    extractNow(['links/a.enc']);
  });
  // Nothing has been read, let alone claimed — this is the window in which the
  // banner's live read observes the new `items` row.
  expect(mockReadPendingForPaths).toHaveBeenCalledTimes(1);
  expect(getByText(inFlight(1))).toBeTruthy();

  await act(async () => {
    claim.resolve([link('links/a.enc')]);
    await claim.promise;
  });
  expect(mockRunBatch).toHaveBeenCalledTimes(1);
  expect(getByText(inFlight(0))).toBeTruthy();
});

test('releases what it counted when the fetch never lands', async () => {
  // Offline: the read (or the batch behind it) throws, nothing is recorded, and no
  // wake follows. A tally that leaked here would suppress the offer for good.
  const claim = deferred<ReturnType<typeof link>[]>();
  mockReadPendingForPaths.mockReturnValue(claim.promise);

  const { getByText } = mount();
  act(() => {
    extractNow(['links/a.enc', 'links/b.enc']);
  });
  expect(getByText(inFlight(2))).toBeTruthy();

  await act(async () => {
    claim.reject(new TypeError('Network request failed'));
    await Promise.resolve();
  });
  expect(mockRunBatch).not.toHaveBeenCalled();
  expect(getByText(inFlight(0))).toBeTruthy();
});

test('counts nothing at `off`, where the gesture itself is declined', async () => {
  // The one position that reaches into `extractNow`: no fetch, and so nothing for
  // the banner to subtract either. The two tests above are its positive control —
  // the same call at `saves` counts.
  mockMode = 'off';
  const claim = deferred<ReturnType<typeof link>[]>();
  mockReadPendingForPaths.mockReturnValue(claim.promise);

  const { getByText } = mount();
  act(() => {
    extractNow(['links/a.enc']);
  });

  expect(mockReadPendingForPaths).not.toHaveBeenCalled();
  expect(getByText(inFlight(0))).toBeTruthy();
});
