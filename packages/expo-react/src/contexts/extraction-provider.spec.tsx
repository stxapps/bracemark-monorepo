import { useEffect } from 'react';
import { AppState, Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

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
// The drain itself is not exercised by the tally tests: they run at `saves`, where
// `enabled` is false by construction (it needs `all`), which is also the only mode
// the banner arms in. What is under test is the gestured path, which runs anyway.
// The one drain case at the end is a drift guard for a rule web's
// extraction-provider.spec.tsx pins in full (docs/testing.md, _the ported pair_).
//
// Everything below the provider is mocked — the store, the counts, the fetch — the
// same seam favicon-provider.spec.tsx takes: this file is about one number.
//
// And about one gate, because it is the same function and fails the same way.
// `extractNow` re-reads the extraction mode from the STORE before anything leaves
// the device: the mode a render holds is useSettings' default until the settings
// blob has been read, and a caller can be holding the `extractNow` of exactly that
// render. Nothing shows the difference — the fetch succeeds.

let mockMode = 'saves';

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
// ONE function, not a `jest.fn()` per call: `requestSync` is a drain-effect dep, and
// a fresh identity per render would restart the drain on every render — hiding the
// dropped rerun the drift guard below is for.
const mockRequestSync = jest.fn();
jest.mock('./sync-provider', () => ({
  useSync: () => ({ storeStatus: 'ready', requestSync: mockRequestSync }),
}));
jest.mock('./favicon-provider', () => ({
  useFavicon: () => ({ requestFaviconNow: jest.fn() }),
}));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ deviceExtractionMode: mockMode }),
}));
// The drain's two wake signals, told apart by their deps: the displayed-page probe
// keys on three, the raw pending count on two. Empty by default, which is inert
// whatever the mode; the drain case fills them.
let mockProbe: unknown[] = [];
let mockRawPending = 0;
jest.mock('../hooks/use-live-read', () => ({
  useLiveRead: (_read: unknown, deps: unknown[]) =>
    deps.length === 3 ? mockProbe : mockRawPending,
}));

const mockReadPendingForPaths = jest.fn();
const mockReadPage = jest.fn();
// The store's copy of the settings blob — what `extractNow` re-reads. It agrees
// with the render's mode unless a test makes the two differ.
const mockReadSettings = jest.fn();
jest.mock('../data/queries', () => ({
  readLinksPendingTitleImageForLinkPaths: (...args: unknown[]) => mockReadPendingForPaths(...args),
  readLinksPendingTitleImagePage: (...args: unknown[]) => mockReadPage(...args),
  readRawPendingTitleImageCount: jest.fn(),
  readSettingsGeneral: () => mockReadSettings(),
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
let extractAll: () => void = () => undefined;

// Renders the tally so a re-render is what the assertions read, and hands the
// entry points out so a test can make the save or press Extract all.
function Probe() {
  const context = useExtraction();
  useEffect(() => {
    extractNow = context.extractNow;
  }, [context.extractNow]);
  useEffect(() => {
    extractAll = context.extractAll;
  }, [context.extractAll]);
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
  extractAll = () => undefined;
  mockProbe = [];
  mockRawPending = 0;
  mockReadPage.mockReset();
  mockReadPendingForPaths.mockReset();
  mockReadSettings.mockReset();
  mockReadSettings.mockImplementation(async () => ({ deviceExtractionMode: mockMode }));
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
  // Nothing has been claimed, or even looked up: the run is on its first await,
  // the mode's re-read. This is the window in which the banner's live read
  // observes the new `items` row.
  expect(mockReadSettings).toHaveBeenCalledTimes(1);
  expect(mockReadPendingForPaths).not.toHaveBeenCalled();
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

test('declines a gesture the store says is `off`, whatever the render still holds', async () => {
  // The render is on `saves` — what useSettings answers before it has read the
  // settings blob — and the store already holds the account's `off`. ShareBridge
  // calls the `extractNow` of such a render when a first sync ends. The first test
  // above is the control: the same call with the store on `saves` fetches.
  mockReadSettings.mockResolvedValue({ deviceExtractionMode: 'off' });
  mockReadPendingForPaths.mockResolvedValue([link('links/a.enc')]);

  const { getByText } = mount();
  await act(async () => {
    extractNow(['links/a.enc']);
    await Promise.resolve();
  });

  expect(mockReadPendingForPaths).not.toHaveBeenCalled();
  expect(mockRunBatch).not.toHaveBeenCalled();
  // Counted for the length of the re-read, and released with it.
  expect(getByText(inFlight(0))).toBeTruthy();
});

test('takes the opt-in from the same read', async () => {
  // The other direction of the same lag: the render's `saves` would fetch the page
  // and then hold back what `all` allows.
  mockReadSettings.mockResolvedValue({ deviceExtractionMode: 'all' });
  mockReadPendingForPaths.mockResolvedValue([link('links/a.enc')]);

  mount();
  await act(async () => {
    extractNow(['links/a.enc']);
    await Promise.resolve();
  });

  expect(mockRunBatch).toHaveBeenCalledWith('alice', [link('links/a.enc')], 'expo:fg', {
    optedIn: true,
  });
});

test('starts Extract all when it is pressed while an auto step is in flight', async () => {
  // Drift guard for web's extraction-provider.spec.tsx: the drain is duplicated
  // source, so the rerun handoff has to be pinned on this copy too. Extract all
  // re-runs the drain effect mid-step; the new run can only queue behind the running
  // one, and the finishing — now cancelled — step has to hand the rerun on.
  mockMode = 'all';
  // The auto drain only runs in the foreground, and RN's jest mock leaves
  // `currentState` a bare jest.fn — which reads as not-active.
  const appState = AppState as { currentState: unknown };
  const currentState = appState.currentState;
  appState.currentState = 'active';
  mockProbe = [link('links/a.enc')];
  mockRawPending = 1;
  mockReadPendingForPaths.mockResolvedValue([link('links/a.enc')]);
  mockReadPage.mockResolvedValue({ links: [link('links/b.enc')], cursor: null });
  const autoStep = deferred<number>();
  mockRunBatch.mockReturnValueOnce(autoStep.promise);

  mount();
  await waitFor(() => expect(mockRunBatch).toHaveBeenCalledTimes(1));

  await act(async () => {
    extractAll();
    await Promise.resolve();
  });
  expect(mockReadPage).not.toHaveBeenCalled();

  await act(async () => {
    autoStep.resolve(1);
    await autoStep.promise;
  });
  await waitFor(() => expect(mockReadPage).toHaveBeenCalledTimes(1));
  appState.currentState = currentState;
});
