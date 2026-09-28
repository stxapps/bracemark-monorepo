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
// The survivor set is the interesting half here: the session, the cached subscription, the
// device settings AND the sidebar view all live through this, because it deletes the user's
// DATA, not their account or this device's preferences. clear-data.spec.ts asserts the same
// partition inverted.

import { sql } from 'drizzle-orm';

import {
  type ApiClient,
  dataDeleteAllEndpoint,
  LINKS_PREFIX,
  pathFromId,
  utf8,
} from '@stxapps/shared';

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
import { beginInitialSync, getSyncMeta, isFirstSyncDone, markFirstSyncDone } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

// Every call the module makes, in order — the only way to see that the quiesce and the
// queue abandonment happened BEFORE the server was asked.
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

const { resetFileSystem, listFileUris } = require('../testing/memory-file-system') as {
  resetFileSystem: () => void;
  listFileUris: () => string[];
};

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
  await putFavicon('example.com', new Uint8Array([1, 2, 3]));
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
});
