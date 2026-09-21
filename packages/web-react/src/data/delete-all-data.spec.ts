// Specs for the delete-all-data flow (Settings → Data → Delete). Three things here are
// invisible when they break, and all three are about ORDER or about the exact line
// between "your data" and "your account on this device":
//
//   1. The QUIESCE. `awaitInflightSync` then `clearPendingOps`, both BEFORE the server
//      call. A cycle already in flight read the queue before we got here, so pushing on
//      after the wipe would resurrect the very objects the user just deleted — and it
//      would look like a successful delete followed by a successful sync.
//   2. NOTHING LOCAL IS TOUCHED UNTIL THE SERVER CONFIRMS. The wipe is idempotent, so a
//      failed call has to leave a fully retryable device. Wiping first and then failing
//      leaves the user signed in, looking at an empty library, with their data still on
//      the server and their device now unable to say so.
//   3. The SURVIVOR SET — the identity/device stores (the session, the cached
//      subscription, the device-local settings) live through this, which is exactly what
//      separates it from clearData (clear-data.spec.ts, the same partition inverted).
//
// The store reads are real (fake-indexeddb); only the two seams that leave the module —
// the sync engine and the api client — are stubbed, and the engine stub is what makes
// the quiesce ordering observable at all.

import { type ApiClient, dataDeleteAllEndpoint, LINKS_PREFIX, pathFromId } from '@stxapps/shared';

import { db } from './db';
import { deleteAllData } from './delete-all-data';
import { putFavicon } from './favicon-store';
import { setLocalSettings } from './local-settings-store';
import { APP_LOCK_ID, putLock } from './lock-store';
import { enqueuePut, listPendingOps } from './pending-store';
import { readCachedStatus, writeCachedStatus } from './subscription-store';
import { getSyncMeta, isFirstSyncDone, markFirstSyncDone } from './sync-store';

// Every call the module makes, in the order it made them — the only way to see that the
// quiesce and the queue abandonment happened BEFORE the server was asked.
const calls: string[] = [];

const mockAwaitInflightSync = jest.fn(
  async (_username: string, _onWait?: () => void): Promise<void> => {
    void _username;
    void _onWait;
    calls.push('awaitInflightSync');
  },
);
jest.mock('../sync/engine', () => ({
  awaitInflightSync: (username: string, onWait?: () => void) =>
    mockAwaitInflightSync(username, onWait),
}));

const USER = 'alice';
const LINK_PATH = pathFromId('l_1', LINKS_PREFIX);

function apiThat(answer: () => Promise<{ deletedCount: number }>): ApiClient {
  return {
    call: jest.fn((endpoint: unknown) => {
      calls.push(endpoint === dataDeleteAllEndpoint ? 'deleteAll' : 'other');
      return answer();
    }),
  } as unknown as ApiClient;
}

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

async function seedSignedInAccountWithData(): Promise<void> {
  await db.items.put({ path: LINK_PATH, updatedAt: 1, itemType: 'link' });
  await markFirstSyncDone(USER, 500, LINK_PATH);
  await enqueuePut(USER, LINK_PATH, 0);
  await putLock({ id: APP_LOCK_ID, kind: 'app', salt: 'aa', hash: 'bb' });
  await putFavicon('example.com', new Uint8Array([1]));
  await setLocalSettings({ linksLayoutSource: 'local', linksLayout: 'card' });
  writeCachedStatus({
    plan: 'plus',
    status: 'active',
    source: 'paddle',
    expiresAt: 1_700_000_000_000,
    willRenew: true,
  });
}

beforeEach(async () => {
  calls.length = 0;
  mockAwaitInflightSync.mockReset();
  mockAwaitInflightSync.mockImplementation(
    async (_username: string, _onWait?: () => void): Promise<void> => {
      void _username;
      void _onWait;
      calls.push('awaitInflightSync');
    },
  );
  installStorage();
  await Promise.all([
    db.items.clear(),
    db.syncMeta.clear(),
    db.pendingOps.clear(),
    db.localSettings.clear(),
    db.locks.clear(),
    db.favicons.clear(),
  ]);
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
});

