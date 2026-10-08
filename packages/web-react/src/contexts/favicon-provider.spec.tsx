/**
 * @jest-environment jsdom
 */
import { TextDecoder } from 'node:util';

import { StrictMode, useEffect } from 'react';
import { act, render, type RenderResult } from '@testing-library/react';

import { ExtractClientProvider } from '@stxapps/react';
import type { ExtractClient } from '@stxapps/shared';

import { FaviconProvider, useFavicon } from './favicon-provider';

// THE FAVICON QUEUE — which is all this provider is. The fetch belongs to the extractor
// proxy and the verdict to @stxapps/shared; what lives here is the policy around them.
//
// `contexts/server-extraction-gate.spec.tsx` already pins the rule this provider holds in
// duplicate with ExtractionProvider: nothing STARTS through a closed gate. This file is
// about the queue that already started, plus the two claims the source header makes that
// nothing anywhere checks — one fetch per HOST, and a bounded fan-out.
//
// The load-bearing case is the switch-off mid-queue (favicon-provider.tsx:124-130), and it
// is reachable only through the DEFERRED pump: `requestFavicon` won't enqueue with the
// opt-in off, and the drain's check runs synchronously inside `pump`, so the first
// MAX_IN_FLIGHT hosts can never see a flipped switch. It takes a queue longer than the cap
// flipped during the stagger — one scroll through a page of distinct hosts and one trip to
// /settings. Both halves of that branch fail silently:
//
//   - the guard itself: without it the queued tail still reaches third-party origins
//     through the extractor AFTER the user said stop. The same privacy rule the gate spec
//     is for, on the one path that can break it after the fact;
//   - `handledRef.delete(host)`: without it the dropped hosts stay marked handled for the
//     life of the session, so turning the opt-in back on leaves a permanent monogram for
//     whatever was queued at the moment of the flip — and `handledRef` is session memory
//     no row can repair, so nothing but a reload ever re-asks.
//
// NOTHING HERE HARDCODES `MAX_IN_FLIGHT` OR `STAGGER_MS`. The first burst's size is read
// off the run and only its RELATION to the queue is asserted (0 < burst < asked), which
// does double duty. It stops the negative cases going vacuous — "nothing more went out"
// passes just as well against a provider that never pumped a second time, and that bound
// is what catches it — and if the cap is ever raised past the queue this file asks for,
// the bound fails loudly, naming the setup, instead of quietly asserting nothing. Lengthen
// HOSTS when it does.
//
// The store is mocked away (as in the gate spec), so this file needs no IndexedDB and no
// `structuredClone` under jsdom. The VERDICT is not mocked — `isRenderableIconBytes` runs
// for real on real bytes, because the wiring from bytes to `putFavicon` vs `putFaviconNone`
// is the part that lives here.

// jsdom ships no `TextDecoder`, and the SVG half of the icon sniff decodes text
// (@stxapps/shared image/sniff.ts, `isSvgBytes`). It runs only where the raster sniff
// comes back empty — which is exactly the non-icon bytes below, a PNG taking its verdict
// from magic bytes and decoding nothing. So without this line the sniff THROWS on that
// one case, the provider's catch records `none` anyway, and the `records 'none' when the
// bytes are not an icon` case passes through the FAILURE path: inverting the verdict in the
// source leaves it green, which is how this was found. Its positive control below catches
// that inversion with or without the polyfill, which is no help — a negative case that
// can only be reached through a throw is asserting nothing about the verdict at all.
global.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;

// A real PNG signature, and what a host with no /favicon.ico actually serves: an HTML
// error page, which the proxy passes through under the upstream's declared `image/*` (the
// source header, WHAT THE PROXY DOESN'T DECIDE).
const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const htmlBytes = Uint8Array.from('<!doctype html><title>404 Not Found</title>', (c) =>
  c.charCodeAt(0),
);

