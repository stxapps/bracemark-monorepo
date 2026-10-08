import { StrictMode, useEffect } from 'react';
import { View } from 'react-native';
import { act, render, type RenderResult } from '@testing-library/react-native';

import { FaviconProvider, useFavicon } from './favicon-provider';

// THE GESTURED EXEMPTION — the one thing in this provider that is NOT web's queue.
//
// web-react's `contexts/favicon-provider.spec.tsx` is canonical for the mechanics the two
// share (one fetch per host, bounded fan-out, why the drain's guard is reachable only
// through the deferred pump, and why nothing here hardcodes MAX_IN_FLIGHT or STAGGER_MS).
// What is expo's alone is the SHAPE of that guard: `!gestured && !enabledRef.current`,
// against web's `!enabledRef.current`. Two entry points, one queue, and the asymmetry
// between them is the whole rule:
//
//   - `requestFavicon` — a row scrolled past. Un-gestured by construction, so it needs
//     `deviceExtractionMode === 'all'`, and it must STOP if the mode is lowered while its
//     queue is still draining.
//   - `requestFaviconNow` — the links the user just saved on this device, whose pages
//     `extractNow` is fetching in the same breath. Its licence was the save, which already
//     happened and cannot be revoked by a later toggle, so it must survive a mode BELOW
//     `all` — including in the tail of the queue, past the fan-out cap.
//
// Both directions fail silently, and on this platform the branch is not a race — it is
// steady state. `saves` is the DEFAULT mode (DEVICE_EXTRACTION_MODES), so every save of
// more than MAX_IN_FLIGHT links out of the share outbox puts gestured hosts in a queue
// whose drain reads an `enabled` that is, and stays, false. Drop the `!gestured` half and
// the first few icons of a bulk save appear while the rest never do; drop the
// `!enabledRef.current` half and a lowered mode keeps reaching sites the user asked this
// device to stop contacting. Neither shows up as an error, a type or a failing test —
// only as icons that are there or aren't, on a device, after a share.
//
// The fetch itself is `lib/favicon-fetch`, spec'd separately and mocked here: what this
// file is about is which hosts reach it.

const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

// Long enough that the cap can't drain it in one burst — asserted, not assumed.
const HOSTS = Array.from({ length: 12 }, (_, i) => `host-${i + 1}.example`);
const NONE: string[] = [];

const mockFetchFaviconBytes = jest.fn((_host: string): Promise<Uint8Array | undefined> =>
  Promise.resolve(iconBytes),
);
jest.mock('../lib/favicon-fetch', () => ({
  fetchFaviconBytes: (host: string) => mockFetchFaviconBytes(host),
}));

let mockUsername: string | null = 'alice';
let mockMode = 'all';

jest.mock('./auth-provider', () => ({ useAuth: () => ({ username: mockUsername }) }));
jest.mock('../hooks/use-settings', () => ({
  useSettings: () => ({ deviceExtractionMode: mockMode }),
}));

// No cached answer for any host, so the queue is the only thing deciding what goes out.
const mockPutFavicon = jest.fn((_username: string, _host: string, _bytes: Uint8Array) =>
  Promise.resolve(),
);
const mockPutFaviconNone = jest.fn((_username: string, _host: string) => Promise.resolve());
const mockReadFavicon = jest.fn((): Promise<undefined> => Promise.resolve(undefined));
jest.mock('../data/favicon-store', () => ({
  readFavicon: () => mockReadFavicon(),
  isFaviconStale: () => true,
  putFavicon: (username: string, host: string, bytes: Uint8Array) =>
    mockPutFavicon(username, host, bytes),
  putFaviconNone: (username: string, host: string) => mockPutFaviconNone(username, host),
}));

// Both entry points, in the order the app uses them — a row asks, and a save asks. Two
// effects rather than a branch, so a single mount can exercise the queue they SHARE.
function AsksForFavicons({ rows, saved }: { rows: string[]; saved: string[] }) {
  const { requestFavicon, requestFaviconNow } = useFavicon();
  useEffect(() => {
    for (const host of rows) requestFavicon(host);
  }, [rows, requestFavicon]);
  useEffect(() => {
    requestFaviconNow(saved);
  }, [saved, requestFaviconNow]);
  // A host element, not `null`: react-test-renderer reports a tree that renders nothing as
  // UNMOUNTED, and RNTL's render result throws reaching for its root.
  return <View />;
}

