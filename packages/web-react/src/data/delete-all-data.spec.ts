// Specs for the delete-all-data flow (Settings → Data → Delete). Four things here are
// invisible when they break, and all four are about ORDER or about the exact line
// between "your data" and "your account on this device":
//
//   1. The HOLD. The server call and the local wipe both run INSIDE `holdSyncCycles`, so
//      no cycle runs beside them: one that read the queue would push it past the wipe and
//      resurrect the very objects the user just deleted — and it would look like a
//      successful delete followed by a successful sync. (That the hold really keeps a
//      cycle waiting is the engine's spec; here it is that the work is inside it.)
//   2. NOTHING LOCAL IS LOST UNTIL THE SERVER CONFIRMS — or until it cannot say. The wipe
//      is idempotent, so a refused call has to leave a fully retryable device, the queue
//      included. Wiping first and then failing leaves the user signed in, looking at an
//      empty library, with their data still on the server and their device now unable to
//      say so. The one exception is the queue on a call that failed WITHOUT an answer: the
//      wipe may have run, and those ops would push into the emptied namespace.
//   3. The SURVIVOR SET — the identity/device stores (the session, the cached
//      subscription, the device-local settings) live through this, which is exactly what
//      separates it from clearData (clear-data.spec.ts, the same partition inverted).
//   4. WHOSE STORE IT IS BY THE TIME THE SERVER ANSWERS. The call can be out for minutes
//      and another tab can end the session under it. The tables have no owner column, so
//      the local half has to ask before it wipes, and must never be what puts a departed
//      account's ownership row back.
//
// The store reads are real (fake-indexeddb); only the two seams that leave the module —
// the sync engine and the api client — are stubbed, and the engine stub is what makes
// the hold's extent observable at all.

import {
  type ApiClient,
  ApiError,
  ApiTimeoutError,
  DATA_DELETE_ALL_ERROR,
  dataDeleteAllEndpoint,
  DeleteAllAccountChangedError,
  DeleteAllUncertainError,
  LINKS_PREFIX,
  pathFromId,
  untilAborted,
} from '@stxapps/shared';

import { clearData } from './clear-data';
import { db } from './db';
import { deleteAllData } from './delete-all-data';
import { putFavicon } from './favicon-store';
import { setLocalSettings } from './local-settings-store';
import { APP_LOCK_ID, putLock } from './lock-store';
import { enqueuePut, listPendingOps } from './pending-store';
import { readCachedStatus, writeCachedStatus } from './subscription-store';
import {
  beginInitialSync,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  seedNewAccount,
} from './sync-store';

// Every call the module makes, in the order it made them — the only way to see that the
// server was asked, and the local store wiped, while the hold was taken.
const calls: string[] = [];

type HoldOptions = { onWait?: () => void; signal?: AbortSignal };
type Hold = (
  username: string,
  work: () => Promise<unknown>,
  opts?: HoldOptions,
) => Promise<unknown>;

// The engine's hold, as a pass-through that records where it starts and ends.
const passThroughHold: Hold = async (_username, work) => {
  calls.push('hold');
  try {
    return await work();
  } finally {
    calls.push('release');
  }
};
const mockHoldSyncCycles = jest.fn<Promise<unknown>, Parameters<Hold>>(passThroughHold);
jest.mock('../sync/engine', () => ({
  holdSyncCycles: (...args: Parameters<Hold>) => mockHoldSyncCycles(...args),
}));