// Long enough that the cap can't drain it in one burst — asserted, not assumed.
const HOSTS = Array.from({ length: 12 }, (_, i) => `host-${i + 1}.example`);

const mockFetchImage = jest.fn((_url: string) => Promise.resolve(iconBytes));
const extractor = {
  extract: jest.fn(),
  extractMany: jest.fn(() => Promise.resolve([])),
  fetchImage: mockFetchImage,
} as unknown as ExtractClient;

let mockUsername: string | null = 'alice';
let mockServerExtraction = true;

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: mockUsername }) }));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ serverExtraction: mockServerExtraction }),
}));

// No cached answer for any host, so the queue is the only thing deciding what goes out.
const mockPutFavicon = jest.fn((_username: string, _host: string, _bytes: Uint8Array) =>
  Promise.resolve(),
);
const mockPutFaviconNone = jest.fn((_username: string, _host: string) => Promise.resolve());
jest.mock('../data/favicon-store', () => ({
  readFavicon: () => Promise.resolve(undefined),
  isFaviconStale: () => true,
  putFavicon: (username: string, host: string, bytes: Uint8Array) =>
    mockPutFavicon(username, host, bytes),
  putFaviconNone: (username: string, host: string) => mockPutFaviconNone(username, host),
}));

// The mounted rows: every one of them asks, once, on mount — and again whenever
// `requestFavicon` changes identity, which is how the opt-in reaches rows already on
// screen.
function AsksForFavicons({ hosts }: { hosts: string[] }) {
  const { requestFavicon } = useFavicon();
  useEffect(() => {
    for (const host of hosts) requestFavicon(host);
  }, [hosts, requestFavicon]);
  return null;
}

// A fresh element each time: React bails out of re-rendering an identical one, and the
// opt-in lives outside props here (it comes through useSettings).
const tree = (hosts: string[]) => (
  <ExtractClientProvider client={extractor}>
    <FaviconProvider>
      <AsksForFavicons hosts={hosts} />
    </FaviconProvider>
  </ExtractClientProvider>
);

// Let the pending promise chains run WITHOUT touching the clock, so exactly one burst has
// gone out when this returns — the stagger is a timer, and it stays unfired.
async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => void (await Promise.resolve()));
}

// Run the staggered pumps to exhaustion: each round fires the pending `setTimeout(pump)`
// and lets the fetches it starts settle, which is what schedules the next round.
async function drain() {
  for (let round = 0; round < HOSTS.length + 2; round += 1) {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
    await settle();
  }
}

// The rows mount in a LATER commit than the provider, which is the order the app has —
// FaviconProvider lives in the `(app)` layout, and `useFaviconUrl` defers its request
// behind a 300ms settle besides. Kept because it is the app's order, not because the
// queue depends on it: writing this file was what surfaced the account-change reset
// (`queueRef = []`, `handledRef.clear()`) firing on MOUNT as well — and since a parent's
// effect runs after its children's, a row that asked inside the provider's own first
// commit had its request silently dropped, everything past the first MAX_IN_FLIGHT,
// which is queued rather than in flight. The provider now compares the account its
// session memory belongs to instead of resetting on every mount, so asking that early
// would measure the queue rather than the wipe. Mounting later stays anyway: a spec that
// takes a different path through the provider than the app does is measuring its own
// setup.
async function mount(hosts: string[]): Promise<RenderResult> {
  let result!: RenderResult;
  await act(async () => void (result = render(tree([]))));
  await settle();
  await act(async () => void result.rerender(tree(hosts)));
  await settle();
  return result;
}

// Which hosts the extractor was actually asked for, in order — the wire, not the flag.
function fetched(): string[] {
  return mockFetchImage.mock.calls.map(([url]) => new URL(url).host);
}

const sorted = (hosts: string[]) => [...hosts].sort();

