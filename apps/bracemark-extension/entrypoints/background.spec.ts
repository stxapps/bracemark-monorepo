import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import type { ExtensionMessage } from '../utils/messages';
import background from './background';

// The service worker's wiring. Its two leaf jobs are pinned elsewhere
// (sync-runner.spec.ts, extraction-worker.spec.ts); what only this file decides is
// when they run and what the popup gets back — and MV3's shape makes each of those
// a silent failure:
//
//   - THE WORKER IS EPHEMERAL, so recurring work can't be a loop. It is a
//     `browser.alarms` tick plus a kick at spin-up, and a missing alarm looks
//     exactly like a working extension until the popup has been shut for an hour.
//   - THE SESSION MIRROR GOES STALE. The popup owns sign-in; the worker is a
//     separate JS context and shares state with it only through IndexedDB. Every
//     trigger therefore re-hydrates FIRST — this is the single hydration point, so
//     the leaf handlers can stay synchronous `getSession()` readers. Skip it on one
//     path and that path 401s on a cold worker.
//   - EXTRACT IS DEDUPED PER link+facet. Messages are handled concurrently, so a
//     double-clicked screenshot button would run the capture twice; both runs reach
//     `writeFile`, the second `extractions/` write wins, and the loser's blob is
//     left referenced by nothing — synced, charged against the quota, never
//     reclaimed. The mark is in memory and released in a `finally`: one that
//     outlived its run would strand the facet where no path looks again.

const mockGetSession = jest.fn<{ username: string } | null, []>();
const mockLoadSession = jest.fn(async () => undefined);
const mockRunSync = jest.fn(async () => undefined);
const mockRunExtraction = jest.fn(async () => undefined);

jest.mock('@stxapps/web-react', () => ({
  get getSession() {
    return mockGetSession;
  },
  get loadSession() {
    return mockLoadSession;
  },
}));
jest.mock('@/utils/sync-runner', () => ({
  get runSync() {
    return mockRunSync;
  },
}));
jest.mock('@/utils/extraction-worker', () => ({
  get runExtraction() {
    return mockRunExtraction;
  },
}));

let fake: FakeBrowser;

/** Drain the microtask queue — every trigger here awaits `loadSession()` first. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Boot the worker, as the browser does on install / browser start / wake, and let
 * its spin-up cycle finish. Awaiting matters: `void withSession(runSync)` hydrates
 * before it syncs, so the cycle lands a microtask AFTER `main()` returns — long
 * enough for a synchronous test body to have swapped the mock underneath it.
 */
async function boot(): Promise<void> {
  background.main?.();
  await flush();
}

/** Send a message the way the popup does, and resolve with what it gets back. */
function send(message: ExtensionMessage): Promise<unknown> {
  const listener = fake.runtime.onMessage.listener;
  if (!listener) throw new Error('background registered no message listener');
  return new Promise((resolve) => {
    const kept = listener(message, {}, resolve);
    // The listener must claim the channel synchronously, or Chrome closes it and
    // the popup's `sendMessage` promise resolves as undefined.
    expect(kept).toBe(true);
  });
}

/** A promise the spec resolves by hand, to hold an extraction open. */
function deferred(): { promise: Promise<undefined>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<undefined>((res) => {
    resolve = () => res(undefined);
  });
  return { promise, resolve };
}

beforeEach(() => {
  // reset, not clear: a `mockRejectedValue` left standing would land on the next
  // test's fire-and-forget `void runSync()` as an unhandled rejection. It runs
  // BEFORE the fake is installed — `resetAllMocks` reaches every spy in the
  // registry, the fake browser's included, and would strip the implementations
  // that record its listeners.
  jest.resetAllMocks();
  fake = installFakeBrowser();
  mockGetSession.mockReturnValue({ username: 'alice' });
  mockLoadSession.mockResolvedValue(undefined);
  mockRunSync.mockResolvedValue(undefined);
  mockRunExtraction.mockResolvedValue(undefined);
});

