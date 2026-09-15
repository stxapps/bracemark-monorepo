import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SHOT_OUTPUT } from '../paths';
import { maestro, waitForApi } from '../runner/lib';
import { seedPassword } from '../seed/catalog';
import { findUserId } from '../seed/plan';
import { SHOT_USER } from './library';

const run = promisify(execFile);
const SHARE_URL = 'https://en.wikipedia.org/wiki/Job_interview';
// The page's real `<title>`, because that is what a browser puts in EXTRA_SUBJECT
// and what iOS's leg gets for free — it crosses Safari's own share sheet, so its
// title comes from the page. Android's leg synthesises the intent, so anything
// shorter here would photograph the two platforms with different titles for the
// same URL.
const SHARE_TITLE = 'Job interview - Wikipedia';

type Platform = 'ios' | 'android';

interface Options {
  platform: Platform;
  // Wipe the device and sign in again, rather than restarting the app onto the
  // session and library it already has. See mobile/shots/subflows/start.yaml for
  // which way round these are and why; the short version is that this one is for
  // the run straight after `npm run shot:account -- --fresh` rebuilt the account's data.
  fresh: boolean;
}

function selectedOptions(): Options {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const rest = argv.filter((arg) => arg !== '--fresh');
  const platform = rest[0];
  if (rest.length !== 1 || (platform !== 'ios' && platform !== 'android')) {
    throw new Error(
      'choose one platform: `npm run shot:mobile -- ios` or `... -- android`\n' +
        '    add `--fresh` to wipe the device and sign in, instead of restarting the app',
    );
  }
  return { platform, fresh };
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

// `adb shell` IS NOT `execFile`, and the difference is silent. Everything after
// `shell` is JOINED WITH SPACES into one string and handed to the DEVICE's shell,
// which splits it again on whitespace — so an argv element that contains a space
// arrives as two arguments, however carefully it was passed here. That is not a
// hypothetical: `--es android.intent.extra.SUBJECT 'Job interview'` reached
// `ShareActivity` as `SUBJECT=Job` plus a stray `interview` token (which `am`
// swallowed as the intent's package), and the share capture duly photographed a
// page titled "Job" — a picture of a bug the app does not have, with nothing in
// the run that fails. Quoting each word on THIS side is the only place it can be
// fixed, because the remote shell has no argv to preserve.
async function adbShell(words: string[]): Promise<void> {
  const quoted = words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
  await command('adb', ['shell', quoted]);
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
      'discharging',
      '--batteryLevel',
      '100',
      '--cellularBars',
      '4',
      '--wifiBars',
      '3',
    ]);
    return;
  }

  await adbShell(['settings', 'put', 'global', 'sysui_demo_allowed', '1']);
  await adbShell([
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
    ['command', 'notifications', 'visible', 'false'],
    // `fully true` is the wifi icon's inet condition: without it SystemUI paints the
    // "connected, no internet" ! badge over the bars, whatever the device's real link is.
    ['command', 'network', 'wifi', 'show', 'level', '4', 'fully', 'true'],
  ]) {
    const words = ['am', 'broadcast', '-a', 'com.android.systemui.demo'];
    for (let index = 0; index < extras.length; index += 2) {
      words.push('--es', extras[index], extras[index + 1]);
    }
    await adbShell(words);
  }
}

async function clearStatusBar(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await command('xcrun', ['simctl', 'status_bar', 'booted', 'clear']);
    return;
  }
  await adbShell(['am', 'broadcast', '-a', 'com.android.systemui.demo', '--es', 'command', 'exit']);
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
  await adbShell(['am', 'start', '-a', 'android.intent.action.VIEW', '-d', SHARE_URL]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  // `--activity-clear-task`, or the SECOND run of this script gets no sheet.
  // ShareActivity declares `taskAffinity=""` (bracemark-share's AndroidManifest),
  // so each share lands in a task of its own — and that task outlives the sheet.
  // An `am start` naming the same component then MATCHES the surviving task
  // rather than launching: extras are not part of `Intent.filterEquals`, so the
  // system prints `Activity not started, its current task has been brought to the
  // front`, exits 0, and keeps the OLD intent in the record. Either the previous
  // run's payload is photographed as this one's, or — measured, on the run that
  // found this — nothing comes forward at all and the share flow times out on
  // `share-add` with a screenshot of plain Chrome. CLEAR_TASK is enough on its
  // own: there is no `--activity-new-task` option (`am help` has the list), and
  // none is needed, because the system adds NEW_TASK itself for an activity
  // launched from a shell, which is the flag CLEAR_TASK rides on.
  await adbShell([
    'am',
    'start',
    '-a',
    'android.intent.action.SEND',
    '-t',
    'text/plain',
    '-n',
    'com.bracemark.app/com.bracemark.share.ShareActivity',
    '--activity-clear-task',
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
  const { platform, fresh } = selectedOptions();
  console.log(`${platform}: ${fresh ? 'wiped cold start, then sign in' : 'warm restart'}`);
  await waitForApi();
  if (!(await findUserId(SHOT_USER.username))) {
    throw new Error(
      `no ${SHOT_USER.username} account on the local stack; run \`npm run shot:account\` first to build it`,
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
        // Passed on every run, never defaulted in the flow: a Maestro `env:`
        // block beats `-e` rather than yielding to it (start.yaml, last note).
        FRESH: String(fresh),
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
