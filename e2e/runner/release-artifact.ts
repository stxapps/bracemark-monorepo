import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { type NativePlatform } from './cli';
import { STAGING_ORIGINS } from './environment';
import { capture } from './process';

export interface ReleaseReceipt {
  schemaVersion: 1;
  environment: 'staging';
  configuration: 'Release';
  platform: NativePlatform;
  artifact: string;
  sha256: string;
  api: string;
  site: string;
  builtAt: string;
  checkout: { commit: string; dirty: boolean };
  mapping?: { path: string; sha256: string };
}

export function assertStagingBundle(bundle: Uint8Array): void {
  const text = Buffer.from(bundle).toString('latin1');
  if (!text.includes(STAGING_ORIGINS.api) || !text.includes(STAGING_ORIGINS.site)) {
    throw new Error('embedded release bundle does not name the staging API and marketing site');
  }
  if (text.includes('https://api.bracemark.com') || text.includes('http://localhost:8787')) {
    throw new Error('embedded release bundle still names a production or local API');
  }
}

export async function assertIosSimulatorSigning(artifact: string): Promise<void> {
  // An unsigned simulator app can launch but SecureStore fails with -34018.
  // Verify the app and nested extension/frameworks before issuing a receipt or
  // admitting a run. Xcode supplies the simulator entitlements when signing.
  await capture('codesign', ['--verify', '--deep', '--strict', artifact], {
    timeoutMs: 30_000,
  });
}

// Hash the entire app, including embedded frameworks and share extension, with
// sorted relative names and symlink targets. Installation paths do not affect it.
export async function artifactHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const root = await lstat(path);
  if (root.isFile()) return hash.update(await readFile(path)).digest('hex');
  if (!root.isDirectory())
    throw new Error('release artifact must be an APK file or .app directory');
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const child = join(directory, name);
      const stat = await lstat(child);
      hash.update(JSON.stringify(relative(path, child)));
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(child)}`);
      else if (stat.isDirectory()) {
        hash.update('directory');
        await walk(child);
      } else if (stat.isFile()) {
        hash.update(`file:${stat.size}:`);
        hash.update(await readFile(child));
      } else throw new Error(`unsupported release artifact entry: ${child}`);
    }
  }
  await walk(path);
  return hash.digest('hex');
}

function receiptFile(receiptPath: string, value: unknown): string {
  if (typeof value !== 'string' || !value || isAbsolute(value)) {
    throw new Error('receipt artifact paths must be relative to the receipt');
  }
  const root = dirname(resolve(receiptPath));
  const file = resolve(root, value);
  if (relative(root, file).startsWith('..'))
    throw new Error('receipt artifact escapes its directory');
  return file;
}

export async function readReleaseReceipt(
  path: string,
  platform: NativePlatform,
): Promise<{ receipt: ReleaseReceipt; artifact: string }> {
  const receipt = JSON.parse(await readFile(path, 'utf8')) as ReleaseReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.environment !== 'staging' ||
    receipt.configuration !== 'Release' ||
    receipt.platform !== platform ||
    receipt.api !== STAGING_ORIGINS.api ||
    receipt.site !== STAGING_ORIGINS.site ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    !receipt.checkout?.commit ||
    !receipt.builtAt
  )
    throw new Error('invalid staging Release receipt; build with build-release:staging');
  const artifact = receiptFile(path, receipt.artifact);
  if (!artifact.endsWith(platform === 'android' ? '.apk' : '.app')) {
    throw new Error('release artifact has the wrong platform format');
  }
  if ((await artifactHash(artifact)) !== receipt.sha256)
    throw new Error('release artifact hash changed');
  if (platform === 'android') {
    if (!receipt.mapping) throw new Error('Android release receipt is missing its R8 mapping');
    const mapping = receiptFile(path, receipt.mapping.path);
    if ((await artifactHash(mapping)) !== receipt.mapping.sha256)
      throw new Error('R8 mapping hash changed');
    if (!(await readFile(mapping, 'utf8')).includes('# compiler: R8')) {
      throw new Error('mapping does not identify the R8 compiler');
    }
  }
  return { receipt, artifact };
}

export async function assertInstalledRelease(options: {
  receiptPath: string;
  platform: NativePlatform;
  deviceId: string;
  installPath: string;
  workDir: string;
}): Promise<ReleaseReceipt> {
  const { receipt } = await readReleaseReceipt(options.receiptPath, options.platform);
  let installed = options.installPath;
  if (options.platform === 'android') {
    const dump = (
      await capture(
        'adb',
        ['-s', options.deviceId, 'shell', 'dumpsys', 'package', 'com.bracemark.app'],
        { timeoutMs: 15_000 },
      )
    ).stdout;
    if (/\bDEBUGGABLE\b/.test(dump))
      throw new Error('installed Android app is debuggable, not Release');
    // APKs are publicly readable; run-as (which release refuses) is unnecessary.
    installed = join(options.workDir, 'installed.apk');
    await capture('adb', ['-s', options.deviceId, 'pull', options.installPath, installed], {
      timeoutMs: 90_000,
    });
  }
  if ((await artifactHash(installed)) !== receipt.sha256) {
    throw new Error(
      'installed app differs from the staging Release artifact; install that artifact first',
    );
  }
  if (options.platform === 'ios') await assertIosSimulatorSigning(installed);
  return receipt;
}
