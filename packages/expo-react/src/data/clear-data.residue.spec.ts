// What the sign-out wipe leaves in the database FILE. Its own spec, and file-backed, because
// this is the one claim about the store that no query can check: after `DELETE FROM items`
// every table reads empty, `clear-data.spec.ts`'s full partition is all zeroes, and the
// decrypted bookmarks are still in `bracemark.db` — SQLite moves a deleted row's pages to
// its freelist with the bytes intact, and the WAL keeps every frame written since its last
// reset. Nothing fails; the file is simply still readable by anything that reads files.
//
// So the assertion is over raw bytes, of the database and of its WAL together: a wipe that
// scrubs one and not the other has moved the copy, not removed it (db.ts, scrubFreedPages
// — VACUUM without the checkpoint leaves the old file; the checkpoint without VACUUM
// leaves the freelist).
//
// node:sqlite is the device's engine with the device's defaults where it matters here
// (secure_delete off), so the bytes behave the same. What this cannot show is the flash
// underneath — a wear-levelled block that still holds an old page is beyond any file API.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LINKS_PREFIX, pathFromId, utf8 } from '@stxapps/shared';

import { clearData } from './clear-data';
import { getDb } from './db';
import { deleteItemsUnqueued, putItemsTx } from './item-store';
import { toItemRecord } from './projection';
import { seedNewAccount } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('./share-store', () => ({ clearShareData: () => undefined }));

const { setDatabaseFile } = require('../testing/node-sqlite') as {
  setDatabaseFile: (path: string | null) => void;
};

const dir = mkdtempSync(join(tmpdir(), 'bracemark-residue-'));
const dbFile = join(dir, 'bracemark.db');
setDatabaseFile(dbFile);

afterAll(() => {
  setDatabaseFile(null);
  rmSync(dir, { recursive: true, force: true });
});

const USER = 'alice';
// Distinctive, and longer than anything SQLite would split across a page boundary by
// accident: one hit anywhere in either file is one recoverable bookmark.
const MARK = 'residue-marker-7f3a';
const COUNT = 400;

function seedLibrary(): void {
  getDb().transaction((tx) => {
    putItemsTx(
      tx,
      Array.from({ length: COUNT }, (_, i) =>
        toItemRecord(
          pathFromId(`l_${i}`, LINKS_PREFIX),
          1,
          utf8(
            JSON.stringify({
              url: `https://${MARK}.example/${i}`,
              listId: 'my-list',
              tagIds: [],
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
        ),
      ),
    );
  });
}

// Occurrences of the marker across the database and its WAL.
function residue(): number {
  return [dbFile, `${dbFile}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString('latin1').split(MARK).length - 1)
    .reduce((sum, n) => sum + n, 0);
}

describe('what clearData leaves in the database file', () => {
  it('leaves none of the library readable in the file or its WAL', async () => {
    await seedNewAccount(USER);
    seedLibrary();
    // The seed is itself an assertion — the marker has to be on disk for its absence to
    // mean anything.
    expect(residue()).toBeGreaterThanOrEqual(COUNT);

    await clearData();

    expect(residue()).toBe(0);
  });

  // The control: the same rows deleted the ordinary way are still there. This is what the
  // wipe was before the scrub, and it is the reason the test above is not vacuous — if a
  // SQLite default ever changed so that a plain delete zeroed its pages, this would fail
  // and say the scrub is no longer what is doing the work.
  it('is the scrub doing that, not the delete', async () => {
    await seedNewAccount(USER);
    seedLibrary();
    const paths = Array.from({ length: COUNT }, (_, i) => pathFromId(`l_${i}`, LINKS_PREFIX));

    await deleteItemsUnqueued(USER, paths);

    expect(residue()).toBeGreaterThan(0);
  });
});
