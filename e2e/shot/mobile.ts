import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
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

// A phone capture or a tablet capture. The tablet leg is the same four scenes on
// the `wide` device of each platform — the iPad on its side, the tablet AVD as it
// boots — and it is what the iPad and Android-tablet store listings are composed
// from. The device decides which one a run gets, so the flag is a CLAIM about the
// booted device and `verifyCaptures` holds the raster to it.
type Form = 'phone' | 'tablet';

interface Options {
  platform: Platform;
  form: Form;
  // Wipe the device and sign in again, rather than restarting the app onto the
  // session and library it already has. See mobile/shots/subflows/start.yaml for
  // which way round these are and why; the short version is that this one is for
  // the run straight after `npm run shot:account -- --fresh` rebuilt the account's data.
  fresh: boolean;
}

function selectedOptions(): Options {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const tablet = argv.includes('--tablet');
  const rest = argv.filter((arg) => arg !== '--fresh' && arg !== '--tablet');
  const platform = rest[0];
  if (rest.length !== 1 || (platform !== 'ios' && platform !== 'android')) {
    throw new Error(
      'choose one platform: `npm run shot:mobile -- ios` or `... -- android`\n' +
        '    add `--tablet` to photograph the booted iPad or tablet AVD instead of a phone\n' +
        '    add `--fresh` to wipe the device and sign in, instead of restarting the app',
    );
  }
  return { platform, form: tablet ? 'tablet' : 'phone', fresh };
}

