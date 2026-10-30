// Reclaims disk from what THIS checkout has left behind. A dry run unless told
// otherwise, and it only ever touches the clone it runs from.
//
//   npm run clean:local                                 # dry run: runs, accounts
//   npm run clean:local -- --apply                      # do it
//   npm run clean:local -- gradle                       # dry run of that part alone
//   npm run clean:local -- runs accounts gradle --apply # everything
//
// Three parts, because they are not the same risk (docs/e2e.md, _cleaning local
// state_):
//
//   runs      passing e2e runs. Failures stay until they are resolved, and so does
//             any run a `latest-*.json` pointer names: the report command opens it.
//   accounts  the throwaway `e2e_*` accounts in local D1, R2 and Durable Objects.
//             Their passwords are never persisted, so nothing can sign into one
//             again. Every other account keeps its rows and its sessions.
//   gradle    Android build output. Opt-in, and not routine: all of it regenerates,
//             but the next Android build recompiles every native library.
//
// ACCOUNTS REACHES INTO MINIFLARE'S PRIVATE STORAGE, and there is no other door:
// the real delete-account route needs a password nobody kept, and R2 has no bulk
// delete for the local bucket. So the layout below is an assumption a wrangler bump
// can break, and every assumption is checked BEFORE the first write. A failed check
// refuses that part rather than guessing. Refusing is cheap, because this is local
// test data: the documented reset (rm -rf the state, `npm run d1:migrate`, re-seed)
// is always there.
//
// Writes run in the order that makes a crash finishable by running this again. The
// `usernames` rows name what to delete, so they go LAST.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const STATE_DIR = 'apps/bracemark-api/.wrangler/state/v3';
const D1_DIR = `${STATE_DIR}/d1/miniflare-D1DatabaseObject`;
const R2_DIR = `${STATE_DIR}/r2/miniflare-R2BucketObject`;
const BLOBS_DIR = `${STATE_DIR}/r2/bracemark-user-files-dev/blobs`;
const DO_DIR = `${STATE_DIR}/do/bracemark-api-development-UserDataDO`;
const ARTIFACTS_DIR = 'e2e/.artifacts';

// The exact shape `e2e/web/fixtures/account.ts` mints, and deliberately not "every
// name that isn't a seed": a hand-made account must survive this.
const THROWAWAY_USERNAME = /^e2e_[0-9a-f]{12}$/;

// In delete order: `usernames` last, `account_keys` before the `users` it references.
const D1_TABLES = [
  { table: 'account_keys', column: 'user_id' },
  { table: 'users', column: 'id' },
  { table: 'sessions', column: 'user_id' },
  { table: 'paddle_checkouts', column: 'user_id' },
  { table: 'purchases', column: 'user_id' },
  { table: 'usernames', column: 'user_id' },
];

// R2 keeps each object in its own file, so a 200-byte link costs a whole block. That
// is why the local bucket reads 2.7 GiB on disk while its rows sum to 168 MiB.
const BLOCK_BYTES = 4096;

const PARTS = ['runs', 'accounts', 'gradle'];
const DEFAULT_PARTS = ['runs', 'accounts'];

class Refusal extends Error {}

function processRunning(pattern) {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false; // pgrep's "no match"
    throw error;
  }
}

