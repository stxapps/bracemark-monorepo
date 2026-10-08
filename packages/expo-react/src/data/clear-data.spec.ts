// Specs for the expo sign-out teardown. Like web's, correctness here is a SET question —
// which stores it names — and nothing catches a missing member: the sign-out succeeds, the
// app looks empty, and the leftover store is discovered only when the next account on this
// device inherits it. The local store holds DECRYPTED bookmarks, so a missed member is a
// second user reading the first's plaintext.
//
// This platform adds FOUR members web has no equivalent of, and each is a different
// medium that the one sqlite transaction cannot reach:
//   - the on-disk plaintext `files/` blobs (file-store),
//   - the cached icon FILES (favicon-store's split storage — the table delete only removes
//     the verdicts),
//   - the share sheet's App Group artifacts, which name the account's lists and tags and
//     may hold undrained URLs.
//   - the plaintext parked in the OS cache dir (cache-files.ts) — an export above all,
//     which is the whole library in one file.
// A wipe that clears the tables and stops leaves decrypted bookmark images on disk with no
// rows pointing at them — invisible to the app, and to any assertion written only over the
// database. (What it leaves in the database FILE is clear-data.residue.spec.ts.)
//
// So the spec seeds every store and asserts the full partition, tables AND files. Its
// complement is delete-all-data.spec.ts, which pins the opposite treatment of the
// identity/device stores; together they make the "keep the two aligned" note checkable.

import { sql } from 'drizzle-orm';

import { EXTRACTIONS_PREFIX, LINKS_PREFIX, newFacet, pathFromId, utf8 } from '@stxapps/shared';

import { newExportFile } from './cache-files';
import { clearData } from './clear-data';
import { getDb } from './db';
import { putFavicon } from './favicon-store';
import { dataFileFor, ensureDataFilesDir } from './file-store';
import { putItemsTx } from './item-store';
import { subscribeToLiveReadInvalidations } from './live-read-invalidation';
import { setLocalSettings } from './local-settings-store';
import { putLock } from './lock-store';
import { enqueuePutTx } from './pending-store';
import { toItemRecord } from './projection';
import { writeReviewPromptState } from './review-prompt-store';
import { writeSidebarCollapsedIds } from './sidebar-view-store';
import { readCachedStatus, writeCachedStatus } from './subscription-store';
import { seedNewAccount } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

// The share sheet's App Group artifacts live behind a native container lookup; the wipe's
// contract with them is only that it CALLS for them, so the module is stubbed and the call
// asserted. (share-store.spec.ts owns what clearShareData actually removes.)
const mockClearShareData = jest.fn();
jest.mock('./share-store', () => ({ clearShareData: () => mockClearShareData() }));

const { resetFileSystem, listFileUris } = require('../testing/memory-file-system') as {
  resetFileSystem: () => void;
  listFileUris: () => string[];
};

const USER = 'alice';
const LINK_PATH = pathFromId('l_1', LINKS_PREFIX);

