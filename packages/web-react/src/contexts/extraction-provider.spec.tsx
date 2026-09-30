/**
 * @jest-environment jsdom
 */
import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';

import { ExtractClientProvider } from '@stxapps/react';
import type { ExtractClient, LinkItem } from '@stxapps/shared';

import { ExtractionProvider, useExtraction } from './extraction-provider';

// THE DRAIN'S HANDOFF ACROSS EFFECT RUNS. The drain is single-flighted by a ref that
// outlives any one run of its effect: a wake while a drain is running only queues a
// rerun, and whoever finishes the running drain starts it. A dep change mid-drain —
// pressing Extract all during an auto batch, a tab reveal, StrictMode's mount →
// cleanup → mount in `next dev` — cancels the running closure while it still holds
// that ref, so the NEW run's drain can do nothing but queue. If the finishing closure
// only honoured the rerun when it was itself still live, the queued one was dropped,
// and the drain sat idle until some other dep happened to move: Extract all showed as
// running and extracted nothing. No error, no failed request — just nothing.
//
// The mock seam is server-extraction-gate.spec.tsx's, which is where the other half of
// this provider's behaviour is pinned.

const extractor = {
  extract: jest.fn(),
  extractMany: jest.fn(() => Promise.resolve([])),
  fetchImage: jest.fn(),
} as unknown as ExtractClient;

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
// ONE function, not a `jest.fn()` per call: `requestSync` is a drain-effect dep, and a
// fresh identity per render re-runs the effect on every render — which starts a new
// drain and so papers over exactly the dropped rerun this file is about. The real one
// is identity-stable (sync-provider).
const mockRequestSync = jest.fn();
jest.mock('./sync-provider', () => ({
  useSync: () => ({ storeStatus: 'ready', requestSync: mockRequestSync }),
}));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ serverExtraction: true }),
}));

// A stand-in for Dexie's liveQuery: run the querier, re-run it when the deps change.
jest.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const react = require('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>(undefined);
    react.useEffect(() => {
      let live = true;
      void Promise.resolve(querier()).then((next) => void (live && setValue(next)));
      return () => void (live = false);
    }, deps);
    return value;
  },
}));

// One link, permanently pending, on the displayed page and in the library walk alike.
const mockPending = [{ id: 'l1', url: 'https://example.com/a' }];
const mockReadPage = jest.fn(() => Promise.resolve({ links: mockPending, cursor: null }));
jest.mock('../data/queries', () => ({
  readLinksPendingTitleImageForLinkPaths: () => Promise.resolve(mockPending),
  readLinksPendingTitleImagePage: () => mockReadPage(),
  readRawPendingTitleImageCount: () => Promise.resolve(mockPending.length),
}));
const mockRunBatch = jest.fn((_username: string, _links: LinkItem[], _client: ExtractClient) =>
  Promise.resolve(1),
);
jest.mock('../lib/server-extraction', () => ({
  runServerTitleImageBatch: (username: string, links: LinkItem[], client: ExtractClient) =>
    mockRunBatch(username, links, client),
}));

let extractAll: () => void = () => undefined;

function ReportsAPage() {
  const context = useExtraction();
  const { reportDisplayedLinkPaths } = context;
  useEffect(() => reportDisplayedLinkPaths(['links/l1']), [reportDisplayedLinkPaths]);
  useEffect(() => {
    extractAll = context.extractAll;
  }, [context.extractAll]);
  return null;
}

beforeEach(() => {
  extractAll = () => undefined;
  mockReadPage.mockClear();
  mockRunBatch.mockClear();
});

it('starts Extract all when it is pressed while an auto batch is in flight', async () => {
  // Hold the auto drain inside its first batch, so it owns the single-flight when
  // Extract all re-runs the effect.
  let finishAutoBatch!: (processed: number) => void;
  mockRunBatch.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finishAutoBatch = resolve;
      }),
  );

  await act(async () => {
    render(
      <ExtractClientProvider client={extractor}>
        <ExtractionProvider>
          <ReportsAPage />
        </ExtractionProvider>
      </ExtractClientProvider>,
    );
  });
  await waitFor(() => expect(mockRunBatch).toHaveBeenCalledTimes(1));

  // The new run finds the auto drain still running and can only queue behind it.
  await act(async () => extractAll());
  expect(mockReadPage).not.toHaveBeenCalled();

  // The auto batch lands; its closure is cancelled and stops at the loop top. The
  // queued run has to start now — this is the walk that used to never happen.
  // (Only the walk is asserted: once it ends, auto mode resumes on a link the mocks
  // never let settle, so the batch count is the budget's, not this handoff's.)
  await act(async () => finishAutoBatch(1));
  await waitFor(() => expect(mockReadPage).toHaveBeenCalledTimes(1));
});
