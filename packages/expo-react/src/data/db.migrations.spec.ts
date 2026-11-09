// db.ts's migration runner, against database FILES: what a phone holds when the
// update that carries a migration first opens it. Its failures are all silent on a
// fresh install, which is what every other spec opens, so they need a file shaped
// like the first release's:
//
//   - a runner that took user_version 0 to mean "empty" (and recreated, or skipped,
//     what's there) — every database the first release made reads 0;
//   - a migration that ran again on the next open — `ADD COLUMN` throws on a column
//     that exists, and getDb() then fails on every launch;
//   - a database from a NEWER build (a downgrade) treated as one to migrate.
//
// db.ts opens once per module registry, so each open below is its own registry over
// the same file (jest.isolateModules).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

const { setDatabaseFile } = require('../testing/node-sqlite') as {
  setDatabaseFile: (path: string | null) => void;
};

type Db = typeof import('./db');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bracemark-migrations-'));
  file = join(dir, 'bracemark-data.db');
  setDatabaseFile(file);
});

afterEach(() => {
  setDatabaseFile(null);
  rmSync(dir, { recursive: true, force: true });
});

// A fresh registry's db.ts, opened (and so migrated) on the file.
function open(): Db {
  let mod: Db | undefined;
  jest.isolateModules(() => {
    mod = require('./db') as Db;
  });
  if (!mod) throw new Error('db.ts did not load');
  mod.getDb();
  return mod;
}

// What the first release left on a device: its DDL (the shipped statement, which
// db.ts still runs verbatim), a row in it, and no user_version.
function firstReleaseDatabase(DDL: string): void {
  const raw = new DatabaseSync(file);
  raw.exec(DDL);
  raw.exec(
    `INSERT INTO sync_meta VALUES ('alice', 2000, 'links/l_a.enc', 1500);
     INSERT INTO items (path, updated_at, data) VALUES ('links/l_a.enc', 2000, x'7b7d');`,
  );
  raw.close();
}

function inspect(): { version: number; columns: string[]; rows: number } {
  const raw = new DatabaseSync(file);
  try {
    const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    const columns = (raw.prepare('PRAGMA table_info(sync_meta)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const { n } = raw.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    return { version: user_version, columns, rows: n };
  } finally {
    raw.close();
  }
}

it('migrates a first-release database in place, keeping what it holds', () => {
  const { DDL, MIGRATIONS } = jest.requireActual<Db>('./db');
  firstReleaseDatabase(DDL);

  const { getDb, syncMeta } = open();

  const after = inspect();
  expect(after.version).toBe(MIGRATIONS.length);
  expect(after.columns).toEqual(
    expect.arrayContaining([
      'unreadable_paths',
      'unreadable_recheck',
      'unreadable_record_complete_at',
      'last_orphan_sweep_at',
    ]),
  );
  expect(after.rows).toBe(1);
  // The row from before reads through the new schema, as "nothing recorded".
  const meta = getDb().select().from(syncMeta).get();
  expect(meta).toMatchObject({
    username: 'alice',
    syncCursorUpdatedAt: 2000,
    unreadablePaths: null,
    unreadableRecheck: null,
    // Not proven: the engine forces one fallback before any sweep runs.
    unreadableRecordCompleteAt: null,
    lastOrphanSweepAt: null,
  });
});

it('does not run a migration again on the next open', () => {
  const { DDL } = jest.requireActual<Db>('./db');
  firstReleaseDatabase(DDL);
  open();

  expect(() => open()).not.toThrow();
});

it('leaves a database from a newer build as it is', () => {
  const { DDL } = jest.requireActual<Db>('./db');
  firstReleaseDatabase(DDL);
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 99;');
  raw.close();

  expect(() => open()).not.toThrow();
  expect(inspect().version).toBe(99);
});
