// Specs for the expo delete-all-data flow. Same three invisible rules as web's sibling —
// the QUIESCE before the server call, NOTHING LOCAL TOUCHED until the server confirms, and
// the SURVIVOR SET that separates this from the sign-out teardown — but the two modules are
// duplicated source over different stores, so web's spec proves nothing about this one.
//
// The platform adds a fourth thing to get right, and it is the one an assertion written
// only over the database would miss entirely: the decrypted `files/` blobs and the cached
// icon FILES live outside sqlite, so a wipe that clears the tables and stops leaves the
// deleted library's preview images on disk — plaintext, with no rows pointing at them, on a
// device the user believes they have just emptied.
//
// And a fifth, web's fourth: WHOSE STORE IT IS BY THE TIME THE SERVER ANSWERS. The call can
// be out for minutes and the session can end under it. Neither the tables nor the files have
// an owner, so the local half has to ask before it wipes, and must never be what puts a
// departed account's ownership row back.
//
// The survivor set is the interesting half here: the session, the cached subscription, the
// device settings AND the sidebar view all live through this, because it deletes the user's
// DATA, not their account or this device's preferences. clear-data.spec.ts asserts the same
// partition inverted.

import { sql } from 'drizzle-orm';

import {
  type ApiClient,
  ApiError,
  DATA_DELETE_ALL_ERROR,
  dataDeleteAllEndpoint,
  DeleteAllAccountChangedError,
  LINKS_PREFIX,
  pathFromId,
  utf8,
} from '@stxapps/shared';

import { clearData } from './clear-data';
import { getDb } from './db';
import { deleteAllData } from './delete-all-data';
import { faviconFileFor, putFavicon } from './favicon-store';
import { dataFileFor, ensureDataFilesDir } from './file-store';
import { putItemsTx } from './item-store';
import { getLocalSettings, setLocalSettings } from './local-settings-store';
import { putLock } from './lock-store';
import { enqueuePutTx, listPendingOps } from './pending-store';
import { toItemRecord } from './projection';
import { readReviewPromptState, writeReviewPromptState } from './review-prompt-store';
import { readSidebarCollapsedIds, writeSidebarCollapsedIds } from './sidebar-view-store';
import { readCachedStatus, writeCachedStatus } from './subscription-store';
import {
  beginInitialSync,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  seedNewAccount,
} from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

// Every call the module makes, in order — the only way to see that the quiesce and the
// queue take happened BEFORE the server was asked.
const calls: string[] = [];
const mockInvalidateLiveReads = jest.fn();
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
jest.mock('./live-read-invalidation', () => ({
  invalidateLiveReads: (tables: readonly string[]) => mockInvalidateLiveReads(tables),
}));
// The teardown's native half (the App Group artifacts): the account-switch cases below run
// the real clearData, and this is the one member of it with no stand-in under jest.
jest.mock('./share-store', () => ({ clearShareData: () => undefined }));

const { resetFileSystem, listFileUris } = require('../testing/memory-file-system') as {
  resetFileSystem: () => void;
  listFileUris: () => string[];
};

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