describe('the favicon queue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUsername = 'alice';
    mockServerExtraction = true;
    mockFetchImage.mockReset();
    mockFetchImage.mockImplementation(() => Promise.resolve(iconBytes));
    mockPutFavicon.mockClear();
    mockPutFaviconNone.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // The economics the whole feature rests on: an icon-per-site is affordable where an
  // icon-per-link would not be. A page of 200 Hacker News links buys ONE fetch — and the
  // guard is keyed by host, not "first host wins", so a second host still buys its own.
  it('buys one fetch per host, however many rows ask for it', async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? 'news.ycombinator.com' : 'example.com',
    );
    await mount(rows);
    await drain();

    expect(sorted(fetched())).toEqual(['example.com', 'news.ycombinator.com']);
  });

  // Why the queue exists at all. Scrolling into a run of all-distinct hosts must not fire a
  // request per row at once: that trips the extractor's per-IP rate cap and gets the whole
  // burst rejected, so an unbounded fan-out shows FEWER icons, not more. The fetches are
  // held open here, which is the only state in which "how many at once" is observable.
  it('bounds the fan-out — a page of distinct hosts is not a request per row', async () => {
    mockFetchImage.mockImplementation(() => new Promise<typeof iconBytes>(() => undefined));
    await mount(HOSTS);
    await drain();

    expect(fetched().length).toBeGreaterThan(0);
    expect(fetched().length).toBeLessThan(HOSTS.length);
  });

  // The positive control for both switch-off cases below. Without it, a provider that
  // pumped exactly once and then stopped forever would pass every one of them.
  it('drains the whole queue while the opt-in stays on', async () => {
    await mount(HOSTS);
    expect(fetched().length).toBeLessThan(HOSTS.length);

    await drain();
    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // The privacy tail. The gate spec proves no request STARTS through a closed gate; this is
  // the queue that was already moving when the user closed it. Every host still in it is a
  // third-party origin about to be disclosed to our extractor after the answer changed to
  // no.
  it('sends nothing more once the opt-in is switched off mid-queue', async () => {
    const { rerender } = await mount(HOSTS);
    const burst = fetched();
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.length).toBeLessThan(HOSTS.length);

    mockServerExtraction = false;
    await act(async () => void rerender(tree(HOSTS)));
    await drain();

    expect(fetched()).toEqual(burst);
  });

  // And it leaves NO TRACE, for the reason the gate spec gives for the null-extractor half:
  // `none` is a claim about the SITE, and the row outlives the condition. Recording it
  // because permission was withdrawn mid-queue would mean a host the user never got an
  // answer for shows a monogram for FAVICON_RETRY_MS after they opt back in.
  it('records no verdict for the hosts the switch-off dropped', async () => {
    const { rerender } = await mount(HOSTS);
    expect(fetched().length).toBeLessThan(HOSTS.length);

    mockServerExtraction = false;
    await act(async () => void rerender(tree(HOSTS)));
    await drain();

    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The other half of the same branch: the dropped hosts are FORGOTTEN, not remembered as
  // handled. `handledRef` is session memory, so without the delete nothing short of a
  // reload ever re-asks — the icons come back for rows mounted later and stay monograms for
  // exactly the hosts that were queued when the switch flipped. Each host is still fetched
  // once overall: the burst that already resolved is not re-asked.
  it('re-asks the hosts the switch-off dropped, once the opt-in comes back', async () => {
    const { rerender } = await mount(HOSTS);
    const burst = fetched();
    expect(burst.length).toBeLessThan(HOSTS.length);

    mockServerExtraction = false;
    await act(async () => void rerender(tree(HOSTS)));
    await drain();
    expect(fetched()).toEqual(burst);

    mockServerExtraction = true;
    await act(async () => void rerender(tree(HOSTS)));
    await drain();

    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // The proxy got us bytes; whether they are an ICON is this provider's call. An HTML error
  // page served as `image/x-icon` sails through the proxy's allowlist, and an `ok` row never
  // expires — so taking the proxy's word for it caches an unrenderable blob against the
  // origin's storage quota, permanently.
  it('records `none` when the bytes are not an icon', async () => {
    mockFetchImage.mockImplementation(() => Promise.resolve(htmlBytes));
    await mount(['example.com']);

    expect(mockPutFaviconNone).toHaveBeenCalledWith('alice', 'example.com');
    expect(mockPutFavicon).not.toHaveBeenCalled();
  });

  // The positive control for the verdict: real icon bytes are cached, so the case above is
  // the sniff talking and not a provider that records `none` for everything.
  it('caches the bytes when they are an icon', async () => {
    await mount(['example.com']);

    expect(mockPutFavicon).toHaveBeenCalledWith('alice', 'example.com', iconBytes);
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });
});

// The provider sits under the auth gate, so a sign-out is an UNMOUNT — and the drain is
// refs and timers, which an unmount does not stop by itself. A browser tab hides this:
// sign-out navigates off the origin and the document goes with the queue. The INSTALLED
// app stays on it, and there the loop ran on: one request per queued host through the
// extractor for the signed-out account's saved sites, each answer then written into the
// table the sign-out had just wiped. Nothing reports either half.
describe('the drain ends with the provider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUsername = 'alice';
    mockServerExtraction = true;
    mockFetchImage.mockReset();
    mockFetchImage.mockImplementation(() => Promise.resolve(iconBytes));
    mockPutFavicon.mockClear();
    mockPutFaviconNone.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sends nothing more once it has unmounted, however much was queued', async () => {
    const result = await mount(HOSTS);
    const sentBefore = fetched().length;
    // The cap held the tail back, or this would assert nothing.
    expect(sentBefore).toBeGreaterThan(0);
    expect(sentBefore).toBeLessThan(HOSTS.length);

    result.unmount();
    await drain();

    expect(fetched().length).toBe(sentBefore);
  });

  it('writes nothing for a fetch that was still out when it unmounted', async () => {
    const answers: ((bytes: typeof iconBytes) => void)[] = [];
    mockFetchImage.mockImplementation(() => new Promise((resolve) => void answers.push(resolve)));
    const result = await mount(['example.com']);
    expect(answers).toHaveLength(1);

    result.unmount();
    answers[0]?.(iconBytes);
    await drain();

    expect(mockPutFavicon).not.toHaveBeenCalled();
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The store's fence (data/favicon-store.ts) refuses a write that outlived its account.
  // The provider's part is to let that be the end of it — not to answer the refusal with
  // a `none`, which would be a second write for the same signed-out account.
  it('does not follow a refused write with a `none`', async () => {
    mockPutFavicon.mockImplementationOnce(() => Promise.reject(new Error('fenced')));
    await mount(['example.com']);
    await drain();

    expect(mockPutFavicon).toHaveBeenCalledTimes(1);
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The stop must be a REAL unmount's, and only that. Two orderings would otherwise
  // trip it on a provider that is very much alive — a row's effect runs before its
  // provider's (children first), and StrictMode runs mount → cleanup → mount in one
  // commit. Either one, read naively, drops whatever the rows asked for in the first
  // commit and never re-asks, since those hosts stay marked handled. Asked in the
  // FIRST commit here, unlike `mount` above, because that is the ordering at stake.
  it('keeps draining through StrictMode, for rows that asked in the first commit', async () => {
    await act(async () => void render(<StrictMode>{tree(HOSTS)}</StrictMode>));
    await settle();
    await drain();

    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // A transport failure still earns its `none` — the refusal above is about the WRITE.
  it('still records `none` when the fetch itself fails', async () => {
    mockFetchImage.mockImplementation(() => Promise.reject(new Error('blocked')));
    await mount(['example.com']);
    await drain();

    expect(mockPutFaviconNone).toHaveBeenCalledWith('alice', 'example.com');
  });
});
