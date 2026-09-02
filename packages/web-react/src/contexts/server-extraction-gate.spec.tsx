/**
 * @jest-environment jsdom
 */
import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';

import { ExtractClientProvider } from '@stxapps/react';
import type { ExtractClient, LinkItem } from '@stxapps/shared';

import { ExtractionProvider, useExtraction } from './extraction-provider';
import { FaviconProvider, useFavicon } from './favicon-provider';

// THE PRIVACY GATE, on both providers that hold it: no URL leaves the browser unless
// the `serverExtraction` opt-in is on AND an extractor origin is configured. Server
// extraction is opt-in and off by default, and `bracemark-extractor` is handed a
// PLAINTEXT URL by construction (docs/link-extraction.md, _server extraction_) — so
// a gate that opens early doesn't corrupt data or throw, it just quietly starts
// telling one of our servers which pages this user saved.
//
// Two providers, one spec, because they are one rule written twice: FaviconProvider's
// gate is a hand-copy of ExtractionProvider's, with the comment at favicon-provider
// .tsx:91 pointing at it. Splitting them by file would let one drift while the other
// stayed pinned, which is the failure this is for.
//
// The null half of the gate has no other cover anywhere. `useExtractClient` returns
// null rather than throwing precisely so a build with no extractor origin runs inert
// (packages/react/src/contexts/extract-client-provider.tsx) — but all four of
// bracemark-web's env files set NEXT_PUBLIC_EXTRACTOR_URL, so the null branch is
// exercised by no dev run, no e2e run and no deployed tier. A consumer that stopped
// honoring it would be green everywhere and would break only for whoever runs this
// without an extractor.
//
// The gate is asserted at the WIRE — did anything ask the extractor — rather than on
// the `enabled` flag, which is a restatement of the expression under test.

const mockFetchImage = jest.fn(() => Promise.resolve(new Uint8Array([1, 2, 3, 4])));
const extractor = {
  extract: jest.fn(),
  extractMany: jest.fn(() => Promise.resolve([])),
  fetchImage: mockFetchImage,
} as unknown as ExtractClient;

let mockUsername: string | null = 'alice';
let mockServerExtraction = true;

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: mockUsername }) }));
jest.mock('./sync-provider', () => ({
  useSync: () => ({ storeStatus: 'ready', requestSync: jest.fn() }),
}));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ serverExtraction: mockServerExtraction }),
}));

// A stand-in for Dexie's liveQuery: run the querier, re-run it when the deps change.
// The gate doesn't depend on Dexie's tracking-zone reactivity, only on the querier's
// answer reaching the drain effect.
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

// One link, permanently pending — so the ONLY thing that can stop a request is the
// gate. `runServerTitleImageBatch` is where the drain reaches the extractor.
const mockPending = [{ id: 'l1', url: 'https://example.com/a' }];
jest.mock('../data/queries', () => ({
  readLinksPendingTitleImageForLinkPaths: () => Promise.resolve(mockPending),
  readLinksPendingTitleImagePage: () => Promise.resolve({ links: mockPending, cursor: null }),
  readRawPendingTitleImageCount: () => Promise.resolve(mockPending.length),
}));
const mockRunBatch = jest.fn((_username: string, _links: LinkItem[], _client: ExtractClient) =>
  Promise.resolve(1),
);
jest.mock('../lib/server-extraction', () => ({
  runServerTitleImageBatch: (username: string, links: LinkItem[], client: ExtractClient) =>
    mockRunBatch(username, links, client),
}));

// No cached answer, so a permitted request always goes out — the gate is the only
// thing that can hold it back.
const mockPutFaviconNone = jest.fn(() => Promise.resolve());
jest.mock('../data/favicon-store', () => ({
  readFavicon: () => Promise.resolve(undefined),
  isFaviconStale: () => true,
  putFavicon: () => Promise.resolve(),
  putFaviconNone: () => mockPutFaviconNone(),
}));

function ReportsAPage() {
  const { reportDisplayedLinkPaths } = useExtraction();
  useEffect(() => reportDisplayedLinkPaths(['links/l1']), [reportDisplayedLinkPaths]);
  return null;
}

function AsksForAFavicon() {
  const { requestFavicon } = useFavicon();
  useEffect(() => requestFavicon('example.com'), [requestFavicon]);
  return null;
}

