// Specs for the expo favicon cache — the sibling that DIVERGES from web's most, and in the
// two places where the divergence is invisible.
//
// 1. TWO FILLERS, one store. web's provider is the only writer; here the `/favicon.ico`
//    guess (favicon-provider) and device-extraction's declared-icon CAPTURE both write,
//    and neither knows about the other. Both are check-then-act with an await gap, so a
//    guess that STARTED before a capture can FINISH after it — and without the guard in
//    `putFaviconNone` it deletes the captured bytes and stamps `none`, which
//    `isFaviconStale` then honours for a week. The rule that makes two unsynchronized
//    fillers safe is `ok` WINS, `none` is only ever the floor.
//
// 2. SPLIT STORAGE. The verdict is a sqlite row; an `ok` icon's bytes are a file on disk.
//    So the pair can disagree, and `readFavicon` resolves that ONE way: an `ok` row whose
//    file is missing reads as UNRESOLVED. Skip that check and the render path is handed a
//    `file://` uri with nothing behind it — a permanently broken icon that the cache
//    believes is fetched, so nothing ever re-fetches it.
//
// Both seams are the real modules over the two shims: node:sqlite for the store, and the
// in-memory filesystem for the icon files (whose `delete()` of a missing entry throws, as
// the native API does — so an unguarded delete fails here rather than passing silently).
// The TTL rules themselves are web's, verbatim, and are covered there; what is re-asserted
// here is only what this port can get wrong on its own.

import { sql } from 'drizzle-orm';

import { getDb } from './db';
import {
  clearFaviconFiles,
  FAVICON_RETRY_MS,
  faviconFileFor,
  isFaviconStale,
  putFavicon,
  putFaviconNone,
  readFavicon,
} from './favicon-store';
import { AccountFencedError, seedNewAccount } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));

const { resetFileSystem, listFileUris } = require('../testing/memory-file-system') as {
  resetFileSystem: () => void;
  listFileUris: () => string[];
};

const USER = 'alice';
const HOST = 'github.com';
const ICON = new Uint8Array([1, 2, 3, 4]);

beforeEach(async () => {
  getDb().run(sql`DELETE FROM favicons`);
  getDb().run(sql`DELETE FROM sync_meta`);
  resetFileSystem();
  // Both writes are fenced on the account's ownership row.
  await seedNewAccount(USER);
});

describe('putFavicon', () => {
  it('stores the verdict in the row and the bytes on disk', async () => {
    await putFavicon(USER, HOST, ICON);

    expect((await readFavicon(HOST))?.status).toBe('ok');
    expect(faviconFileFor(HOST).exists).toBe(true);
  });

  // Locations are DERIVED from the host, never persisted (iOS moves the app container
  // between updates, so a stored absolute uri goes stale). The encoding has to be
  // bijective, or two hosts collide onto one icon file.
  it('derives distinct locations for hosts that differ only in unsafe characters', () => {
    expect(faviconFileFor('example.com:8443').uri).not.toBe(faviconFileFor('example.com8443').uri);
    expect(faviconFileFor(HOST).uri).toBe(faviconFileFor(HOST).uri);
  });

  it('creates the icon directory on the first write', async () => {
    await expect(putFavicon(USER, HOST, ICON)).resolves.toBeUndefined();
    expect(listFileUris()).toHaveLength(1);
  });
});

describe('readFavicon', () => {
  it('is undefined for a host nothing has resolved', async () => {
    expect(await readFavicon('never-seen.example')).toBeUndefined();
  });

  // THE SPLIT-STORAGE RESOLUTION. An `ok` row with no file behind it must read as
  // unresolved so the provider RE-FETCHES — otherwise the UI trusts a verdict with no
  // bytes, and the icon is broken forever because the cache believes it is fetched.
  it('reads an `ok` row whose file has gone as unresolved', async () => {
    await putFavicon(USER, HOST, ICON);
    faviconFileFor(HOST).delete();

    expect(await readFavicon(HOST)).toBeUndefined();
  });

  // The `none` half has nothing on disk by construction, so the file check must not apply
  // to it — treating a `none` row as unresolved would re-buy the fetch on every launch,
  // which is exactly what recording the negative was for.
  it('keeps a `none` row readable even though it has no file', async () => {
    await putFaviconNone(USER, HOST);

    expect((await readFavicon(HOST))?.status).toBe('none');
  });
});

