import { type NativePlatform } from './cli';
import { adbShell, capture } from './process';
import { type Appearance } from './visual-catalog';

// The device-wide settings a visual checkpoint varies: the system appearance
// and the text size. Both are the OS's, not the app's — a fresh account's theme
// is `system` (DEFAULT_THEME, docs/theme.md), so the app follows the flip the
// way it follows a person's Control Centre toggle, through Uniwind's own
// `Appearance` listener. Nothing here touches the app's settings.
//
// Every setter reads the value back and throws if the device did not take it:
// a capture labelled `dark` of a light screen is the failure this whole module
// exists to rule out, and the comparison only catches it after the fact.

// The raw values, exactly as each platform reports them, so a run can put back
// what it found — Android's `auto`, iOS's `extra-large`, whatever a person set.
export interface DeviceLook {
  appearance: string;
  textSize: string;
}

async function readRaw(platform: NativePlatform, deviceId: string): Promise<DeviceLook> {
  if (platform === 'ios') {
    const [appearance, textSize] = await Promise.all([
      capture('xcrun', ['simctl', 'ui', deviceId, 'appearance']),
      capture('xcrun', ['simctl', 'ui', deviceId, 'content_size']),
    ]);
    return { appearance: appearance.stdout.trim(), textSize: textSize.stdout.trim() };
  }
  const night = await adbShell(deviceId, ['cmd', 'uimode', 'night']);
  const scale = await adbShell(deviceId, ['settings', 'get', 'system', 'font_scale']);
  // "Night mode: yes" — the value after the colon is what `night` takes back.
  return { appearance: night.replace(/^Night mode:\s*/, ''), textSize: scale };
}

export async function readDeviceLook(
  platform: NativePlatform,
  deviceId: string,
): Promise<DeviceLook> {
  return await readRaw(platform, deviceId);
}

async function writeAppearance(platform: NativePlatform, deviceId: string, raw: string) {
  if (platform === 'ios') await capture('xcrun', ['simctl', 'ui', deviceId, 'appearance', raw]);
  else await adbShell(deviceId, ['cmd', 'uimode', 'night', raw]);
}

async function writeTextSize(platform: NativePlatform, deviceId: string, raw: string) {
  if (platform === 'ios') {
    await capture('xcrun', ['simctl', 'ui', deviceId, 'content_size', raw]);
  } else {
    await adbShell(deviceId, ['settings', 'put', 'system', 'font_scale', raw]);
  }
}

// Live on both platforms: iOS posts a trait change, and Android's MainActivity
// declares `uiMode` in its configChanges, so the activity is re-themed rather
// than recreated and the screen under test stays where the flow left it.
export async function setAppearance(
  platform: NativePlatform,
  deviceId: string,
  appearance: Appearance,
): Promise<void> {
  const raw = platform === 'ios' ? appearance : appearance === 'dark' ? 'yes' : 'no';
  await writeAppearance(platform, deviceId, raw);
  const read = (await readRaw(platform, deviceId)).appearance;
  if (read !== raw) {
    throw new Error(`${platform} ${deviceId}: asked for ${appearance} appearance, reads ${read}`);
  }
}

// ⚠ NOT live on Android: `fontScale` is not in MainActivity's configChanges, so a
// change recreates the activity under whatever the flow was doing. Set it
// before a case's cold launch, never in the middle of one. And on Android every
// write is a configuration change, which is what leaks a second wifi icon into
// a frozen status bar — re-freeze after it (runner/status-bar.ts).
export async function setTextSize(
  platform: NativePlatform,
  deviceId: string,
  raw: string,
): Promise<void> {
  await writeTextSize(platform, deviceId, raw);
  const read = (await readRaw(platform, deviceId)).textSize;
  // Android echoes back what it stored, which may gain a trailing ".0".
  if (read !== raw && Number(read) !== Number(raw)) {
    throw new Error(`${platform} ${deviceId}: asked for text size ${raw}, reads ${read}`);
  }
}

export async function restoreDeviceLook(
  platform: NativePlatform,
  deviceId: string,
  look: DeviceLook,
): Promise<void> {
  await writeAppearance(platform, deviceId, look.appearance);
  const current = await readRaw(platform, deviceId);
  if (current.textSize !== look.textSize) await writeTextSize(platform, deviceId, look.textSize);
}