function diskBytes(paths) {
  if (paths.length === 0) return 0;
  const output = execFileSync('du', ['-sk', '--', ...paths], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .reduce((sum, line) => sum + Number.parseInt(line, 10) * 1024, 0);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function pinnedRuns(artifacts) {
  const pinned = new Set();
  for (const name of readdirSync(artifacts)) {
    if (!/^latest-.*\.json$/.test(name)) continue;
    const runId = readJson(path.join(artifacts, name))?.runId;
    if (typeof runId !== 'string') throw new Refusal(`cannot read the run ${name} points at`);
    pinned.add(runId);
  }
  return pinned;
}

function planRuns(root) {
  const artifacts = path.join(root, ARTIFACTS_DIR);
  const runs = path.join(artifacts, 'runs');
  if (!existsSync(runs)) return { summary: 'no e2e runs', bytes: 0 };

  const pinned = pinnedRuns(artifacts);
  const all = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const doomed = all
    .filter(({ name }) => !pinned.has(name))
    .filter(({ name }) => readJson(path.join(runs, name, 'run.json'))?.status === 'passed')
    .map(({ name }) => path.join(runs, name));

  return {
    summary: `${doomed.length} passing e2e runs (${all.length - doomed.length} kept)`,
    bytes: diskBytes(doomed),
    apply() {
      for (const dir of doomed) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function subdirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

// By walking packages rather than searching for `android/build`: @expo/cli and friends
// ship JavaScript under paths with `android` in them, and a symlinked workspace package
// is not a directory here, so it is not reached through node_modules at all.
function nodeModulesPackages(root) {
  return subdirectories(path.join(root, 'node_modules'))
    .filter((dir) => !path.basename(dir).startsWith('.'))
    .flatMap((dir) => (path.basename(dir).startsWith('@') ? subdirectories(dir) : [dir]));
}

function planGradle(root, isRunning) {
  // The wrapper, not GradleDaemon: an idle daemon lingers for hours after a build.
  if (isRunning('GradleWrapperMain')) throw new Refusal('a Gradle build is running');

  const nativeProjects = [
    ...nodeModulesPackages(root),
    ...subdirectories(path.join(root, 'packages')),
    ...subdirectories(path.join(root, 'apps/bracemark-expo/modules')),
  ];
  const app = path.join(root, 'apps/bracemark-expo/android');
  const doomed = [
    ...nativeProjects.flatMap((dir) => [
      path.join(dir, 'android/build'),
      path.join(dir, 'android/.cxx'),
    ]),
    // All or nothing. The app's CMake cache names directories inside the output above,
    // so clearing only that half leaves a build pointing at paths that no longer exist.
    path.join(app, 'build'),
    path.join(app, 'app/build'),
    path.join(app, 'app/.cxx'),
  ].filter((dir) => existsSync(dir));

  return {
    summary: `${doomed.length} Gradle output directories`,
    bytes: diskBytes(doomed),
    note: 'the next Android build recompiles every native library',
    apply() {
      for (const dir of doomed) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sqliteFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => path.join(dir, name));
}

// Never `?immutable=1`, however tempting for a read: every one of these databases is in
// WAL mode and a stopped stack can leave committed rows in the -wal, which immutable
// ignores. A read-only open sees them, and a stack that is running was refused already.
function readOnly(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function columnsOf(file, table) {
  return readOnly(file, (db) =>
    db
      .prepare('select name from pragma_table_info(?)')
      .all(table)
      .map((row) => row.name),
  );
}

function findTable(dir, table, columns) {
  const hits = sqliteFiles(dir).filter((file) => columnsOf(file, table).length > 0);
  // More than one is the likeliest future: a second ACCOUNTS_DB shard.
  if (hits.length !== 1) {
    throw new Refusal(`expected one database with \`${table}\`, found ${hits.length}`);
  }
  const present = columnsOf(hits[0], table);
  const missing = columns.filter((column) => !present.includes(column));
  if (missing.length > 0) throw new Refusal(`\`${table}\` has no ${missing.join(', ')}`);
  return hits[0];
}

function readUsers(root) {
  const file = findTable(path.join(root, D1_DIR), 'usernames', ['username', 'user_id']);
  return readOnly(file, (db) => db.prepare('select username, user_id from usernames').all());
}

// `users/{uid}/…` is the only key shape the api writes (bracemark-api, `r2/keys.ts`).
function readObjects(root, doomedUsers) {
  const dir = path.join(root, R2_DIR);
  if (sqliteFiles(dir).length === 0) return { file: undefined, keys: [], blobs: [], bytes: 0 };

  const file = findTable(dir, '_mf_objects', ['key', 'blob_id', 'size']);
  return readOnly(file, (db) => {
    const parts = db.prepare('select count(*) as count from _mf_multipart_parts').get();
    if (parts.count > 0) throw new Refusal('R2 holds multipart objects, which this cannot follow');

    const objects = { file, keys: [], blobs: [], bytes: 0 };
    for (const { key, blob_id: blob, size } of db
      .prepare('select key, blob_id, size from _mf_objects')
      .iterate()) {
      if (!doomedUsers.has(key.slice('users/'.length, key.indexOf('/', 'users/'.length)))) continue;
      if (!blob) throw new Refusal(`R2 object ${key} has no blob`);
      objects.keys.push(key);
      objects.blobs.push(blob);
      objects.bytes += Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    }
    return objects;
  });
}

// Each Durable Object's file names its own owner, so nothing here depends on how
// workerd derives the id in the filename. A file that cannot say whose it is, or names
// someone the directory has never heard of, means this reading of the layout is wrong.
function readDurableObjects(root, knownUsers, doomedUsers) {
  const doomed = [];
  for (const file of sqliteFiles(path.join(root, DO_DIR))) {
    const name = readDurableObjectName(file);
    if (!knownUsers.has(name)) throw new Refusal(`${path.basename(file)} belongs to nobody`);
    if (doomedUsers.has(name)) doomed.push(file);
  }
  return doomed;
}

function readDurableObjectName(file) {
  try {
    return readOnly(file, (db) => db.prepare('select name from __miniflare_do_name').get()?.name);
  } catch {
    throw new Refusal(`${path.basename(file)} does not record its owner`);
  }
}

function deleteRows(file, sql, values) {
  const db = new DatabaseSync(file);
  try {
    const statement = db.prepare(sql);
    db.exec('begin');
    for (const value of values) statement.run(value);
    db.exec('commit');
  } finally {
    db.close();
  }
}

function vacuum(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('vacuum');
  } finally {
    db.close();
  }
}

function planAccounts(root, isRunning) {
  if (!existsSync(path.join(root, D1_DIR))) return { summary: 'no local api state', bytes: 0 };
  if (isRunning('workerd|wrangler')) throw new Refusal('the local stack is running, stop it first');

  const users = readUsers(root);
  const doomedUsers = new Set(
    users.filter(({ username }) => THROWAWAY_USERNAME.test(username)).map((user) => user.user_id),
  );
  const kept = users.filter((user) => !doomedUsers.has(user.user_id)).map((user) => user.username);

  const d1Dir = path.join(root, D1_DIR);
  const tables = D1_TABLES.map(({ table, column }) => ({
    table,
    column,
    file: findTable(d1Dir, table, [column]),
  }));
  const objects = readObjects(root, doomedUsers);
  const durableObjects = readDurableObjects(
    root,
    new Set(users.map((user) => user.user_id)),
    doomedUsers,
  );

  return {
    summary: `${doomedUsers.size} e2e accounts, ${objects.keys.length} objects`,
    bytes: objects.bytes + durableObjects.reduce((sum, file) => sum + statSync(file).size, 0),
    note: `keeps ${kept.length}: ${kept.sort().join(', ')}`,
    apply() {
      if (doomedUsers.size === 0) return;
      // Files before rows: a row is what says the file exists.
      const blobs = path.join(root, BLOBS_DIR);
      for (const blob of objects.blobs) rmSync(path.join(blobs, blob), { force: true });
      if (objects.file) {
        deleteRows(objects.file, 'delete from _mf_objects where key = ?', objects.keys);
        vacuum(objects.file);
      }
      for (const file of durableObjects) {
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
      }
      for (const { table, column, file } of tables) {
        deleteRows(file, `delete from ${table} where ${column} = ?`, [...doomedUsers]);
      }
      for (const file of new Set(tables.map((table) => table.file))) vacuum(file);
    },
  };
}

const PLANNERS = { runs: planRuns, accounts: planAccounts, gradle: planGradle };

export function plan(root, parts, isRunning = processRunning) {
  return parts.map((part) => {
    try {
      return { part, ...PLANNERS[part](root, isRunning) };
    } catch (error) {
      if (error instanceof Refusal) return { part, refused: error.message };
      throw error;
    }
  });
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function parseArgs(args) {
  const parts = args.filter((arg) => !arg.startsWith('--'));
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknown = [
    ...parts.filter((part) => !PARTS.includes(part)),
    ...flags.filter((flag) => flag !== '--apply'),
  ];
  if (unknown.length > 0) {
    console.error(
      `unknown: ${unknown.join(' ')}\nusage: clean-local [${PARTS.join(' ')}] [--apply]`,
    );
    process.exit(2);
  }
  return { parts: parts.length > 0 ? parts : DEFAULT_PARTS, apply: flags.includes('--apply') };
}

function main() {
  const { parts, apply } = parseArgs(process.argv.slice(2));
  const plans = plan(REPO_ROOT, parts);

  console.log(apply ? 'cleaning local state\n' : 'dry run: nothing changes without --apply\n');
  for (const { part, summary, bytes, note, refused } of plans) {
    if (refused) {
      console.log(`  ${part.padEnd(9)}REFUSED: ${refused}`);
      continue;
    }
    console.log(`  ${part.padEnd(9)}${summary}, about ${formatBytes(bytes)}`);
    if (note) console.log(`  ${''.padEnd(9)}${note}`);
  }

  const ready = plans.filter((entry) => !entry.refused);
  if (apply) for (const entry of ready) entry.apply?.();

  const total = ready.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`\n${apply ? 'freed' : 'would free'} about ${formatBytes(total)}`);

  if (ready.length < plans.length) {
    console.log('\nA refused part changed nothing. See docs/e2e.md, _cleaning local state_.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
