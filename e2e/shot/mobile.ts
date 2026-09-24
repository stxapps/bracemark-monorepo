import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SHOT_OUTPUT } from '../paths';
import { maestro, waitForApi } from '../runner/lib';
import {
  clearStatusBar as clearDeviceStatusBar,
  freezeStatusBar as freezeDeviceStatusBar,
} from '../runner/status-bar';
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

// ⚠ THE REGION IS PART OF THE PICTURE, AND IT IS INHERITED FROM THE MAC.
//
// `simctl status_bar override --time 9:41` does not draw the string it is given —
// it draws that time FORMATTED BY THE DEVICE'S REGION. A simulator created on a
// Mac set to a 24-hour region renders Apple's own convention as `09:41`, in every
// App Store screenshot, and nothing in the run fails: the flag was accepted, the
// clock is frozen, the time is even correct. It is only wrong in the one way a
// store listing is judged on.
//
// Measured on iOS 26.5, isolating one key at a time:
//
//   AppleLocale=en_TH  →  09:41      AppleLocale=en_US  →  9:41
//
// `AppleLocale` alone is the lever. `AppleICUForce12HourTime` does nothing here
// and `AppleLanguages` is not involved — both were tried and neither moved it.
// ⚠ AND A RESPRING IS NOT ENOUGH: `launchctl stop com.apple.SpringBoard` leaves
// the old format in place, because SpringBoard reads the region once at launch.
// The device has to be shut down and booted. That is why this is pinned here
// rather than left to whoever set up the machine — the alternative is a capture
// that is correct on one clone and wrong on the other, with no way to tell from
// the file which one took it.
//
// `simctl` accepts only `H:mm` for `--time`: `9:41 AM` and a full ISO string are
// both rejected outright (NSPOSIXErrorDomain 22), so there is no format that
// sidesteps the region.
const SHOT_LOCALE = 'en_US';

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

async function capture(file: string, args: string[]): Promise<string> {
  const { stdout } = await run(file, args, { maxBuffer: 1 << 20 });
  return stdout.trim();
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

async function bootedUdid(): Promise<string> {
  const listed = JSON.parse(await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  const booted: { udid: string; name: string }[] = Object.values(listed.devices).flat() as never;
  if (booted.length !== 1) {
    throw new Error(
      `expected exactly one booted simulator, found ${booted.length}` +
        `${booted.map((d) => `\n    ${d.name}`).join('')}`,
    );
  }
  return booted[0].udid;
}

/**
 * Pin the simulator's region so the frozen clock reads 9:41. See SHOT_LOCALE.
 *
 * Free on every run after the first: the check is a `defaults read`, and the
 * expensive half — shut down, boot, wait — happens only on a device that has not
 * been pinned yet. Which means a fresh machine pays one reboot and then behaves
 * like a machine that was always set up correctly.
 */
async function pinClockRegion(): Promise<void> {
  const udid = await bootedUdid();
  const current = await capture('xcrun', [
    'simctl',
    'spawn',
    udid,
    'defaults',
    'read',
    '-g',
    'AppleLocale',
  ]).catch(() => '');
  if (current === SHOT_LOCALE) return;

  console.log(`  region ${current || '(unset)'} → ${SHOT_LOCALE}; rebooting to apply it`);
  await command('xcrun', [
    'simctl',
    'spawn',
    udid,
    'defaults',
    'write',
    '-g',
    'AppleLocale',
    '-string',
    SHOT_LOCALE,
  ]);
  await command('xcrun', ['simctl', 'shutdown', udid]);
  await command('xcrun', ['simctl', 'boot', udid]);
  await command('xcrun', ['simctl', 'bootstatus', udid, '-b']);
}

// The freeze itself — and the demo-mode leak it has to step around — is shared
// with the visual checkpoints (runner/status-bar.ts). What stays here is the
// region pin, which only a published capture needs.
async function freezeStatusBar(platform: Platform): Promise<void> {
  if (platform === 'ios') await pinClockRegion();
  await freezeDeviceStatusBar(platform, undefined);
}

async function clearStatusBar(platform: Platform): Promise<void> {
  await clearDeviceStatusBar(platform, undefined);
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
