import { createServer, type Server } from 'node:http';

import { type NativePlatform } from './cli';
import { capture } from './process';

const APP_ID = 'com.bracemark.app';
const SHARE_ACTIVITY = 'com.bracemark.app/com.bracemark.share.ShareActivity';

export async function startPlainTextShareSource(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plain text share fixture</title>
<button id="share" style="font: 20px system-ui; margin: 40px; padding: 16px"
  onclick="navigator.share({ text: 'Plain text without a link' })">
  Share plain text
</button>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('plain-text share fixture did not acquire a TCP port');
  }
  return {
    url: `http://localhost:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// `adb shell` receives one command string and re-splits it on the device. Quote
// every word here so a multi-word EXTRA_SUBJECT remains one value there
// (docs/app-drivers.md, _adb shell has no argv_).
async function adbShell(deviceId: string, words: string[], allowFailure = false): Promise<string> {
  const command = words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
  return (
    await capture('adb', ['-s', deviceId, 'shell', command], {
      allowFailure,
    })
  ).stdout.trim();
}

export async function openSystemShare(options: {
  platform: NativePlatform;
  deviceId: string;
  sourceUrl: string;
  sharedText?: string;
  title?: string;
}): Promise<void> {
  const { platform, deviceId, sourceUrl, sharedText = sourceUrl, title } = options;

  if (platform === 'ios') {
    // Safari is the producer. The committed Maestro part crosses its system
    // share sheet and proves arrival with an extension-only testID.
    await capture('xcrun', ['simctl', 'openurl', deviceId, sourceUrl]);
    return;
  }

  // Deliver the real ACTION_SEND directly. A browser behind the translucent
  // activity adds no boundary coverage and a fresh emulator's Chrome onboarding
  // can block the intent with an unrelated first-run/ANR surface. CLEAR_TASK is
  // required because ShareActivity has an empty task affinity and a surviving
  // prior task otherwise swallows new extras while `am start` still exits zero
  // (docs/app-drivers.md).
  const words = [
    'am',
    'start',
    '-a',
    'android.intent.action.SEND',
    '-t',
    'text/plain',
    '-n',
    SHARE_ACTIVITY,
    '--activity-clear-task',
    '--es',
    'android.intent.extra.TEXT',
    sharedText,
  ];
  if (title) words.push('--es', 'android.intent.extra.SUBJECT', title);
  await adbShell(deviceId, words);
}

export async function mainAppPid(
  platform: NativePlatform,
  deviceId: string,
): Promise<string | null> {
  if (platform === 'android') {
    const value = await adbShell(deviceId, ['pidof', APP_ID], true);
    return value || null;
  }

  // A stopped UIKit service remains registered with launchd but carries `-` in
  // the PID column. Match the app bundle exactly enough to exclude the
  // com.bracemark.app.ShareExtension process that this suite intentionally opens.
  const listed = (
    await capture('xcrun', ['simctl', 'spawn', deviceId, 'launchctl', 'list'])
  ).stdout;
  const pids = listed
    .split('\n')
    .filter(
      (line) =>
        /com\.bracemark\.app(?:\[|\s|$)/.test(line) &&
        !line.includes('com.bracemark.app.ShareExtension'),
    )
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((pid) => /^\d+$/.test(pid));
  return pids.length > 0 ? pids.join(',') : null;
}

export async function assertMainAppStopped(
  platform: NativePlatform,
  deviceId: string,
  boundary: string,
): Promise<void> {
  const pid = await mainAppPid(platform, deviceId);
  if (pid !== null) throw new Error(`${boundary}: ${APP_ID} is still running as ${pid}`);
}
