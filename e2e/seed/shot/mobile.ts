import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SHOT_OUTPUT } from '../../paths';
import { maestro, waitForApi } from '../../runner/lib';
import { seedPassword } from '../catalog';
import { findUserId } from '../plan';
import { SHOT_USER } from './library';

const run = promisify(execFile);
const SHARE_URL = 'https://en.wikipedia.org/wiki/Job_interview';
const SHARE_TITLE = 'Job interview';

type Platform = 'ios' | 'android';

function selectedPlatform(): Platform {
  const value = process.argv[2];
  if (value === 'ios' || value === 'android') return value;
  throw new Error('choose one platform: `npm run shot:mobile -- ios` or `... -- android`');
}

function rawPath(platform: Platform, scene: string): string {
  return `${SHOT_OUTPUT}/mobile-${platform}-${scene}.png`;
}

async function maestroCapture(runDir: string, name: string): Promise<string> {
  // Maestro nests artifacts under a timestamp and flow name even when a custom
  // test output directory is supplied. Resolve the named screenshot rather than
  // depending on either generated directory.
  const suffix = `takeScreenshot/${name}.png`;
  const matches = (await readdir(runDir, { recursive: true })).filter((file) =>
    file.endsWith(suffix),
  );
  if (matches.length !== 1) {
    throw new Error(`${runDir}: expected one ${suffix}, found ${matches.length}`);
  }
  return join(runDir, matches[0]);
}

async function copyCaptures(runDir: string, captures: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(captures).map(async ([name, destination]) =>
      copyFile(await maestroCapture(runDir, name), destination),
    ),
  );
}

async function command(file: string, args: string[]): Promise<void> {
  await run(file, args, { maxBuffer: 1 << 20 });
}

async function freezeStatusBar(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await command('xcrun', [
      'simctl',
      'status_bar',
      'booted',
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
      '--cellularBars',
      '4',
      '--wifiBars',
      '3',
    ]);
    return;
  }

  await command('adb', ['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
  await command('adb', [
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '--es',
    'command',
    'enter',
  ]);
  for (const extras of [
    ['command', 'clock', 'hhmm', '0941'],
    ['command', 'battery', 'level', '100', 'plugged', 'false'],
    ['command', 'network', 'wifi', 'show', 'level', '4'],
  ]) {
    const args = ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo'];
    for (let index = 0; index < extras.length; index += 2) {
      args.push('--es', extras[index], extras[index + 1]);
    }
    await command('adb', args);
  }
}

async function clearStatusBar(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await command('xcrun', ['simctl', 'status_bar', 'booted', 'clear']);
    return;
  }
  await command('adb', [
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '--es',
    'command',
    'exit',
  ]);
}

async function openShareSource(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await command('xcrun', ['simctl', 'openurl', 'booted', SHARE_URL]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return;
  }

  // Put a real browser behind the translucent activity, then hand the activity
  // the same ACTION_SEND payload a chooser would. Selecting Bracemark in the
  // chooser changes no app pixels and makes this capture less repeatable.
  await command('adb', [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    SHARE_URL,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await command('adb', [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.SEND',
    '-t',
    'text/plain',
    '-n',
    'com.bracemark.app/com.bracemark.share.ShareActivity',
    '--es',
    'android.intent.extra.TEXT',
    SHARE_URL,
    '--es',
    'android.intent.extra.SUBJECT',
    SHARE_TITLE,
  ]);
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('capture is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function verifyCaptures(platform: Platform, files: string[]): Promise<void> {
  for (const file of files) {
    await access(file);
    const { width, height } = pngSize(await readFile(file));
    if (platform === 'android' && (width !== 1080 || height !== 2400)) {
      throw new Error(`${file}: expected the Pixel 8's 1080x2400 capture, got ${width}x${height}`);
    }
    if (platform === 'ios' && (width < 1200 || height / width < 2)) {
      throw new Error(
        `${file}: expected a full-resolution portrait iPhone capture, got ${width}x${height}`,
      );
    }
    console.log(`  ${width}x${height}  ${file}`);
  }
}

async function main(): Promise<void> {
  const platform = selectedPlatform();
  await waitForApi();
  if (!(await findUserId(SHOT_USER.username))) {
    throw new Error(
      `no ${SHOT_USER.username} account on the local stack; run \`npm run shot\` first to build it`,
    );
  }

  await mkdir(SHOT_OUTPUT, { recursive: true });
  const paths = {
    onlyYou: rawPath(platform, 'only-you'),
    search: rawPath(platform, 'search-on-device'),
    listsAndTags: rawPath(platform, 'lists-and-tags'),
    share: rawPath(platform, 'save-from-any-app'),
  };
  const files = Object.values(paths);
  const runId = `${platform}-${Date.now()}`;
  const storeRun = join(SHOT_OUTPUT, 'mobile-runs', `${runId}-store`);
  const shareRun = join(SHOT_OUTPUT, 'mobile-runs', `${runId}-share`);
  const credentials = {
    USERNAME: SHOT_USER.username,
    PASSWORD: seedPassword(SHOT_USER.key),
  };

  await freezeStatusBar(platform);
  try {
    await maestro('mobile/shots/store.yaml', {
      env: {
        ...credentials,
        ONLY_YOU_SHOT: 'only-you',
        SEARCH_SHOT: 'search-on-device',
        LISTS_AND_TAGS_SHOT: 'lists-and-tags',
      },
      testOutputDir: storeRun,
    });
    await copyCaptures(storeRun, {
      'only-you': paths.onlyYou,
      'search-on-device': paths.search,
      'lists-and-tags': paths.listsAndTags,
    });

    await openShareSource(platform);
    await maestro('mobile/shots/share.yaml', {
      env: { SAVE_FROM_ANY_APP_SHOT: 'save-from-any-app' },
      testOutputDir: shareRun,
    });
    await copyCaptures(shareRun, { 'save-from-any-app': paths.share });
  } finally {
    await clearStatusBar(platform).catch((error) =>
      console.warn(`could not clear ${platform} demo status bar: ${String(error)}`),
    );
  }

  console.log(`\n${platform} mobile-store captures:`);
  await verifyCaptures(platform, files);
}

await main();
