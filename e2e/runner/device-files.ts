import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
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

// The export's own directory under the app's cache (expo-react
// data/cache-files.ts, EXPORT_FILES_DIR). A second copy of that name, and on
// purpose: this reads what the app left on disk and asks the app nothing, so a
// rename there fails every export case here with "no file", which is loud.
const EXPORT_FILES_DIR = 'bracemark-exports';

// The file an export run left, whose name starts with `prefix` — written before
// the share sheet is presented (expo-react data/export-all-data.ts). Each run
// clears the directory first, so there is one. Returned as text: the callers
// read plain-text exports.
export async function readExportFile(options: {
  platform: NativePlatform;
  deviceId: string;
  prefix: string;
}): Promise<string> {
  if (options.platform === 'android') {
    const paths = await androidAppFind(options.deviceId, [
      `cache/${EXPORT_FILES_DIR}`,
      '-maxdepth',
      '1',
      '-name',
      `${options.prefix}*`,
    ]);
    const path = paths.sort().at(-1);
    if (!path) throw new Error(`no "${options.prefix}…" file in the app’s export directory`);
    return (await androidAppBytes(options.deviceId, path)).toString('utf8');
  }

  const exports = join(
    await iosDataContainer(options.deviceId),
    'Library',
    'Caches',
    EXPORT_FILES_DIR,
  );
  const names = (await readdir(exports).catch(() => [] as string[]))
    .filter((name) => name.startsWith(options.prefix))
    .sort();
  const name = names.at(-1);
  if (!name) throw new Error(`no "${options.prefix}…" file in ${exports}`);
  return readFile(join(exports, name), 'utf8');
}

const DATABASE = 'bracemark-data.db';

export interface SandboxFile {
  // Relative to the app's data directory on Android, absolute on iOS, where the
  // containers are read in place on this Mac.
  path: string;
  bytes: number;
}

export interface SandboxScan {
  files: SandboxFile[];
  // Every (marker, file) pair where the file's bytes hold the marker.
  hits: Array<{ marker: string; path: string }>;
}

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // Symlinks are skipped, not followed: Android's `lib` points outside the
      // sandbox, and nothing the app writes is a link.
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found.sort();
}

// The whole of Android's app data directory, copied to `target` as one tar
// stream — `run-as` reads it on a debuggable build, and one stream is one
// consistent pass where a `cat` per file would be hundreds of adb round trips.
async function copyAndroidSandbox(deviceId: string, target: string): Promise<void> {
  const archive = `${target}.tar`;
  const child = spawn('adb', ['-s', deviceId, 'exec-out', runAs(['tar', '-cf', '-', '.'])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await pipeline(child.stdout, createWriteStream(archive));
  const code = await closed;
  if (code !== 0) throw new Error(`adb could not archive the app’s sandbox: ${stderr.trim()}`);
  await capture('tar', ['-xf', archive, '-C', target]);
  await unlink(archive);
}

// Every place the app can leave a file: its data container, plus on iOS the App
// Group container it shares with the share extension (the taxonomy snapshot and
// the outbox — docs/share-sheet.md).
async function iosSandboxRoots(deviceId: string): Promise<string[]> {
  const groups = await capture('xcrun', [
    'simctl',
    'get_app_container',
    deviceId,
    APP_ID,
    'groups',
  ]);
  const groupPaths = groups.stdout
    .split('\n')
    .map((line) => line.split('\t').slice(1).join('\t').trim())
    .filter(Boolean);
  return [await iosDataContainer(deviceId), ...groupPaths];
}

// Read every file in the app's sandbox and report which hold one of `markers` —
// strings a case seeded and can therefore recognise as the account's plaintext.
// It asks about the WHOLE sandbox rather than the places the app is known to
// write, which is the point: a writer nobody listed is found the same way as
// one somebody did. Both encodings a string is stored in are searched (a plist
// or a native cache may hold UTF-16).
//
// What it cannot see is bounded and worth knowing: plaintext that is compressed
// or rendered (a zip export, a decoded image, the OS's app-switcher snapshot),
// and anything the OS keeps outside the sandbox.
//
// `workDir` holds Android's copy for the length of the scan and is removed
// after it: the result names every file, and the copy is a whole dev build's
// data, account included.
export async function scanAppSandbox(options: {
  platform: NativePlatform;
  deviceId: string;
  markers: string[];
  workDir: string;
}): Promise<SandboxScan> {
  await rm(options.workDir, { recursive: true, force: true });

  let roots: string[];
  if (options.platform === 'android') {
    await mkdir(options.workDir, { recursive: true });
    await copyAndroidSandbox(options.deviceId, options.workDir);
    roots = [options.workDir];
  } else {
    roots = await iosSandboxRoots(options.deviceId);
  }

  const needles = options.markers.flatMap((marker) => [
    { marker, bytes: Buffer.from(marker, 'utf8') },
    { marker, bytes: Buffer.from(marker, 'utf16le') },
  ]);
  const scan: SandboxScan = { files: [], hits: [] };
  for (const root of roots) {
    for (const path of await walk(root)) {
      // A file the app removed between the listing and the read is not residue.
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) continue;
      const shown = options.platform === 'android' ? relative(options.workDir, path) : path;
      scan.files.push({ path: shown, bytes: bytes.byteLength });
      for (const marker of options.markers) {
        if (needles.some((needle) => needle.marker === marker && bytes.includes(needle.bytes))) {
          scan.hits.push({ marker, path: shown });
        }
      }
    }
  }
  // The store survives a sign-out as an empty file, so its absence means the
  // scan read the wrong place — and an empty scan would pass as a clean one.
  if (!scan.files.some((file) => file.path.endsWith(`/${DATABASE}`))) {
    throw new Error(`the sandbox scan found no ${DATABASE}: it did not read the app’s data`);
  }
  await rm(options.workDir, { recursive: true, force: true });
  return scan;
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
  const database = DATABASE;
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