// `mobile-` for the phone, which is what every existing consumer reads; the
// tablet's are `tablet-` beside them rather than a suffix, so a glob for one form
// can never pick up the other.
function rawPath(form: Form, platform: Platform, scene: string): string {
  return `${SHOT_OUTPUT}/${form === 'phone' ? 'mobile' : 'tablet'}-${platform}-${scene}.png`;
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

async function attachedSerial(): Promise<string> {
  const serials = (await capture('adb', ['devices']))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
  if (serials.length !== 1) {
    throw new Error(`expected exactly one attached Android device, found ${serials.length}`);
  }
  return serials[0];
}

// Maestro is told which device rather than left to pick, the same as every
// other native run (runner/native-run.ts).
async function deviceId(platform: Platform): Promise<string> {
  return platform === 'ios' ? bootedUdid() : attachedSerial();
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

// ⚠ iOS DRAWS A BREADCRUMB IN THE STATUS BAR FOR THE APP THAT HANDED OFF, and it
// is photographed with everything else. `simctl openurl` from a foreground
// Bracemark puts `◀ Bracemark` beside Safari's clock; the next run's warm start,
// launched over that Safari, puts `◀ Safari` beside the app's. Nothing fails —
// it is a frozen, correct status bar with a back-link no fresh device shows. The
// cure is to leave nothing to point back to: quit the app being left first, so
// the next one opens from SpringBoard. Terminating a process that is not running
// fails, which is the expected case on a first run.
async function quitApp(bundleId: string): Promise<void> {
  await command('xcrun', ['simctl', 'terminate', 'booted', bundleId]).catch(() => undefined);
}

// ⚠ AN OUT-OF-DATE CHROME BADGES ITS OWN MENU, AND THE AVD'S CHROME IS ALWAYS
// OUT OF DATE. The system image ships the Chrome of the day it was built and
// nothing on an emulator updates it, so a few months on Chrome swaps its ⋮ for a
// red update badge — on the tablet, where the toolbar sits above the sheet, the
// share picture photographed it. Nothing fails; it is simply a store screenshot
// that advertises a stale browser. `--force-update-menu-type=none` is Chrome's
// own switch for pinning that menu state, read from `chrome-command-line` at
// process start — and on a `release-keys` image only when Chrome is the debug
// app, which is why both are set. Hence the force-stop: a running Chrome has
// already read its flags. Checked first, so only the run that changes them pays.
const CHROME_FLAGS_FILE = '/data/local/tmp/chrome-command-line';
const CHROME_FLAGS = '_ --force-update-menu-type=none';

async function pinChromeFlags(): Promise<void> {
  const flags = await capture('adb', ['shell', 'cat', CHROME_FLAGS_FILE]).catch(() => '');
  const debugApp = await capture('adb', ['shell', 'settings', 'get', 'global', 'debug_app']);
  if (flags === CHROME_FLAGS && debugApp === 'com.android.chrome') return;
  await adbShell(['sh', '-c', `echo '${CHROME_FLAGS}' > ${CHROME_FLAGS_FILE}`]);
  await adbShell(['am', 'set-debug-app', '--persistent', 'com.android.chrome']);
  await adbShell(['am', 'force-stop', 'com.android.chrome']);
}

async function openShareSource(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await quitApp('com.bracemark.app');
    await command('xcrun', ['simctl', 'openurl', 'booted', SHARE_URL]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return;
  }

  await pinChromeFlags();

  // Put a real browser behind the translucent activity, then hand the activity
  // the same ACTION_SEND payload a chooser would. Selecting Bracemark in the
  // chooser changes no app pixels and makes this capture less repeatable.
  //
  // ⚠ ONE TAB, NAMED. A bare VIEW intent opens a NEW Chrome tab every run, and on
  // a phone nobody sees them pile up — on the tablet Chrome draws a tab strip, so
  // the share picture photographed `New tab`, then two `Job interview` tabs, then
  // three. `com.android.browser.application_id` is the browser contract for "the
  // app that opened this": Chrome reuses the tab it gave that id, so every run
  // lands in the same one.
  await adbShell([
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    SHARE_URL,
    '--es',
    'com.android.browser.application_id',
    'com.bracemark.shot',
  ]);
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

/**
 * The iPad's share capture, driven by hand.
 *
 * ⚠ ON AN iPAD MAESTRO CANNOT SEE THE SHARE SHEET. Safari's share sheet is a
 * popover and the extension a centred card, and neither is in the tree Maestro
 * reads — docs/e2e.md, _not admitted, and why: the iOS share cases_. share.yaml
 * would wait out its timeout on `share-add` with the card plainly on screen. A
 * point-tapped flow could cross it, but with nothing to wait on it would be a
 * chain of sleeps that photographs whatever state the last tap reached, and this
 * is the one kind of run whose output ships to a store listing.
 *
 * So a person brings the card to the same compose state share.yaml reaches on
 * every other device, and Maestro only presses the shutter — its screenshot, not
 * `simctl io`'s, so the raster comes out on its side like the other three.
 */
async function shareByHand(device: { platform: Platform; deviceId: string }, runDir: string) {
  console.log(
    [
      '',
      'iPad share sheet — by hand (Maestro cannot see it):',
      '  1. In Safari: More → Share → Bracemark',
      '  2. List: Interview prep',
      '  3. Tags: work, interview, thursday → Done',
      '  4. Leave the card in its compose state, Save not pressed, keyboard down',
      '',
    ].join('\n'),
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await prompt.question('Press Enter to take the picture… ');
  } finally {
    prompt.close();
  }
  await maestro('mobile/shots/shutter.yaml', {
    ...device,
    env: { SHOT: 'save-from-any-app' },
    testOutputDir: runDir,
  });
}

// ⚠ MAESTRO'S iPAD RASTER IS UPRIGHT, AND ONLY ITS METADATA SAYS IT IS NOT. Held
// on its side, the iPad's screenshots come out 2064x2752 — the panel's native
// portrait buffer, the UI turned a quarter inside it — plus an orientation tag,
// written twice: EXIF `Orientation` in an `eXIf` chunk and `tiff:Orientation` in
// the XMP `iTXt` (measured: 8, iOS 26.5, Maestro 2.8.0). Chrome, Preview and
// `sips` all honour the tag, so the file LOOKS landscape everywhere a person
// checks it, while its header says portrait to everything that reads only that
// — `verifyCaptures`, a store console. And honouring it is not the same as
// clearing it: `sips -r` on the tagged file turns the pixels AND keeps the tag,
// which every viewer then applies a second time.
//
// So: read the tag, drop both chunks, and turn the bare pixels by what it said.
// Whole chunks are length-prefixed and CRC'd individually, so removing one needs
// no re-encode. `sips` is macOS's own, and this leg only runs on a Mac (xcrun).
const ROTATE_FOR_ORIENTATION: Record<string, string | undefined> = {
  '3': '180',
  '6': '90',
  '8': '270',
};

async function bakeOrientation(file: string): Promise<void> {
  const bytes = await readFile(file);
  const kept: Buffer[] = [bytes.subarray(0, 8)];
  let orientation: string | undefined;
  for (let at = 8; at < bytes.length;) {
    const end = at + 12 + bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'iTXt') {
      orientation ??= /tiff:Orientation>(\d)</.exec(bytes.toString('latin1', at + 8, end - 4))?.[1];
    }
    if (type !== 'eXIf' && type !== 'iTXt') kept.push(bytes.subarray(at, end));
    at = end;
  }
  if (!orientation || orientation === '1') return;
  const degrees = ROTATE_FOR_ORIENTATION[orientation];
  if (!degrees) throw new Error(`${file}: a mirrored orientation (${orientation}) is not expected`);
  await writeFile(file, Buffer.concat(kept));
  await command('sips', ['-r', degrees, file]);
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('capture is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function verifyCaptures(platform: Platform, form: Form, files: string[]): Promise<void> {
  for (const file of files) {
    await access(file);
    const { width, height } = pngSize(await readFile(file));
    console.log(`  ${width}x${height}  ${file}`);
    if (form === 'tablet') {
      verifyTablet(platform, file, width, height);
      continue;
    }
    if (platform === 'android' && (width !== 1080 || height !== 2400)) {
      throw new Error(`${file}: expected the Pixel 8's 1080x2400 capture, got ${width}x${height}`);
    }
    if (platform === 'ios' && (width < 1200 || height / width < 2)) {
      throw new Error(
        `${file}: expected a full-resolution portrait iPhone capture, got ${width}x${height}`,
      );
    }
  }
}

// ⚠ THE SIZE IS THE DEVICE CHECK, and on the iPad it is a choice of device, not
// of store slot. The App Store's required iPad slot is the 13" one, but the
// picture is captured on the iPad Pro 11-inch and composed into it: the slot
// fixes the FILE's size, not the screen's, and on the 11" the same layout is
// 1210pt wide instead of 1376, so beside the fixed 280pt rail every row's type
// lands about 14% larger and the panes fill to the bottom where the 13" left
// them half-empty. Chosen side by side; the cost is a ~6% upscale. So this
// refuses anything but that iPad's own raster, on its side — a portrait one means
// the turn did not happen, and a different iPad would carry a corner and a scale
// the composition was not measured against. The AVD's 1920x1200 is
// `bracemark-tablet`'s (docs/app-drivers.md).
const IPAD_TABLET = { width: 2420, height: 1668, name: 'iPad Pro 11-inch' };

function verifyTablet(platform: Platform, file: string, width: number, height: number): void {
  if (platform === 'android' && (width !== 1920 || height !== 1200)) {
    throw new Error(
      `${file}: expected the tablet AVD’s 1920x1200 landscape capture, got ${width}x${height}`,
    );
  }
  if (platform === 'ios' && (width !== IPAD_TABLET.width || height !== IPAD_TABLET.height)) {
    throw new Error(
      `${file}: expected the ${IPAD_TABLET.name}’s ${IPAD_TABLET.width}x${IPAD_TABLET.height} ` +
        `landscape capture, got ${width}x${height} — boot that simulator, on its own`,
    );
  }
}

async function main(): Promise<void> {
  const { platform, form, fresh } = selectedOptions();
  console.log(`${platform} ${form}: ${fresh ? 'wiped cold start, then sign in' : 'warm restart'}`);
  await waitForApi();
  if (!(await findUserId(SHOT_USER.username))) {
    throw new Error(
      `no ${SHOT_USER.username} account on the local stack; run \`npm run shot:account\` first to build it`,
    );
  }

  await mkdir(SHOT_OUTPUT, { recursive: true });
  const paths = {
    onlyYou: rawPath(form, platform, 'only-you'),
    search: rawPath(form, platform, 'search-on-device'),
    listsAndTags: rawPath(form, platform, 'lists-and-tags'),
    share: rawPath(form, platform, 'save-from-any-app'),
  };
  const files = Object.values(paths);
  const runId = `${platform}-${form}-${Date.now()}`;
  const storeRun = join(SHOT_OUTPUT, 'mobile-runs', `${runId}-store`);
  const shareRun = join(SHOT_OUTPUT, 'mobile-runs', `${runId}-share`);
  const credentials = {
    USERNAME: SHOT_USER.username,
    PASSWORD: seedPassword(SHOT_USER.key),
  };

  const device = { platform, deviceId: await deviceId(platform) };
  // The flows branch on it exactly as the e2e flows do (docs/e2e.md, _narrow and
  // wide_), so the shared subflows they pull in take the same path here.
  const width = form === 'tablet' ? 'wide' : 'narrow';

  await freezeStatusBar(platform);
  try {
    if (platform === 'ios') await quitApp('com.apple.mobilesafari');
    await maestro('mobile/shots/store.yaml', {
      ...device,
      env: {
        ...credentials,
        E2E_WIDTH: width,
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
    if (platform === 'ios' && form === 'tablet') {
      await shareByHand(device, shareRun);
    } else {
      await maestro('mobile/shots/share.yaml', {
        ...device,
        env: { SAVE_FROM_ANY_APP_SHOT: 'save-from-any-app', E2E_WIDTH: width },
        testOutputDir: shareRun,
      });
    }
    await copyCaptures(shareRun, { 'save-from-any-app': paths.share });
  } finally {
    await clearStatusBar(platform).catch((error) =>
      console.warn(`could not clear ${platform} demo status bar: ${String(error)}`),
    );
  }

  if (platform === 'ios') await Promise.all(files.map(bakeOrientation));

  console.log(`\n${platform} ${form} store captures:`);
  await verifyCaptures(platform, form, files);
}

await main();