async function seedEverything(): Promise<void> {
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
    // An extraction too, so the FACET junction is non-empty — the seed has to fill every
    // table the assertion below reads, or a table that stopped being wiped would pass
    // vacuously.
    putItemsTx(tx, [
      toItemRecord(
        pathFromId('l_1', EXTRACTIONS_PREFIX),
        1,
        utf8(
          JSON.stringify({
            id: 'l_1',
            facets: { titleImage: newFacet('done', 'expo:fg') },
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
      ),
    ]);
    enqueuePutTx(tx, USER, LINK_PATH, 0);
  });
  await seedNewAccount(USER);
  await setLocalSettings({ themeSource: 'local' });
  await putLock({ id: 'app', kind: 'app', salt: 'aa', hash: 'bb' });
  await putFavicon(USER, 'example.com', new Uint8Array([1, 2, 3]));
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
  // A decrypted `files/` blob on disk — the member no database assertion can see.
  ensureDataFilesDir();
  dataFileFor('files/f_1.enc').write('decrypted preview bytes');
  // And the cache dir, which is not even under the app's own directories: an export of
  // the whole library, waiting there for a share sheet that closed long ago.
  newExportFile('Bracemark backup 2026-01-01.zip').write('the whole library');
}

// What is left on this device, table by table plus the filesystem. One snapshot, so a
// store that stops being wiped shows up as a diff rather than as an absent assertion.
function remaining(): Record<string, number> {
  const count = (table: string): number =>
    getDb().get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM "${table}"`))?.n ?? 0;
  return {
    items: count('items'),
    itemTagIds: count('item_tag_ids'),
    itemFacetStatuses: count('item_facet_statuses'),
    syncMeta: count('sync_meta'),
    pendingOps: count('pending_ops'),
    localSettings: count('local_settings'),
    locks: count('locks'),
    favicons: count('favicons'),
    sidebarView: count('sidebar_view'),
    reviewPrompt: count('review_prompt'),
    subscriptionStatus: count('subscription_status'),
    filesOnDisk: listFileUris().length,
  };
}

beforeEach(() => {
  mockClearShareData.mockClear();
  resetFileSystem();
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
});

describe('clearData', () => {
  // The seed is itself an assertion: if a store stopped accepting its write, the wipe
  // assertion after it would pass vacuously.
  it('leaves nothing behind, in any table or on disk', async () => {
    await seedEverything();
    expect(Object.entries(remaining()).filter(([, n]) => n === 0)).toEqual([]);

    await clearData();

    expect(remaining()).toEqual({
      items: 0,
      itemTagIds: 0,
      itemFacetStatuses: 0,
      syncMeta: 0,
      pendingOps: 0,
      localSettings: 0,
      locks: 0,
      favicons: 0,
      sidebarView: 0,
      reviewPrompt: 0,
      subscriptionStatus: 0,
      filesOnDisk: 0,
    });
  });

  // The junction tables are the platform's transposed index. Clearing `items` alone leaves
  // rows in them pointing at paths that no longer exist — and every link query JOINs
  // against those, so the next account's reads would be filtered by the previous account's
  // tag memberships.
  it('clears the junction tables with the rows they describe', async () => {
    await seedEverything();

    await clearData();

    expect(remaining().itemTagIds).toBe(0);
  });

  // The non-sqlite members, each a different medium the transaction cannot reach.
  it('reaches the plaintext blobs, the icon files, the cache dir and the share artifacts', async () => {
    await seedEverything();

    await clearData();

    expect(listFileUris()).toEqual([]);
    expect(mockClearShareData).toHaveBeenCalledTimes(1);
  });

  // Deliberately not account-scoped: `items` carries no owner column, so a scoped clear
  // would leave the previous account's plaintext behind.
  it('wipes the queue for every account on the device', async () => {
    getDb().transaction((tx) => {
      enqueuePutTx(tx, USER, LINK_PATH, 0);
      enqueuePutTx(tx, 'bob', LINK_PATH, 0);
    });

    await clearData();

    expect(remaining().pendingOps).toBe(0);
  });

  // Runs on paths where there may be nothing to tear down — a signed-out resolution guard,
  // a second sign-out from a concurrent 401. The file-system half is the fragile one: the
  // native delete throws on a directory that was never created.
  it('is safe to run against an untouched device', async () => {
    await expect(clearData()).resolves.toBeUndefined();
  });

  // The wipe is bare whole-table deletes, which SQLite truncates without firing the update
  // hook behind useLiveRead — so a reader that stays mounted across sign-out hears nothing
  // unless clearData says so itself. The root ThemeProvider is that reader: without this
  // it kept the signed-out account's theme over the landing until a relaunch. Asserted
  // against the schema rather than a typed-out list, so a table added to the wipe (and to
  // `remaining()` above) cannot be left out of the invalidation.
  it('tells live reads about every table it emptied', async () => {
    await seedEverything();
    const invalidated: string[] = [];
    const unsubscribe = subscribeToLiveReadInvalidations((tables) => invalidated.push(...tables));

    await clearData();
    unsubscribe();

    const tables = getDb()
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .map(({ name }) => name);
    expect(invalidated.sort()).toEqual(tables.sort());
  });

  // The device's cached plan must not outlive the account — an unlocked paywall for
  // whoever signs in next.
  it('drops the cached subscription', async () => {
    await seedEverything();

    await clearData();

    expect(readCachedStatus()).toBeNull();
  });
});
