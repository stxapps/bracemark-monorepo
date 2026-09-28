import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type NativePlatform } from './cli';
import { capture } from './process';

const execFileAsync = promisify(execFile);

function assertSafeFileName(fileName: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    throw new Error(`unsafe document-picker fixture name: ${fileName}`);
  }
}

// Put one generated fixture where the platform's REAL document picker can read
// it. No app storage or picker API is mocked: Android reads Downloads, while the
// iOS simulator reads the Files app's Local Storage provider. The latter path is
// resolved from simctl every run rather than hard-coding a simulator UUID.
export async function stageDocumentPickerFile(options: {
  platform: NativePlatform;
  deviceId: string;
  sourcePath: string;
  fileName: string;
}): Promise<() => Promise<void>> {
  assertSafeFileName(options.fileName);

  if (options.platform === 'android') {
    const target = `/sdcard/Download/${options.fileName}`;
    await capture('adb', ['-s', options.deviceId, 'push', options.sourcePath, target]);
    return async () => {
      await capture('adb', ['-s', options.deviceId, 'shell', 'rm', '-f', target], {
        allowFailure: true,
      });
    };
  }

  const groups = await capture('xcrun', [
    'simctl',
    'get_app_container',
    options.deviceId,
    'com.apple.DocumentsApp',
    'groups',
  ]);
  const localStorageLine = groups.stdout
    .split('\n')
    .find((line) => line.startsWith('group.com.apple.FileProvider.LocalStorage\t'));
  const groupPath = localStorageLine?.split('\t').slice(1).join('\t').trim();
  if (!groupPath) {
    throw new Error('the iOS simulator has no Files Local Storage group container');
  }
  const storage = join(groupPath, 'File Provider Storage');
  const target = join(storage, options.fileName);
  await mkdir(storage, { recursive: true });
  await copyFile(options.sourcePath, target);
  return async () => {
    await unlink(target).catch(() => undefined);
  };
}

const APP_ID = 'com.bracemark.app';

// The app's own sandbox, read from outside it: iOS through the simulator's data
// container on this Mac, Android through `run-as`, which a debuggable (dev) build
// permits. Nothing in the app is asked — the claim is about what it left on disk.
async function iosDataContainer(deviceId: string): Promise<string> {
  const result = await capture('xcrun', ['simctl', 'get_app_container', deviceId, APP_ID, 'data']);
  return result.stdout.trim();
}

// `adb exec-out` is binary-safe where `adb shell` is not (it would rewrite line
// endings), and a database has to come across byte for byte. Like `adb shell`, it
// joins its words into one command string that the device re-splits, so each
// word is quoted as adbShell quotes them (process.ts) — the export's file name
// has spaces, and a `*` must reach `find` rather than the device's shell.
function runAs(words: string[]): string {
  return ['run-as', APP_ID, ...words].map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
}

async function androidAppBytes(deviceId: string, path: string): Promise<Buffer> {
  const result = await execFileAsync('adb', ['-s', deviceId, 'exec-out', runAs(['cat', path])], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.stdout;
}

// Paths `find` reports under the app's data directory. Not `ls`: toybox's ls
// escapes the spaces in a name (`Bracemark\ links…`).
async function androidAppFind(deviceId: string, args: string[]): Promise<string[]> {
  const result = await capture('adb', ['-s', deviceId, 'exec-out', runAs(['find', ...args])], {
    allowFailure: true,
  });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// The newest file in the app's cache directory whose name starts with `prefix` —
// where expo's export writes before presenting the share sheet
// (expo-react data/export-all-data.ts, `Paths.cache`). Returned as text: the
// callers read plain-text exports.
export async function readAppCacheFile(options: {
  platform: NativePlatform;
  deviceId: string;
  prefix: string;
}): Promise<string> {
  if (options.platform === 'android') {
    const paths = await androidAppFind(options.deviceId, [
      'cache',
      '-maxdepth',
      '1',
      '-name',
      `${options.prefix}*`,
    ]);
    const path = paths.sort().at(-1);
    if (!path) throw new Error(`no "${options.prefix}…" file in the app’s cache`);
    return (await androidAppBytes(options.deviceId, path)).toString('utf8');
  }

  const caches = join(await iosDataContainer(options.deviceId), 'Library', 'Caches');
  const names = (await readdir(caches)).filter((name) => name.startsWith(options.prefix)).sort();
  const name = names.at(-1);
  if (!name) throw new Error(`no "${options.prefix}…" file in ${caches}`);
  return readFile(join(caches, name), 'utf8');
}

// How many rows the app's local store holds in `tables` — expo-sqlite's
// `bracemark-data.db` (expo-react data/db.ts, DB_NAME), by its schema names, as
// the web runner addresses Dexie's. The database and its WAL are copied off the
// device into `workDir` first and read there, so the host never takes a lock on
// the live file, and rows still only in the WAL are counted.
export async function countAppRows(options: {
  platform: NativePlatform;
  deviceId: string;
  tables: string[];
  workDir: string;
}): Promise<number> {
  const database = 'bracemark-data.db';
  await rm(options.workDir, { recursive: true, force: true });
  await mkdir(options.workDir, { recursive: true });

  if (options.platform === 'android') {
    const paths = await androidAppFind(options.deviceId, ['.', '-name', `${database}*`]);
    if (!paths.some((path) => path.endsWith(`/${database}`))) {
      throw new Error(`no ${database} in the app’s sandbox`);
    }
    for (const path of paths) {
      const name = path.split('/').at(-1) ?? path;
      await writeFile(join(options.workDir, name), await androidAppBytes(options.deviceId, path));
    }
  } else {
    const container = await iosDataContainer(options.deviceId);
    const found = await capture('find', [container, '-name', `${database}*`]);
    const paths = found.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!paths.some((path) => path.endsWith(`/${database}`))) {
      throw new Error(`no ${database} under ${container}`);
    }
    for (const path of paths) {
      await copyFile(path, join(options.workDir, path.split('/').at(-1) ?? path));
    }
  }

  const sql = options.tables.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(' + ');
  const result = await capture('sqlite3', [join(options.workDir, database), `SELECT ${sql};`]);
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count)) throw new Error(`sqlite3 answered "${result.stdout.trim()}"`);
  return count;
}
