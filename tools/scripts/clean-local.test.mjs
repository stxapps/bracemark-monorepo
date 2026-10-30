/**
 * `clean-local.mjs`, pinned.
 *
 *   npm run test:clean-local
 *
 * NOT part of `npm run test`, for the reason `tools/cloudfront/rewrite-url.test.mjs`
 * gives: `tools/` is not a project in the graph (docs/testing.md, _the things
 * outside the two runners_).
 *
 * This deletes things, so what it must NOT delete is what's pinned, and each refusal
 * has a passing control built from the same fixture. The fixture's databases are in
 * WAL mode like the real ones, and a Miniflare upgrade is the one thing it cannot
 * stand in for: it pins this script's reading of the layout, not that the layout
 * still holds, which is what the refusals are for.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { plan } from './clean-local.mjs';

const STATE = 'apps/bracemark-api/.wrangler/state/v3';
const D1 = `${STATE}/d1/miniflare-D1DatabaseObject`;
const R2 = `${STATE}/r2/miniflare-R2BucketObject`;
const BLOBS = `${STATE}/r2/bracemark-user-files-dev/blobs`;
const DO = `${STATE}/do/bracemark-api-development-UserDataDO`;

const THROWAWAY = { id: 'aaaaaaaa-0000-4000-8000-000000000001', username: 'e2e_0123456789ab' };
const SEED = { id: 'bbbbbbbb-0000-4000-8000-000000000002', username: 'seed_plus_full' };
// A hand-made name that starts like a throwaway one, which is why the match is exact.
const NEAR_MISS = { id: 'cccccccc-0000-4000-8000-000000000003', username: 'e2e_mine' };
const USERS = [THROWAWAY, SEED, NEAR_MISS];

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const idle = () => false;

function write(root, relative, content = 'x') {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function database(root, relative, schema) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`pragma journal_mode = wal; ${schema}`);
  return db;
}

function directory(root) {
  const db = database(
    root,
    `${D1}/directory.sqlite`,
    `create table usernames (username text primary key, user_id text);
     create table purchases (id text primary key, user_id text);
     create table paddle_checkouts (transaction_id text primary key, user_id text);`,
  );
  for (const { id, username } of USERS) {
    db.prepare('insert into usernames values (?, ?)').run(username, id);
    db.prepare('insert into purchases values (?, ?)').run(`purchase-${id}`, id);
    db.prepare('insert into paddle_checkouts values (?, ?)').run(`checkout-${id}`, id);
  }
  db.close();
}

function shard(root) {
  const db = database(
    root,
    `${D1}/accounts.sqlite`,
    `create table users (id text primary key);
     create table account_keys (user_id text, door_type text);`,
  );
  for (const { id } of USERS) {
    db.prepare('insert into users values (?)').run(id);
    db.prepare("insert into account_keys values (?, 'password')").run(id);
  }
  db.close();
}

function sessions(root) {
  const db = database(
    root,
    `${D1}/sessions.sqlite`,
    'create table sessions (id text, user_id text);',
  );
  for (const { id } of USERS) db.prepare('insert into sessions values (?, ?)').run(`s-${id}`, id);
  db.close();
}

function bucket(root) {
  const db = database(
    root,
    `${R2}/bucket.sqlite`,
    `create table _mf_objects (key text primary key, blob_id text, size integer);
     create table _mf_multipart_parts (part_number integer);`,
  );
  for (const { id } of USERS) {
    db.prepare('insert into _mf_objects values (?, ?, 200)').run(`users/${id}/links/1.enc`, id);
    write(root, `${BLOBS}/${id}`);
  }
  db.close();
}

function durableObject(root, { id }) {
  const db = database(
    root,
    `${DO}/do-${id}.sqlite`,
    'create table __miniflare_do_name (id integer, name text);',
  );
  db.prepare('insert into __miniflare_do_name values (1, ?)').run(id);
  db.close();
}

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'clean-local-'));
  roots.push(root);
  directory(root);
  shard(root);
  sessions(root);
  bucket(root);
  for (const user of USERS) durableObject(root, user);
  write(root, `${DO}/metadata.sqlite`);
  return root;
}

function bare() {
  const root = mkdtempSync(join(tmpdir(), 'clean-local-'));
  roots.push(root);
  return root;
}

function one(root, part, isRunning = idle) {
  return plan(root, [part], isRunning)[0];
}

function rows(root, relative, sql) {
  const db = new DatabaseSync(join(root, relative));
  const result = db.prepare(sql).all();
  db.close();
  return result;
}

function userIdsIn(root, relative, table, column) {
  return rows(root, relative, `select ${column} as id from ${table}`)
    .map((row) => row.id)
    .sort();
}

const KEPT = [SEED.id, NEAR_MISS.id].sort();

describe('accounts', () => {
  it('removes a throwaway account from every store', () => {
    const root = stateFixture();
    one(root, 'accounts').apply();

    assert.deepEqual(userIdsIn(root, `${D1}/directory.sqlite`, 'usernames', 'user_id'), KEPT);
    assert.deepEqual(userIdsIn(root, `${D1}/directory.sqlite`, 'purchases', 'user_id'), KEPT);
    assert.deepEqual(
      userIdsIn(root, `${D1}/directory.sqlite`, 'paddle_checkouts', 'user_id'),
      KEPT,
    );
    assert.deepEqual(userIdsIn(root, `${D1}/accounts.sqlite`, 'users', 'id'), KEPT);
    assert.deepEqual(userIdsIn(root, `${D1}/accounts.sqlite`, 'account_keys', 'user_id'), KEPT);
    assert.deepEqual(userIdsIn(root, `${D1}/sessions.sqlite`, 'sessions', 'user_id'), KEPT);
    assert.deepEqual(
      rows(root, `${R2}/bucket.sqlite`, 'select key from _mf_objects order by key').map(
        (row) => row.key,
      ),
      KEPT.map((id) => `users/${id}/links/1.enc`),
    );
    assert.deepEqual(readdirSync(join(root, BLOBS)).sort(), KEPT);
    assert.ok(!existsSync(join(root, `${DO}/do-${THROWAWAY.id}.sqlite`)));
  });

  it('keeps every other account whole, near-miss names included', () => {
    const root = stateFixture();
    const entry = one(root, 'accounts');
    assert.match(entry.summary, /^1 e2e accounts, 1 objects$/);
    assert.equal(entry.note, 'keeps 2: e2e_mine, seed_plus_full');
    entry.apply();

    for (const { id } of [SEED, NEAR_MISS]) {
      assert.ok(existsSync(join(root, `${BLOBS}/${id}`)));
      assert.ok(existsSync(join(root, `${DO}/do-${id}.sqlite`)));
    }
    assert.ok(existsSync(join(root, `${DO}/metadata.sqlite`)));
  });

  it('takes a Durable Object file with its WAL sidecars', () => {
    const root = stateFixture();
    const sidecars = ['-wal', '-shm'].map((suffix) => `${DO}/do-${THROWAWAY.id}.sqlite${suffix}`);
    for (const sidecar of sidecars) write(root, sidecar, '');
    // A kept account's sidecars are live data, so they must not go with it.
    const kept = write(root, `${DO}/do-${SEED.id}.sqlite-shm`, '');

    one(root, 'accounts').apply();

    for (const sidecar of sidecars) assert.ok(!existsSync(join(root, sidecar)));
    assert.ok(existsSync(kept));
  });

  it('changes nothing until apply is called', () => {
    const root = stateFixture();
    const before = readFileSync(join(root, `${D1}/directory.sqlite`));

    const entry = one(root, 'accounts');

    assert.ok(entry.bytes > 0);
    assert.deepEqual(readFileSync(join(root, `${D1}/directory.sqlite`)), before);
    assert.ok(existsSync(join(root, `${BLOBS}/${THROWAWAY.id}`)));
    assert.ok(existsSync(join(root, `${DO}/do-${THROWAWAY.id}.sqlite`)));
  });

  it('sees rows that are still in the WAL', () => {
    // A stopped stack can leave committed rows there, and `?immutable=1` reads past them.
    const root = stateFixture();
    const writer = new DatabaseSync(join(root, `${D1}/directory.sqlite`));
    writer.exec('pragma wal_autocheckpoint = 0');
    writer
      .prepare('insert into usernames values (?, ?)')
      .run('e2e_ffffffffffff', 'eeeeeeee-0000-4000-8000-000000000005');

    const entry = one(root, 'accounts');
    writer.close();

    assert.match(entry.summary, /^2 e2e accounts/);
  });

  it('finishes a run that died partway, because usernames go last', () => {
    const root = stateFixture();
    rmSync(join(root, `${BLOBS}/${THROWAWAY.id}`));
    rmSync(join(root, `${DO}/do-${THROWAWAY.id}.sqlite`));

    one(root, 'accounts').apply();

    assert.deepEqual(userIdsIn(root, `${D1}/directory.sqlite`, 'usernames', 'user_id'), KEPT);
    assert.deepEqual(userIdsIn(root, `${D1}/accounts.sqlite`, 'users', 'id'), KEPT);
  });

  it('is a no-op the second time', () => {
    const root = stateFixture();
    one(root, 'accounts').apply();

    const again = one(root, 'accounts');
    assert.match(again.summary, /^0 e2e accounts, 0 objects$/);
    assert.equal(again.bytes, 0);
    again.apply();

    assert.deepEqual(userIdsIn(root, `${D1}/directory.sqlite`, 'usernames', 'user_id'), KEPT);
  });

  it('has nothing to do without local state', () => {
    assert.equal(one(bare(), 'accounts').summary, 'no local api state');
  });

  it('refuses while the stack is running', () => {
    const root = stateFixture();
    const entry = one(root, 'accounts', (pattern) => pattern.includes('workerd'));
    assert.match(entry.refused, /stack is running/);
    assert.ok(!one(root, 'accounts').refused);
  });

  it('refuses a second database holding the same table', () => {
    const root = stateFixture();
    assert.ok(!one(root, 'accounts').refused);

    database(root, `${D1}/shard-2.sqlite`, 'create table users (id text primary key);').close();

    assert.match(one(root, 'accounts').refused, /expected one database with `users`, found 2/);
  });

  it('refuses a table without the column it deletes by', () => {
    const root = stateFixture();
    rmSync(join(root, `${D1}/sessions.sqlite`));
    database(root, `${D1}/sessions.sqlite`, 'create table sessions (id text);').close();

    assert.match(one(root, 'accounts').refused, /`sessions` has no user_id/);
  });

  it('refuses a Durable Object that does not record its owner', () => {
    const root = stateFixture();
    database(root, `${DO}/unnamed.sqlite`, 'create table op_logs (id integer);').close();

    assert.match(one(root, 'accounts').refused, /unnamed\.sqlite does not record its owner/);
  });

  it('refuses a Durable Object owned by nobody it knows', () => {
    const root = stateFixture();
    durableObject(root, { id: 'dddddddd-0000-4000-8000-000000000004' });

    assert.match(one(root, 'accounts').refused, /belongs to nobody/);
  });

  it('refuses multipart objects, whose bytes it could not find', () => {
    const root = stateFixture();
    const db = new DatabaseSync(join(root, `${R2}/bucket.sqlite`));
    db.exec('insert into _mf_multipart_parts values (1)');
    db.close();

    assert.match(one(root, 'accounts').refused, /multipart/);
  });
});

describe('runs', () => {
  const ARTIFACTS = 'e2e/.artifacts';

  function run(root, name, status) {
    write(root, `${ARTIFACTS}/runs/${name}/run.json`, JSON.stringify({ status }));
    write(root, `${ARTIFACTS}/runs/${name}/report/index.html`);
  }

  function survivors(root) {
    return readdirSync(join(root, `${ARTIFACTS}/runs`)).sort();
  }

  it('removes a passing run and keeps a failed one', () => {
    const root = bare();
    run(root, 'web-passed', 'passed');
    run(root, 'web-failed', 'failed');

    const entry = one(root, 'runs');
    assert.equal(entry.summary, '1 passing e2e runs (1 kept)');
    entry.apply();

    assert.deepEqual(survivors(root), ['web-failed']);
  });

  it('keeps a passing run that a latest pointer names', () => {
    const root = bare();
    run(root, 'web-newest', 'passed');
    run(root, 'web-older', 'passed');
    write(root, `${ARTIFACTS}/latest-web-run.json`, JSON.stringify({ runId: 'web-newest' }));

    one(root, 'runs').apply();

    assert.deepEqual(survivors(root), ['web-newest']);
  });

  it('keeps a run whose status it cannot read', () => {
    const root = bare();
    write(root, `${ARTIFACTS}/runs/web-died/run.json`, '{ truncated');
    mkdirSync(join(root, `${ARTIFACTS}/runs/web-empty`));

    one(root, 'runs').apply();

    assert.deepEqual(survivors(root), ['web-died', 'web-empty']);
  });

  it('leaves everything else under .artifacts alone', () => {
    const root = bare();
    run(root, 'web-passed', 'passed');
    const baseline = write(root, `${ARTIFACTS}/visual/baselines/phone/home.png`);
    const scratch = write(root, `${ARTIFACTS}/scratch/peek.ts`);

    one(root, 'runs').apply();

    assert.ok(existsSync(baseline));
    assert.ok(existsSync(scratch));
  });

  it('refuses when a latest pointer cannot be read', () => {
    const root = bare();
    run(root, 'web-passed', 'passed');
    write(root, `${ARTIFACTS}/latest-web-run.json`, 'not json');

    assert.match(one(root, 'runs').refused, /latest-web-run\.json/);
  });

  it('has nothing to do without runs', () => {
    assert.equal(one(bare(), 'runs').summary, 'no e2e runs');
  });
});

describe('gradle', () => {
  it('removes build output and leaves the sources beside it', () => {
    const root = bare();
    write(root, 'node_modules/react-native-svg/android/build/out.bin');
    write(root, 'node_modules/@scope/native/android/.cxx/out.bin');
    const gradleFile = write(root, 'node_modules/react-native-svg/android/build.gradle');
    const source = write(root, 'node_modules/react-native-svg/android/src/Svg.kt');

    one(root, 'gradle').apply();

    assert.ok(!existsSync(join(root, 'node_modules/react-native-svg/android/build')));
    assert.ok(!existsSync(join(root, 'node_modules/@scope/native/android/.cxx')));
    assert.ok(existsSync(gradleFile));
    assert.ok(existsSync(source));
  });

  it('clears the app and the committed native modules with them', () => {
    const root = bare();
    const output = [
      'apps/bracemark-expo/android/build',
      'apps/bracemark-expo/android/app/build',
      'apps/bracemark-expo/android/app/.cxx',
      'apps/bracemark-expo/modules/bracemark-share/android/build',
      'packages/expo-crypto/android/.cxx',
    ];
    for (const dir of output) write(root, `${dir}/out.bin`);
    const kotlin = write(root, 'packages/expo-crypto/android/src/Crypto.kt');

    one(root, 'gradle').apply();

    for (const dir of output) assert.ok(!existsSync(join(root, dir)), dir);
    assert.ok(existsSync(kotlin));
  });

  it('leaves a path that only looks like Gradle output', () => {
    const root = bare();
    const shipped = write(root, 'node_modules/@expo/cli/build/src/run/android/build/index.js');

    one(root, 'gradle').apply();

    assert.ok(existsSync(shipped));
  });

  it('does not reach a workspace package through its symlink', () => {
    const root = bare();
    const output = write(root, 'elsewhere/native/android/build/out.bin');
    mkdirSync(join(root, 'node_modules/@stxapps'), { recursive: true });
    symlinkSync(join(root, 'elsewhere/native'), join(root, 'node_modules/@stxapps/native'));

    assert.equal(one(root, 'gradle').bytes, 0);
    assert.ok(existsSync(output));
  });

  it('refuses during a build, and not for an idle daemon', () => {
    const root = bare();
    write(root, 'node_modules/react-native-svg/android/build/out.bin');

    const building = one(root, 'gradle', (pattern) => pattern === 'GradleWrapperMain');
    const daemonOnly = one(root, 'gradle', (pattern) => pattern === 'GradleDaemon');

    assert.match(building.refused, /Gradle build is running/);
    assert.ok(!daemonOnly.refused);
  });
});

describe('plan', () => {
  it('keeps one refused part from taking the others with it', () => {
    const root = stateFixture();
    write(root, 'e2e/.artifacts/runs/web/run.json', JSON.stringify({ status: 'passed' }));

    const [accounts, runs] = plan(root, ['accounts', 'runs'], () => true);

    assert.match(accounts.refused, /stack is running/);
    assert.equal(runs.summary, '1 passing e2e runs (0 kept)');
  });
});