const USER = 'alice';
const NEXT_USER = 'bob';
const LINK_PATH = pathFromId('l_1', LINKS_PREFIX);
const NEXT_LINK_PATH = pathFromId('l_2', LINKS_PREFIX);

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
  await beginInitialSync(USER);
  await markFirstSyncDone(USER, 500, LINK_PATH);
  await enqueuePut(USER, LINK_PATH, 0);
  await putLock({ id: APP_LOCK_ID, kind: 'app', salt: 'aa', hash: 'bb' });
  await putFavicon(USER, 'example.com', new Uint8Array([1]));
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
  mockHoldSyncCycles.mockReset();
  mockHoldSyncCycles.mockImplementation(passThroughHold);
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
    await seedSignedInAccountWithData();
    const api = apiThat(async () => ({ deletedCount: 42 }));

    expect(await deleteAllData({ username: USER, api })).toEqual({ deletedCount: 42 });
  });

  // 0 is a real outcome (an account that never synced anything), not a failure to report.
  it('treats a zero-object wipe as a normal outcome', async () => {
    await seedNewAccount(USER);
    const api = apiThat(async () => ({ deletedCount: 0 }));

    expect(await deleteAllData({ username: USER, api })).toEqual({ deletedCount: 0 });
  });

  // THE HOLD'S EXTENT. The server call and the local wipe both run while this account's
  // cycles are held off, or a cycle beside them re-pushes ops the wipe just removed — a
  // successful-looking delete that silently resurrects data.
  it('asks the server, and wipes the store, while the sync cycles are held off', async () => {
    await seedSignedInAccountWithData();
    const api = apiThat(async () => {
      // The queue stays where it is: no cycle can see it while the hold is taken.
      expect(await listPendingOps(USER)).toHaveLength(1);
      return { deletedCount: 1 };
    });

    await deleteAllData({ username: USER, api });

    expect(calls).toEqual(['hold', 'deleteAll', 'release']);
    expect(mockHoldSyncCycles).toHaveBeenCalledWith(USER, expect.any(Function), {
      onWait: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  it('reports the safety wait separately from the server and local wipe', async () => {
    const steps: string[] = [];
    await seedNewAccount(USER);
    mockHoldSyncCycles.mockImplementation(async (_username, work, opts) => {
      opts?.onWait?.();
      return work();
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
    mockHoldSyncCycles.mockImplementation((_username, _work, opts) => {
      opts?.onWait?.();
      return untilAborted(new Promise<never>(() => undefined), opts?.signal);
    });
    const api = apiThat(async () => ({ deletedCount: 1 }));

    await expect(deleteAllData({ username: USER, api, syncWaitTimeoutMs: 1 })).rejects.toThrow(
      'Sync is taking longer than expected.',
    );

    expect(api.call).not.toHaveBeenCalled();
    expect(await listPendingOps(USER)).toHaveLength(1);
    expect(await db.items.count()).toBe(1);
  });

  // The watchdog bounds the WAIT. The call after it pages the whole namespace and has its
  // own, longer deadline; a watchdog still running over it would report a wipe that is
  // still going as a failure.
  it('stops the watchdog once the hold is taken', async () => {
    await seedSignedInAccountWithData();
    const api = apiThat(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { deletedCount: 1 };
    });

    await expect(deleteAllData({ username: USER, api, syncWaitTimeoutMs: 1 })).resolves.toEqual({
      deletedCount: 1,
    });
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

  // THE QUEUE: gone with a wipe that ran, kept through one that was refused, and dropped
  // when the call cannot say which. Kept after a refusal, so the failure line's "nothing
  // was removed" is true of the edits that had not synced yet; dropped after an unanswered
  // call, because the wipe may have run and those ops would push into the emptied
  // namespace — the user deleted everything, and they would come back.
  describe('the unsynced queue', () => {
    it('goes with the local wipe once the server confirms', async () => {
      await seedSignedInAccountWithData();

      await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

      expect(await listPendingOps(USER)).toEqual([]);
    });

    it('is only this account’s', async () => {
      await seedSignedInAccountWithData();
      await enqueuePut(NEXT_USER, NEXT_LINK_PATH, 0);

      await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

      expect(await listPendingOps(NEXT_USER)).toHaveLength(1);
    });

    it.each([
      ['refuses the name', DATA_DELETE_ALL_ERROR.accountMismatch],
      ['refuses for any other reason', 'something_else'],
    ])('stays, write for write, when the server %s', async (_, error) => {
      await seedSignedInAccountWithData();
      const before = await listPendingOps(USER);
      const api = apiThat(() => Promise.reject(new ApiError(409, JSON.stringify({ error }))));

      await deleteAllData({ username: USER, api }).catch(() => undefined);

      expect(await listPendingOps(USER)).toEqual(before);
    });

    it.each([
      ['the network fails', () => new Error('offline')],
      ['the deadline passes', () => new ApiTimeoutError(300_000)],
      ['the server errors', () => new ApiError(503, '')],
    ])('is dropped, and the failure says so, when %s', async (_, failure) => {
      await seedSignedInAccountWithData();
      const api = apiThat(() => Promise.reject(failure()));

      const err = await deleteAllData({ username: USER, api }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DeleteAllUncertainError);
      expect((err as Error).message).toBe(failure().message);
      expect(await listPendingOps(USER)).toEqual([]);
      // Only the queue: the library is still here, and so is everything else.
      expect(await db.items.count()).toBe(1);
      expect(await db.locks.count()).toBe(1);
    });

    // The call's failure is the one to report. A store error while dropping the queue must
    // not replace it — the user would read a storage fault as the reason the delete failed.
    it('reports the call’s failure even when dropping the queue fails', async () => {
      await seedSignedInAccountWithData();
      const where = jest.spyOn(db.pendingOps, 'where').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      try {
        const err = await deleteAllData({
          username: USER,
          api: apiThat(() => Promise.reject(new Error('offline'))),
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DeleteAllUncertainError);
        expect((err as Error).message).toBe('offline');
      } finally {
        where.mockRestore();
      }
    });
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

  // The request carries a NAME because the token cannot say whose data the user meant: the
  // client attaches whichever session is current as the request leaves, and this flow waits
  // on a sync before it sends. With the name in the body the server wipes only for the
  // account that asked (shared's data/endpoints.ts; the route's own spec pins the refusal).
  describe('the account the request names', () => {
    it('names the account the run was started for', async () => {
      await seedSignedInAccountWithData();
      const api = apiThat(async () => ({ deletedCount: 1 }));

      await deleteAllData({ username: USER, api });

      expect(api.call).toHaveBeenCalledWith(dataDeleteAllEndpoint, { username: USER });
    });

    // The account changed before the request left, so it went out under another account's
    // token and the server refused it. Nothing was wiped, on the server or here — which is a
    // different thing to tell the user than "the delete failed, try again".
    it('reports a refused name as an account change with nothing deleted', async () => {
      await seedSignedInAccountWithData();
      const api = apiThat(() =>
        Promise.reject(
          new ApiError(409, JSON.stringify({ error: DATA_DELETE_ALL_ERROR.accountMismatch })),
        ),
      );

      const err = await deleteAllData({ username: USER, api }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DeleteAllAccountChangedError);
      expect((err as DeleteAllAccountChangedError).serverWiped).toBe(false);
      expect(await db.items.toCollection().primaryKeys()).toEqual([LINK_PATH]);
      expect(await db.locks.count()).toBe(1);
      const meta = await getSyncMeta(USER);
      expect([meta?.syncCursorUpdatedAt, meta?.syncCursorPath]).toEqual([500, LINK_PATH]);
    });

    // The CODE decides, not the status: any other 409 is an ordinary failed call, which the
    // user may retry.
    it('leaves any other refusal an ordinary failure', async () => {
      await seedSignedInAccountWithData();
      const api = apiThat(() =>
        Promise.reject(new ApiError(409, JSON.stringify({ error: 'something_else' }))),
      );

      const err = await deleteAllData({ username: USER, api }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
    });
  });

  // THE ACCOUNT SWITCH UNDER THE SERVER CALL. Another tab signs out and someone else signs
  // in while this tab's request is still paging the namespace; then the answer arrives and
  // the local half runs in a store that is no longer this account's. Both things it used to
  // do there are silent. The wipe empties the NEXT account's library, locks and icons while
  // its cursor still says the store is complete. And the reset writes the previous account's
  // ownership row back beside the new one — the row every stale writer of that account is
  // fenced on, so each of them is let back in. The wipe and reset cases above are the
  // positive control: the same flow, with the account still there, does both.
  describe('when the account was switched while the server call was out', () => {
    const switchedUnderTheCall = (): ApiClient =>
      apiThat(async () => {
        // What the other tab's sign-out and sign-in leave behind, in its order: the
        // teardown, then the next account's claim and its first pulled rows.
        await clearData();
        await beginInitialSync(NEXT_USER);
        await markFirstSyncDone(NEXT_USER, 700, NEXT_LINK_PATH);
        await db.items.put({ path: NEXT_LINK_PATH, updatedAt: 2, itemType: 'link' });
        await putLock({ id: APP_LOCK_ID, kind: 'app', salt: 'cc', hash: 'dd' });
        await putFavicon(NEXT_USER, 'next.example', new Uint8Array([2]));
        return { deletedCount: 1 };
      });

    // And says which refusal it was: by now the server HAS wiped the account that asked, so
    // this is neither a finished delete nor a failed one, and the fence's own error (a sync
    // error) would read as the second.
    it('refuses the local half, as an account change after the server wipe', async () => {
      await seedSignedInAccountWithData();

      const err = await deleteAllData({ username: USER, api: switchedUnderTheCall() }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(DeleteAllAccountChangedError);
      expect((err as DeleteAllAccountChangedError).serverWiped).toBe(true);
    });

    it('does not put the departed account’s ownership row back', async () => {
      await seedSignedInAccountWithData();

      await deleteAllData({ username: USER, api: switchedUnderTheCall() }).catch(() => undefined);

      expect(await getSyncMeta(USER)).toBeUndefined();
      expect(await db.syncMeta.toCollection().primaryKeys()).toEqual([NEXT_USER]);
    });

    it('leaves the next account’s library, locks, icons and cursor as they were', async () => {
      await seedSignedInAccountWithData();

      await deleteAllData({ username: USER, api: switchedUnderTheCall() }).catch(() => undefined);

      expect(await db.items.toCollection().primaryKeys()).toEqual([NEXT_LINK_PATH]);
      expect(await db.locks.count()).toBe(1);
      expect(await db.favicons.toCollection().primaryKeys()).toEqual(['next.example']);
      const meta = await getSyncMeta(NEXT_USER);
      expect([meta?.syncCursorUpdatedAt, meta?.syncCursorPath]).toEqual([700, NEXT_LINK_PATH]);
    });

    // A sign-out with nobody signing in after it is the same question with one fewer row:
    // the store belongs to no one, and this flow must not be what claims it.
    it('claims nothing when the account only signed out', async () => {
      await seedSignedInAccountWithData();
      const api = apiThat(async () => {
        await clearData();
        return { deletedCount: 1 };
      });

      await expect(deleteAllData({ username: USER, api })).rejects.toBeInstanceOf(
        DeleteAllAccountChangedError,
      );

      expect(await db.syncMeta.count()).toBe(0);
    });
  });
});