// A fresh element each time: React bails out of re-rendering an identical one, and the
// mode lives outside props here (it comes through useSettings).
const tree = (rows: string[], saved: string[]) => (
  <FaviconProvider>
    <AsksForFavicons rows={rows} saved={saved} />
  </FaviconProvider>
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

// The askers mount in a LATER commit than the provider, which is the order the app has —
// FaviconProvider lives in the `(app)` layout, and `useFaviconUri` defers its request
// behind a settle delay besides. Kept because it is the app's order, not because the queue
// depends on it: the account-change reset (`queueRef = []`, `handledRef.clear()`) used to
// fire on MOUNT as well, and a parent's effect runs after its children's, so anything asked
// inside the provider's own first commit was dropped from the queue — everything past the
// first MAX_IN_FLIGHT, which is queued rather than in flight. Both providers now compare
// the account their session memory belongs to instead (web's file-content-provider carries
// the reasoning), so asking that early would measure the queue rather than the wipe.
// Mounting later stays anyway: a spec that takes a different path through the provider
// than the app does is measuring its own setup.
async function mount(rows: string[], saved: string[] = NONE): Promise<RenderResult> {
  // `render` and `rerender` wrap themselves in `act`; wrapping them again leaves the test
  // renderer looking unmounted (RNTL reads `.root` off the result it just built).
  const result = render(tree(NONE, NONE));
  await settle();
  result.rerender(tree(rows, saved));
  await settle();
  return result;
}

const fetched = () => mockFetchFaviconBytes.mock.calls.map(([host]) => host);
const sorted = (hosts: string[]) => [...hosts].sort();

describe('the favicon queue, and what the gesture exempts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUsername = 'alice';
    mockMode = 'all';
    mockFetchFaviconBytes.mockReset();
    mockFetchFaviconBytes.mockImplementation(() => Promise.resolve(iconBytes));
    mockPutFavicon.mockClear();
    mockPutFaviconNone.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // The positive control for every negative case below: without it, a provider that pumped
  // once and then stopped forever would pass all of them.
  it('drains the whole un-gestured queue while the mode stays at `all`', async () => {
    await mount(HOSTS);
    expect(fetched().length).toBeLessThan(HOSTS.length);

    await drain();
    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // The un-gestured half. Every host still queued is a site this device has not contacted —
  // each fetch here is STANDALONE, so it is a fresh disclosure of this device's IP — and
  // the user has just said stop.
  it('drops the un-gestured tail when the mode is lowered mid-queue', async () => {
    const { rerender } = await mount(HOSTS);
    const burst = fetched();
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.length).toBeLessThan(HOSTS.length);

    mockMode = 'saves';
    rerender(tree(HOSTS, NONE));
    await settle();
    await drain();

    expect(fetched()).toEqual(burst);
  });

  // And it leaves no trace: `none` is a claim about the SITE, and the row outlives the
  // condition. Recording it because permission was withdrawn mid-queue would show a
  // monogram for FAVICON_RETRY_MS on hosts nobody ever asked.
  it('records no verdict for the hosts a lowered mode dropped', async () => {
    const { rerender } = await mount(HOSTS);
    expect(fetched().length).toBeLessThan(HOSTS.length);

    mockMode = 'saves';
    rerender(tree(HOSTS, NONE));
    await settle();
    await drain();

    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The other half of the same branch: dropped hosts are FORGOTTEN, not remembered as
  // handled. `handledRef` is session memory no row can repair, so without the delete the
  // hosts that were queued at the moment of the toggle stay monograms until the app is
  // restarted — and the mode is a synced preference, so it can be lowered on another
  // device and land here mid-scroll.
  it('re-asks the hosts a lowered mode dropped, once it returns to `all`', async () => {
    const { rerender } = await mount(HOSTS);
    const burst = fetched();
    expect(burst.length).toBeLessThan(HOSTS.length);

    mockMode = 'saves';
    rerender(tree(HOSTS, NONE));
    await settle();
    await drain();
    expect(fetched()).toEqual(burst);

    mockMode = 'all';
    rerender(tree(HOSTS, NONE));
    await settle();
    await drain();

    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // THE EXEMPTION, at the default mode. A share of a dozen links has to fill in a dozen
  // icons: the fan-out cap means most of them reach the drain from the QUEUE, where the
  // only thing distinguishing them from a scrolled-past row is the flag they were queued
  // with. Without it the save's first few icons appear and the rest never do — the
  // half-truth in the settings copy that `requestFaviconNow` exists to prevent.
  it('fetches every gestured host below `all`, tail included', async () => {
    mockMode = 'saves';
    await mount(NONE, HOSTS);
    expect(fetched().length).toBeGreaterThan(0);
    expect(fetched().length).toBeLessThan(HOSTS.length);

    await drain();
    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // `off` is the mode that promises this device never contacts a site you save, so it
  // stops the gestured path too — the one gate `requestFaviconNow` does honour, and the
  // reason it reads the mode through a ref rather than skipping the check.
  it('sends nothing at all in mode `off`, gestured or not', async () => {
    mockMode = 'off';
    await mount(HOSTS, HOSTS);
    await drain();

    expect(fetched()).toEqual([]);
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // One queue, one single-flight guard, across both doors. A link saved on this device is
  // also a row on the links page, so the same host arrives by both paths within a second
  // of itself — and the whole economics of an icon-per-site is that it buys one fetch.
  it('fetches a host asked for by both entry points once', async () => {
    await mount(['example.com'], ['example.com']);
    await drain();

    expect(fetched()).toEqual(['example.com']);
  });

  // WHAT THE NEGATIVE CASES ABOVE CANNOT SAY. Three of them assert only that
  // `putFaviconNone` was NOT called, and a provider that fetched every host correctly and
  // then wrote nothing at all satisfies every one — deleting both writes from the drain
  // leaves this file green without these two. The wiring has no other cover:
  // `data/favicon-store.spec.ts` exercises the store alone, `lib/favicon-fetch.spec.ts`
  // stops at the bytes, and which of the two writes a fetch earns is decided here.
  it('writes the bytes a fetch came back with', async () => {
    await mount(['example.com']);
    await drain();

    expect(mockPutFavicon).toHaveBeenCalledWith('alice', 'example.com', iconBytes);
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // `undefined` is `fetchFaviconBytes` reporting that it got an answer and the answer was
  // not an icon — a 404 page, a login redirect, anything the shared verdict refuses (the
  // verdict is its own; see lib/favicon-fetch.ts). That is a claim about the SITE, so it
  // has to land as a row: the `none` is what FAVICON_RETRY_MS then ages out, and without
  // it every mount re-asks a host that will never have an icon, on a metered connection.
  it('records `none` when the fetch says the host has no usable icon', async () => {
    mockFetchFaviconBytes.mockImplementation(() => Promise.resolve(undefined));
    await mount(['example.com']);
    await drain();

    expect(mockPutFaviconNone).toHaveBeenCalledWith('alice', 'example.com');
    expect(mockPutFavicon).not.toHaveBeenCalled();
  });

  // A transport failure is the same claim as far as the cache goes: nothing usable came
  // back, so the host gets its `none` and the retry window, not a request per mount.
  it('records `none` when the fetch itself fails', async () => {
    mockFetchFaviconBytes.mockImplementation(() => Promise.reject(new Error('timeout')));
    await mount(['example.com']);
    await drain();

    expect(mockPutFaviconNone).toHaveBeenCalledWith('alice', 'example.com');
  });
});

// The provider sits under the auth gate, so a sign-out is an UNMOUNT — and the drain is
// refs and timers, which an unmount does not stop by itself. It used to run on: one
// request per queued host to the signed-out account's saved sites, from a screen that no
// longer existed, each answer then written into the store the sign-out had just wiped.
// Nothing reports either half. The requests are the disclosure the mode exists to
// control, and the rows are the browsing shape clearData exists to remove.
describe('the drain ends with the provider', () => {
  it('does not begin a fetch when the cache read finishes after unmount', async () => {
    let resolve!: (value: undefined) => void;
    mockReadFavicon.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = render(tree(['example.com'], NONE));
    expect(mockReadFavicon).toHaveBeenCalledTimes(1);
    result.unmount();
    await act(async () => {
      jest.runAllTicks();
      resolve(undefined);
    });
    await drain();

    expect(mockFetchFaviconBytes).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockReadFavicon.mockReset();
    mockReadFavicon.mockResolvedValue(undefined);
    mockUsername = 'alice';
    mockMode = 'all';
    mockFetchFaviconBytes.mockReset();
    mockFetchFaviconBytes.mockImplementation(() => Promise.resolve(iconBytes));
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
    expect(sentBefore).toBeLessThan(HOSTS.length);

    result.unmount();
    await drain();

    expect(fetched().length).toBe(sentBefore);
  });

  it('writes nothing for a fetch that was still out when it unmounted', async () => {
    const answers: ((bytes: Uint8Array | undefined) => void)[] = [];
    mockFetchFaviconBytes.mockImplementation(
      () => new Promise((resolve) => void answers.push(resolve)),
    );
    const result = await mount(['example.com']);
    expect(answers).toHaveLength(1);

    result.unmount();
    answers[0]?.(iconBytes);
    await drain();

    expect(mockPutFavicon).not.toHaveBeenCalled();
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });

  // The stop must be a REAL unmount's, and only that. Two orderings would otherwise
  // trip it on a provider that is very much alive — a row's effect runs before its
  // provider's (children first), and StrictMode runs mount → cleanup → mount in one
  // commit. Either one, read naively, drops whatever the rows asked for in the first
  // commit and never re-asks, since those hosts stay marked handled. Asked in the
  // FIRST commit here, unlike `mount` above, because that is the ordering at stake.
  it('keeps draining through StrictMode, for rows that asked in the first commit', async () => {
    render(<StrictMode>{tree(HOSTS, NONE)}</StrictMode>);
    await settle();
    await drain();

    expect(sorted(fetched())).toEqual(sorted(HOSTS));
  });

  // The store's fence (favicon-store.ts) refuses a write that outlived its account. The
  // provider's part is to let that be the end of it — not to answer the refusal with a
  // `none`, which would be a second write for the same signed-out account.
  it('does not follow a refused write with a `none`', async () => {
    mockPutFavicon.mockImplementationOnce(() => Promise.reject(new Error('fenced')));
    await mount(['example.com']);
    await drain();

    expect(mockPutFavicon).toHaveBeenCalledTimes(1);
    expect(mockPutFaviconNone).not.toHaveBeenCalled();
  });
});