describe('putFaviconNone', () => {
  it('records a miss so a relaunch does not re-buy the fetch', async () => {
    await putFaviconNone(USER, HOST);

    const record = await readFavicon(HOST);
    expect(record?.status).toBe('none');
    // Fresh at the moment it was written — the whole point of recording the miss.
    expect(isFaviconStale(record, record?.fetchedAt ?? 0)).toBe(false);
  });

  // THE TWO-FILLER RULE. This is the interleaving that actually happens: the provider's
  // guess starts, device-extraction's capture lands real bytes, and then the guess's miss
  // returns. Without the guard it deletes those bytes and stamps `none`, and
  // isFaviconStale then honours that for FAVICON_RETRY_MS — a host with a perfectly good
  // captured icon showing a monogram for a week.
  it('never downgrades an `ok` row that a second filler already landed', async () => {
    await putFavicon(USER, HOST, ICON);

    await putFaviconNone(USER, HOST);

    expect((await readFavicon(HOST))?.status).toBe('ok');
    expect(faviconFileFor(HOST).exists).toBe(true);
  });

  // …but a row claiming `ok` with NO bytes is not a real icon, so it must not block the
  // miss — that state has to stay recoverable rather than latching forever.
  it('does overwrite an `ok` row whose file is missing', async () => {
    await putFavicon(USER, HOST, ICON);
    faviconFileFor(HOST).delete();

    await putFaviconNone(USER, HOST);

    expect((await readFavicon(HOST))?.status).toBe('none');
  });

  // A host that USED to have an icon and now serves none: the stale file goes, so the pair
  // can't disagree and no `file://` uri outlives the verdict that justified it.
  it('drops a stale icon file when a re-check finds nothing', async () => {
    await putFavicon(USER, HOST, ICON);
    // Age the row out of `ok` the only way a filler could: re-check after the icon is gone
    // from the row's perspective — simulated by clearing the row but keeping the file, the
    // orphan case a crash or an interrupted wipe leaves behind.
    getDb().run(sql`DELETE FROM favicons`);

    await putFaviconNone(USER, HOST);

    expect(faviconFileFor(HOST).exists).toBe(false);
    expect((await readFavicon(HOST))?.status).toBe('none');
  });
});

describe('isFaviconStale', () => {
  // web's rules, restated here only because this port has its OWN copy of them — they must
  // not drift, or the two platforms disagree about when a host is worth re-fetching.
  it('treats a host that was never resolved as stale', () => {
    expect(isFaviconStale(undefined, Date.now())).toBe(true);
  });

  it('never treats a stored icon as stale, at any age', () => {
    const record = { host: HOST, status: 'ok' as const, fetchedAt: 0 };

    expect(isFaviconStale(record, FAVICON_RETRY_MS * 100)).toBe(false);
  });

  it('holds a `none` verdict for the retry window and releases it exactly at the end', () => {
    const record = { host: HOST, status: 'none' as const, fetchedAt: 1_000_000 };

    expect(isFaviconStale(record, 1_000_000 + FAVICON_RETRY_MS - 1)).toBe(false);
    expect(isFaviconStale(record, 1_000_000 + FAVICON_RETRY_MS)).toBe(true);
  });
});

// 3. THE FENCE. Both fillers write after a network round trip, so a sign-out can have
//    wiped the store underneath them — and the table has no owner column to notice with.
//    Unfenced, the late write put the signed-out account's host back into the empty
//    store, icon file and all, after clearData had been and gone. What is asserted is
//    the FILE as much as the row: the row is refused by the transaction either way, and
//    a write ordered file-then-check would still leave the bytes on disk.
describe('the account fence', () => {
  const signOut = () => getDb().run(sql`DELETE FROM sync_meta`);

  it('refuses an icon that lands after the account signed out, row and file', async () => {
    signOut();

    await expect(putFavicon(USER, HOST, ICON)).rejects.toBeInstanceOf(AccountFencedError);

    expect(await readFavicon(HOST)).toBeUndefined();
    expect(listFileUris()).toEqual([]);
  });

  it('refuses a `none` verdict the same way', async () => {
    signOut();

    await expect(putFaviconNone(USER, HOST)).rejects.toBeInstanceOf(AccountFencedError);

    expect(await readFavicon(HOST)).toBeUndefined();
  });

  // The store may not be empty: the next account can have signed in while the fetch was
  // out. The late answer is the PREVIOUS account's, so it is refused by name.
  it('refuses a write for an account that is no longer the one signed in', async () => {
    signOut();
    await seedNewAccount('bob');

    await expect(putFavicon(USER, HOST, ICON)).rejects.toBeInstanceOf(AccountFencedError);

    expect(listFileUris()).toEqual([]);
  });
});

describe('clearFaviconFiles', () => {
  // The file half of the `favicons` table wipe (clear-data, delete-all-data). It runs
  // AFTER the table delete, so it must tolerate a directory that was never created — an
  // unguarded delete throws here, exactly as it would on device.
  it('removes every cached icon', async () => {
    await putFavicon(USER, HOST, ICON);
    await putFavicon(USER, 'example.org', ICON);

    clearFaviconFiles();

    expect(listFileUris()).toEqual([]);
  });

  it('is safe on a device that never cached an icon', () => {
    expect(() => clearFaviconFiles()).not.toThrow();
  });
});