describe('the recurring work', () => {
  it('registers the hourly sync alarm and kicks a cycle at spin-up', async () => {
    await boot();

    expect(fake.alarms.create).toHaveBeenCalledWith('bracemark-sync', { periodInMinutes: 60 });
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('syncs on its own alarm and ignores anyone else’s', async () => {
    await boot();
    mockRunSync.mockClear();

    fake.alarms.onAlarm.dispatch('some-other-extension-alarm');
    await flush();
    expect(mockRunSync).not.toHaveBeenCalled();

    fake.alarms.onAlarm.dispatch('bracemark-sync');
    await flush();
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('runs NO background extraction sweep — the extension is active-context only', async () => {
    // No `<all_urls>` grant, so it can never bg-fetch a saved URL; that residual
    // belongs to bracemark-extractor (docs/link-extraction.md).
    await boot();
    fake.alarms.onAlarm.dispatch('bracemark-sync');
    await flush();

    expect(mockRunExtraction).not.toHaveBeenCalled();
  });
});

describe('the session hydration', () => {
  it('re-reads the session before the startup cycle', async () => {
    await boot();

    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunSync.mock.invocationCallOrder[0],
    );
  });

  it('re-reads the session before an alarm cycle', async () => {
    await boot();
    mockLoadSession.mockClear();
    mockRunSync.mockClear();

    fake.alarms.onAlarm.dispatch('bracemark-sync');
    await flush();

    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunSync.mock.invocationCallOrder[0],
    );
  });

  it('re-reads the session before handling a message', async () => {
    await boot();
    mockLoadSession.mockClear();

    await send({ type: 'EXTRACT', linkId: 'link-1', facet: 'titleImage' });

    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunExtraction.mock.invocationCallOrder[0],
    );
  });
});

describe('KICK_SYNC', () => {
  it('runs a cycle and reports success', async () => {
    await boot();
    mockRunSync.mockClear();

    await expect(send({ type: 'KICK_SYNC' })).resolves.toEqual({ ok: true });
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('reports a failed cycle back to the caller instead of throwing into the void', async () => {
    await boot();
    mockRunSync.mockRejectedValue(new Error('offline'));

    await expect(send({ type: 'KICK_SYNC' })).resolves.toEqual({ ok: false, error: 'offline' });
  });
});

describe('EXTRACT', () => {
  const message: ExtensionMessage = { type: 'EXTRACT', linkId: 'link-1', facet: 'titleImage' };

  it('captures the facet for the signed-in account', async () => {
    await boot();

    await expect(send(message)).resolves.toEqual({ ok: true });
    expect(mockRunExtraction).toHaveBeenCalledWith('alice', 'link-1', 'titleImage');
  });

  it('refuses when there is no session', async () => {
    mockGetSession.mockReturnValue(null);
    await boot();

    await expect(send(message)).resolves.toEqual({ ok: false, error: 'Not signed in' });
    expect(mockRunExtraction).not.toHaveBeenCalled();
  });

  it('pushes the captured bytes after the write, without making the caller wait', async () => {
    await boot();
    mockRunSync.mockClear();

    await send(message);

    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(mockRunSync.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRunExtraction.mock.invocationCallOrder[0],
    );
  });

  it('reports a failed capture with its message', async () => {
    await boot();
    mockRunExtraction.mockRejectedValue(new Error('Active tab is no longer this link’s page'));

    await expect(send(message)).resolves.toEqual({
      ok: false,
      error: 'Active tab is no longer this link’s page',
    });
  });

  it('runs one capture per link+facet, however many times it is asked', async () => {
    // A double-clicked button, or a save's auto-extract overlapping a manual one.
    const held = deferred();
    mockRunExtraction.mockReturnValueOnce(held.promise);
    await boot();

    const first = send(message);
    await expect(send(message)).resolves.toEqual({ ok: true });
    expect(mockRunExtraction).toHaveBeenCalledTimes(1);

    held.resolve();
    await first;
  });

  it('still runs a DIFFERENT facet of the same link concurrently', async () => {
    const held = deferred();
    mockRunExtraction.mockReturnValueOnce(held.promise);
    await boot();

    const first = send(message);
    await send({ type: 'EXTRACT', linkId: 'link-1', facet: 'screenshot' });

    expect(mockRunExtraction).toHaveBeenCalledTimes(2);
    held.resolve();
    await first;
  });

  it('releases the mark when the capture finishes, so a retry can run', async () => {
    await boot();

    await send(message);
    await send(message);

    expect(mockRunExtraction).toHaveBeenCalledTimes(2);
  });

  it('releases the mark when the capture FAILS — otherwise the facet is stranded', async () => {
    await boot();
    mockRunExtraction.mockRejectedValueOnce(new Error('tab closed'));

    await send(message);
    await send(message);

    expect(mockRunExtraction).toHaveBeenCalledTimes(2);
  });
});