// `client` is what the app passes when an extractor origin is configured; `null` is
// what it passes when there is none.
async function mount(extractClient: ExtractClient | null) {
  await act(async () => {
    render(
      <ExtractClientProvider client={extractClient}>
        <ExtractionProvider>
          <ReportsAPage />
        </ExtractionProvider>
        <FaviconProvider>
          <AsksForAFavicon />
        </FaviconProvider>
      </ExtractClientProvider>,
    );
  });
}

describe('the server-extraction gate', () => {
  beforeEach(() => {
    mockUsername = 'alice';
    mockServerExtraction = true;
    mockRunBatch.mockClear();
    mockFetchImage.mockClear();
    mockPutFaviconNone.mockClear();
  });

  // The positive control. Without it every negative case below would also pass
  // against a provider that never extracts anything at all.
  it('extracts once the opt-in is on and an extractor is configured', async () => {
    await mount(extractor);
    await waitFor(() => expect(mockRunBatch).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockFetchImage).toHaveBeenCalledWith('https://example.com/favicon.ico'),
    );
  });

  // The null half: opted in, but this build has no extractor to talk to.
  it('sends nothing when no extractor is configured, opt-in or not', async () => {
    await mount(null);
    await act(async () => void (await Promise.resolve()));
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(mockFetchImage).not.toHaveBeenCalled();
  });

  // The opt-in half: an extractor is configured, but the user has not agreed to it.
  // This is the privacy-load-bearing one — it is the user's own answer.
  it('sends nothing while the opt-in is off', async () => {
    mockServerExtraction = false;
    await mount(extractor);
    await act(async () => void (await Promise.resolve()));
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(mockFetchImage).not.toHaveBeenCalled();
  });

  // Signed out — including the sign-out frame, where the store is wiped while the
  // tree is still mounted (docs/data-lifecycle.md, _the sign-out teardown_). There is
  // no account to attribute a fetch to and nowhere to write the result.
  it('sends nothing with no signed-in user', async () => {
    mockUsername = null;
    await mount(extractor);
    await act(async () => void (await Promise.resolve()));
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(mockFetchImage).not.toHaveBeenCalled();
  });

  // A closed gate must also leave NO TRACE in the favicon store, and the null half is
  // where that is easy to lose: every failure inside the pump records `none`, so a
  // provider that reached the fetch with no client would take the resulting TypeError
  // for "this site has no icon". `none` is a claim about the SITE, and recording it
  // because we had nobody to ask is a lie in the durable direction — the row outlives
  // the condition, so a build that later gains an extractor shows monograms for every
  // host it saw without one.
  it('records no verdict when there was no extractor to ask', async () => {
    await mount(null);
    await act(async () => void (await Promise.resolve()));
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The opt-in has to reach ALREADY-MOUNTED rows. `enabled` is a dependency of
  // `requestFavicon` so that flipping the switch changes the callback's identity and
  // re-runs their request effects; without that, turning server extraction on would
  // only take effect for rows mounted afterwards — which navigation happens to cause
  // today, but only by the accident of /settings being its own route.
  it('fills in a host it refused earlier, once the opt-in is turned on', async () => {
    mockServerExtraction = false;
    // A fresh element each time: React bails out of re-rendering an identical one,
    // and the opt-in lives outside props here (it comes through useSettings).
    const tree = () => (
      <ExtractClientProvider client={extractor}>
        <FaviconProvider>
          <AsksForAFavicon />
        </FaviconProvider>
      </ExtractClientProvider>
    );
    const { rerender } = render(tree());
    await act(async () => void (await Promise.resolve()));
    expect(mockFetchImage).not.toHaveBeenCalled();

    mockServerExtraction = true;
    await act(async () => void rerender(tree()));
    await waitFor(() =>
      expect(mockFetchImage).toHaveBeenCalledWith('https://example.com/favicon.ico'),
    );
  });

  // "Extract all" lifts the auto budget and the visibility gate — deliberately, it is
  // an explicit finite job — so it is the one path where a gate regression would be
  // loudest: a full-library walk against a server the user never agreed to reach.
  it('refuses an explicit extract-all through a closed gate', async () => {
    mockServerExtraction = false;
    let extractAll = (): void => void 0;
    function Controls() {
      extractAll = useExtraction().extractAll;
      return null;
    }
    await act(async () => {
      render(
        <ExtractClientProvider client={extractor}>
          <ExtractionProvider>
            <Controls />
          </ExtractionProvider>
        </ExtractClientProvider>,
      );
    });
    await act(async () => void extractAll());
    expect(mockRunBatch).not.toHaveBeenCalled();
  });
});