describe('deleteAllData', () => {
  it('reports the server’s receipt', async () => {
    const api = apiThat(async () => ({ deletedCount: 42 }));

    expect(await deleteAllData({ username: USER, api })).toEqual({ deletedCount: 42 });
  });

  // 0 is a real outcome (an account that never synced anything), not a failure to report.
  it('treats a zero-object wipe as a normal outcome', async () => {
    const api = apiThat(async () => ({ deletedCount: 0 }));

    expect(await deleteAllData({ username: USER, api })).toEqual({ deletedCount: 0 });
  });

  // THE QUIESCE ORDER. Both must precede the server call, or an in-flight cycle re-pushes
  // ops the wipe just removed — a successful-looking delete that silently resurrects data.
  it('waits out the in-flight cycle and abandons the queue BEFORE calling the server', async () => {
    await seedSignedInAccountWithData();
    mockAwaitInflightSync.mockImplementation(async () => {
      calls.push('awaitInflightSync');
      // The queue is still intact while a cycle could be reading it.
      expect(await listPendingOps(USER)).toHaveLength(1);
    });

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(calls).toEqual(['awaitInflightSync', 'deleteAll']);
    expect(await listPendingOps(USER)).toEqual([]);
    expect(mockAwaitInflightSync).toHaveBeenCalledWith(USER, expect.any(Function));
  });

  it('reports the safety wait separately from the server and local wipe', async () => {
    const steps: string[] = [];
    mockAwaitInflightSync.mockImplementation(async (_username, onWait) => {
      onWait?.();
    });

    await deleteAllData({
      username: USER,
      api: apiThat(async () => ({ deletedCount: 1 })),
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual(['waiting-for-sync', 'deleting']);
  });

  it('fails closed when the in-flight cycle does not settle', async () => {
    await seedSignedInAccountWithData();
    mockAwaitInflightSync.mockImplementation(
      async (_username, onWait) =>
        new Promise<void>(() => {
          onWait?.();
        }),
    );
    const api = apiThat(async () => ({ deletedCount: 1 }));

    await expect(
      deleteAllData({ username: USER, api, syncWaitTimeoutMs: 1 }),
    ).rejects.toThrow('Sync is taking longer than expected.');

    expect(api.call).not.toHaveBeenCalled();
    expect(await listPendingOps(USER)).toHaveLength(1);
    expect(await db.items.count()).toBe(1);
  });

  // The server wipe is idempotent, so a failure has to leave a device that can simply try
  // again. The local store must still hold the library — an emptied device with a full
  // server is the one state the user can't recover from in the UI.
  it('leaves the local library intact when the server call fails', async () => {
    await seedSignedInAccountWithData();
    const api = apiThat(() => Promise.reject(new Error('offline')));

    await expect(deleteAllData({ username: USER, api })).rejects.toThrow('offline');

    expect(await db.items.count()).toBe(1);
    expect(await db.locks.count()).toBe(1);
    expect(await db.favicons.count()).toBe(1);
  });

  it('wipes the synced local state once the server confirms', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(await db.items.count()).toBe(0);
    // The locks guarded lists that no longer exist; the favicon cache is derived FROM the
    // wiped links, so leaving it would let the deleted library's hosts be read back off
    // the device.
    expect(await db.locks.count()).toBe(0);
    expect(await db.favicons.count()).toBe(0);
  });

  // THE LINE THIS FLOW DRAWS, and the inverse of clear-data.spec.ts's partition: this
  // deletes the user's data, not their account and not this device's preferences.
  it('keeps the device and identity stores clearData would have wiped', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(await db.localSettings.count()).toBe(1);
    expect((await db.localSettings.toArray())[0]).toMatchObject({ linksLayout: 'card' });
    expect(readCachedStatus()?.plan).toBe('plus');
  });

  // An empty local store IS the complete snapshot of the wiped namespace, so the
  // bookkeeping resets to the seeded-new-account state rather than to "never synced".
  // Anything else costs the next cycle a full re-download of an empty namespace — or,
  // with firstSyncDoneAt cleared, re-blocks the UI on a first sync that has nothing to do.
  it('resets the sync bookkeeping to the seeded-new-account state', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    const meta = await getSyncMeta(USER);
    expect(await isFirstSyncDone(USER)).toBe(true);
    expect([meta?.syncCursorUpdatedAt, meta?.syncCursorPath]).toEqual([0, '']);
  });
});