async function seedSignedInAccountWithData(): Promise<void> {
  getDb().transaction((tx) => {
    putItemsTx(tx, [
      toItemRecord(
        LINK_PATH,
        1,
        utf8(
          JSON.stringify({
            url: 'https://example.com/a',
            listId: 'my-list',
            tagIds: ['t_1'],
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
      ),
    ]);
    enqueuePutTx(tx, USER, LINK_PATH, 0);
  });
  await beginInitialSync(USER);
  await markFirstSyncDone(USER, 500, LINK_PATH);
  await putLock({ id: 'app', kind: 'app', salt: 'aa', hash: 'bb' });
  await putFavicon(USER, 'example.com', new Uint8Array([1, 2, 3]));
  await setLocalSettings({ linksLayoutSource: 'local', linksLayout: 'card' });
  writeSidebarCollapsedIds(['lists']);
  writeReviewPromptState({
    savesSinceAsk: 3,
    lastAskedAt: null,
    askCount: 0,
    openedStorePage: false,
  });
  writeCachedStatus({
    plan: 'plus',
    status: 'active',
    source: 'paddle',
    expiresAt: 1_700_000_000_000,
    willRenew: true,
  });
  ensureDataFilesDir();
  dataFileFor('files/f_1.enc').write('decrypted preview bytes');
}

const countOf = (table: string): number =>
  getDb().get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM "${table}"`))?.n ?? 0;

beforeEach(() => {
  calls.length = 0;
  mockInvalidateLiveReads.mockClear();
  mockAwaitInflightSync.mockReset();
  mockAwaitInflightSync.mockImplementation(
    async (_username: string, _onWait?: () => void): Promise<void> => {
      void _username;
      void _onWait;
      calls.push('awaitInflightSync');
    },
  );
  resetFileSystem();
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
});

describe('deleteAllData', () => {
  it('reports the server’s receipt, zero included', async () => {
    await seedNewAccount(USER);
    expect(
      await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 42 })) }),
    ).toEqual({ deletedCount: 42 });
    expect(
      await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 0 })) }),
    ).toEqual({ deletedCount: 0 });
  });

  // THE QUIESCE ORDER. Both must precede the server call, or a cycle already holding the
  // queue re-pushes ops the wipe just removed — a successful-looking delete that silently
  // resurrects the library on the next sync.
  it('waits out the in-flight cycle and takes the queue out BEFORE calling the server', async () => {
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
    await seedNewAccount(USER);
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

    await expect(deleteAllData({ username: USER, api, syncWaitTimeoutMs: 1 })).rejects.toThrow(
      'Sync is taking longer than expected.',
    );

    expect(api.call).not.toHaveBeenCalled();
    expect(await listPendingOps(USER)).toHaveLength(1);
    expect(countOf('items')).toBe(1);
  });

  // The server wipe is idempotent, so a failure has to leave a device that can simply try
  // again. An emptied device with a full server is the one state the UI can't recover from.
  it('leaves the local library intact when the server call fails', async () => {
    await seedSignedInAccountWithData();

    await expect(
      deleteAllData({ username: USER, api: apiThat(() => Promise.reject(new Error('offline'))) }),
    ).rejects.toThrow('offline');

    expect(countOf('items')).toBe(1);
    expect(countOf('locks')).toBe(1);
    expect(listFileUris().length).toBeGreaterThan(0);
  });

  // THE QUEUE IS OUT WHILE THE WIPE IS, AND BACK IF IT FAILS (web's sibling): out, so a
  // cycle starting during the call has nothing to push past the wipe; back, so "nothing was
  // removed" is true of the edits that had not synced yet.
  describe('the unsynced queue', () => {
    const refusedName = (): ApiClient =>
      apiThat(() =>
        Promise.reject(
          new ApiError(409, JSON.stringify({ error: DATA_DELETE_ALL_ERROR.accountMismatch })),
        ),
      );

    it('is empty while the server call is out', async () => {
      await seedSignedInAccountWithData();
      let duringCall: unknown[] | undefined;
      const api = apiThat(async () => {
        duringCall = await listPendingOps(USER);
        return { deletedCount: 1 };
      });

      await deleteAllData({ username: USER, api });

      expect(duringCall).toEqual([]);
    });

    it('comes back, write for write, when the server call fails', async () => {
      await seedSignedInAccountWithData();
      const before = await listPendingOps(USER);

      await deleteAllData({
        username: USER,
        api: apiThat(() => Promise.reject(new Error('offline'))),
      }).catch(() => undefined);

      expect(await listPendingOps(USER)).toEqual(before);
    });

    it('comes back when the server refuses the name', async () => {
      await seedSignedInAccountWithData();
      const before = await listPendingOps(USER);

      await deleteAllData({ username: USER, api: refusedName() }).catch(() => undefined);

      expect(await listPendingOps(USER)).toEqual(before);
    });

    it('keeps an edit made during the call over the row it took', async () => {
      await seedSignedInAccountWithData();
      const [taken] = await listPendingOps(USER);
      const api = apiThat(async () => {
        getDb().transaction((tx) => enqueuePutTx(tx, USER, LINK_PATH, 1));
        throw new Error('offline');
      });

      await deleteAllData({ username: USER, api }).catch(() => undefined);

      const [kept] = await listPendingOps(USER);
      expect(kept.writeId).not.toBe(taken.writeId);
      expect(kept.baseUpdatedAt).toBe(1);
    });

    it('stays gone when the account was torn down under the call', async () => {
      await seedSignedInAccountWithData();
      const api = apiThat(async () => {
        await clearData();
        throw new ApiError(409, JSON.stringify({ error: DATA_DELETE_ALL_ERROR.accountMismatch }));
      });

      await deleteAllData({ username: USER, api }).catch(() => undefined);

      expect(countOf('pending_ops')).toBe(0);
    });
  });

  it('wipes the synced local state once the server confirms', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(countOf('items')).toBe(0);
    // The junction rows go with the items they describe — orphans there would filter the
    // next library's reads by the deleted one's tag memberships.
    expect(countOf('item_tag_ids')).toBe(0);
    // The locks guarded lists that no longer exist; the favicon cache is derived FROM the
    // wiped links, so leaving it would let the deleted library's hosts be read off the
    // device.
    expect(countOf('locks')).toBe(0);
    expect(countOf('favicons')).toBe(0);
  });

  // SQLite's truncate optimization makes bare whole-table deletes invisible to
  // expo-sqlite's update hook. The wipe must explicitly wake every live reader
  // whose table it clears, or mounted links/sidebar/lock/favicon views stay stale.
  it('invalidates every live-read table cleared by the optimized wipe', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(mockInvalidateLiveReads).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLiveReads).toHaveBeenCalledWith([
      'items',
      'item_tag_ids',
      'item_facet_statuses',
      'locks',
      'favicons',
    ]);
  });

  // THE MEMBER NO DATABASE ASSERTION SEES. The decrypted preview images and the cached icon
  // files live outside sqlite — a table-only wipe leaves the deleted library's plaintext on
  // a device the user believes they have emptied.
  it('reaches the decrypted blobs and icon files on disk', async () => {
    await seedSignedInAccountWithData();
    expect(faviconFileFor('example.com').exists).toBe(true);

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(listFileUris()).toEqual([]);
  });

  // THE LINE THIS FLOW DRAWS, and the inverse of clear-data.spec.ts's partition: this
  // deletes the user's data, not their account and not this device's preferences.
  it('keeps the device and identity stores clearData would have wiped', async () => {
    await seedSignedInAccountWithData();

    await deleteAllData({ username: USER, api: apiThat(async () => ({ deletedCount: 1 })) });

    expect(await getLocalSettings()).toMatchObject({ linksLayout: 'card' });
    expect(readCachedStatus()?.plan).toBe('plus');
    expect(readSidebarCollapsedIds()).toEqual(['lists']);
    expect(readReviewPromptState().savesSinceAsk).toBe(3);
  });

  // An empty local store IS the complete snapshot of the wiped namespace, so the
  // bookkeeping resets to the seeded-new-account state. Anything else costs the next cycle
  // a full re-download of an empty namespace — or, with the flag cleared, re-blocks the UI
  // on a first sync that has nothing to do.
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
      expect(countOf('items')).toBe(1);
      expect(countOf('locks')).toBe(1);
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

  // THE ACCOUNT SWITCH UNDER THE SERVER CALL — web's sibling carries the case. The session
  // ends while the request is still paging the namespace and someone else signs in; then the
  // answer arrives and the local half runs in a store that is no longer this account's. Run
  // blind it empties the NEXT account's library while that account's cursor still says the
  // store is complete, sweeps its files, and writes the previous account's ownership row
  // back beside the new one — the row every stale writer of that account is fenced on. The
  // wipe, file and reset cases above are the positive control: the same flow, with the
  // account still there, does all three.
  describe('when the account was switched while the server call was out', () => {
    const switchedUnderTheCall = (): ApiClient =>
      apiThat(async () => {
        // What a sign-out and the next sign-in leave behind, in their order: the teardown,
        // then the next account's claim, its first pulled row and what this device made
        // of it.
        await clearData();
        await beginInitialSync(NEXT_USER);
        await markFirstSyncDone(NEXT_USER, 700, NEXT_LINK_PATH);
        getDb().transaction((tx) => {
          putItemsTx(tx, [
            toItemRecord(
              NEXT_LINK_PATH,
              2,
              utf8(
                JSON.stringify({
                  url: 'https://next.example/a',
                  listId: 'my-list',
                  tagIds: ['t_2'],
                  createdAt: 2,
                  updatedAt: 2,
                }),
              ),
            ),
          ]);
        });
        await putLock({ id: 'app', kind: 'app', salt: 'cc', hash: 'dd' });
        await putFavicon(NEXT_USER, 'next.example', new Uint8Array([4, 5, 6]));
        ensureDataFilesDir();
        dataFileFor('files/f_2.enc').write('the next account’s preview bytes');
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
      expect(countOf('sync_meta')).toBe(1);
    });

    it('leaves the next account’s rows, files and cursor as they were', async () => {
      await seedSignedInAccountWithData();

      await deleteAllData({ username: USER, api: switchedUnderTheCall() }).catch(() => undefined);

      expect(countOf('items')).toBe(1);
      expect(countOf('item_tag_ids')).toBe(1);
      expect(countOf('locks')).toBe(1);
      expect(countOf('favicons')).toBe(1);
      // The file sweeps are no more account-scoped than the tables.
      expect(dataFileFor('files/f_2.enc').exists).toBe(true);
      expect(faviconFileFor('next.example').exists).toBe(true);
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

      expect(countOf('sync_meta')).toBe(0);
    });
  });
});
