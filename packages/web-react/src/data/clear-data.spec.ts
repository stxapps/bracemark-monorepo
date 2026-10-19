// Specs for the sign-out teardown. `clearData` is the one operation that deliberately
// reaches across every device-local store, and its correctness is a SET question — which
// stores it names — not a behavioural one. Nothing catches a missing member: the sign-out
// succeeds, the app looks empty, and the leftover store is only discovered when the next
// account on this device inherits it. The local store holds DECRYPTED bookmarks, so a
// missed `items` clear is a second user reading the first's plaintext.
//
// So this spec seeds EVERY store the module could plausibly own, wipes, and asserts the
// full partition — including the stores that must SURVIVE nothing here (there are none;
// clearData is the total wipe). The complement is delete-all-data.spec.ts, which pins the
// opposite treatment of the identity/device stores while staying signed in. The two files
// together are the "keep the two aligned when adding a store here" note made checkable:
// add a store to one and its counterpart's partition assertion is what asks about the other.

import { DEFAULT_THEME, LINKS_PREFIX, pathFromId } from '@stxapps/shared';

import { clearData } from './clear-data';
import { db } from './db';
import { putFavicon } from './favicon-store';
import { setLocalSettings } from './local-settings-store';
import { APP_LOCK_ID, putLock } from './lock-store';
import { enqueuePut } from './pending-store';
import {
  getSidebarRail,
  readSidebarCollapsedIds,
  writeSidebarCollapsedIds,
  writeSidebarRail,
} from './sidebar-view-store';
import { readCachedStatus, writeCachedStatus } from './subscription-store';
import { seedNewAccount } from './sync-store';

const USER = 'alice';
const LINK_PATH = pathFromId('l_1', LINKS_PREFIX);

// The two non-Dexie stores in the teardown are localStorage-backed, and this package's
// jest environment is 'node' — without a stand-in they would be silently inert here, and
// the assertions about them would pass against a `clearData` that never touched them.
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

// Everything a signed-in account has on this device, in every store clearData names.
async function seedEverything(): Promise<void> {
  await db.items.put({ path: LINK_PATH, updatedAt: 1, itemType: 'link' });
  await seedNewAccount(USER);
  await enqueuePut(USER, LINK_PATH, 0);
  await setLocalSettings({ themeSource: 'local', theme: DEFAULT_THEME });
  await putLock({ id: APP_LOCK_ID, kind: 'app', salt: 'aa', hash: 'bb' });
  await putFavicon(USER, 'example.com', new Uint8Array([1]));
  writeSidebarCollapsedIds(['lists']);
  writeSidebarRail({ collapsed: true, width: 320 });
  writeCachedStatus({
    plan: 'plus',
    status: 'active',
    source: 'paddle',
    expiresAt: 1_700_000_000_000,
    willRenew: true,
  });
}

// What is left on this device, store by store. Written as one snapshot so a store that
// stops being wiped shows up as a diff rather than as an absent assertion.
async function remaining(): Promise<Record<string, number>> {
  return {
    items: await db.items.count(),
    syncMeta: await db.syncMeta.count(),
    pendingOps: await db.pendingOps.count(),
    localSettings: await db.localSettings.count(),
    locks: await db.locks.count(),
    favicons: await db.favicons.count(),
    sidebarCollapsedIds: readSidebarCollapsedIds().length,
    sidebarRail: getSidebarRail().collapsed || getSidebarRail().width !== null ? 1 : 0,
    cachedSubscription: readCachedStatus() === null ? 0 : 1,
  };
}

beforeEach(async () => {
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

describe('clearData', () => {
  it('rolls back the table wipe if the ownership row cannot be cleared', async () => {
    await seedEverything();
    const before = await remaining();
    const clear = jest
      .spyOn(db.syncMeta, 'clear')
      .mockRejectedValueOnce(new Error('storage failed'));
    try {
      await expect(clearData()).rejects.toThrow('storage failed');
      expect(await remaining()).toEqual(before);
    } finally {
      clear.mockRestore();
    }
  });

  // The seed itself is an assertion: if a store stopped accepting the write below, the
  // wipe assertion after it would pass vacuously.
  it('leaves nothing behind in any device-local store', async () => {
    await seedEverything();
    expect(Object.values(await remaining()).every((n) => n > 0)).toBe(true);

    await clearData();

    expect(await remaining()).toEqual({
      items: 0,
      syncMeta: 0,
      pendingOps: 0,
      localSettings: 0,
      locks: 0,
      favicons: 0,
      sidebarCollapsedIds: 0,
      sidebarRail: 0,
      cachedSubscription: 0,
    });
  });

  // Deliberately NOT account-scoped (clear-data.ts): `items` carries no owner column, so
  // a scoped clear would leave the previous account's plaintext behind — which is the
  // exact thing the sign-out teardown exists to prevent.
  it('wipes the queue for every account on the device, not just the signed-in one', async () => {
    await enqueuePut(USER, LINK_PATH, 0);
    await enqueuePut('bob', LINK_PATH, 0);

    await clearData();

    expect(await db.pendingOps.count()).toBe(0);
  });

  // The sign-out teardown runs on paths where there may be nothing to tear down (a
  // signed-out resolution guard, a second sign-out from a concurrent 401).
  it('is safe to run against an empty device', async () => {
    await expect(clearData()).resolves.toBeUndefined();
  });
});
