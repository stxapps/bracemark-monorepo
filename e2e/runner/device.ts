import { join } from 'node:path';

import { type NativePlatform } from './cli';
import { IS_STAGING } from './environment';
import { capture } from './process';
import { androidShortSide, type E2EWidth, iosShortSide, WIDTH_DEVICES, widthOf } from './width';

export interface BootedDevice {
  id: string;
  name: string;
  // Its upright width (runner/width.ts); read only when a run asks for one.
  width?: E2EWidth;
}

export function parseBootedSimulators(json: string): BootedDevice[] {
  return bootedSimulators(json).map((device) => ({ id: device.udid, name: device.name }));
}

// `adb devices -l`: a header, then `<serial> <state> key:value…`. Only `device`
// is usable — `offline` and `unauthorized` are attached and cannot be driven.
export function parseAttachedAndroid(listing: string): BootedDevice[] {
  return listing
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial, , ...details]) => ({
      id: serial,
      name: details.find((detail) => detail.startsWith('model:'))?.slice('model:'.length) ?? serial,
    }));
}

const KIND = { ios: 'booted iOS simulator', android: 'attached Android device' } as const;
const LIST = { ios: 'xcrun simctl list devices booted', android: 'adb devices' } as const;

function listing(devices: BootedDevice[]): string {
  return devices
    .map(
      (device) => `\n    ${device.id}  ${device.name}${device.width ? `  (${device.width})` : ''}`,
    )
    .join('');
}

// `--device` wins untouched; the preflight (native-run.ts) is what proves it is
// booted, and at the width asked for. Without it the run takes the ONE device
// this platform has up — of that width, when the run names one — and never
// chooses between two: a result has to say which runtime it exercised, and the
// manifest records the device either way. The width is what lets an iPhone and
// an iPad be up together without a `--device`.
export function pickDevice(
  platform: NativePlatform,
  requested: string | undefined,
  available: BootedDevice[],
  width?: E2EWidth,
): string {
  if (requested) return requested;
  const candidates = width ? available.filter((device) => device.width === width) : available;
  if (candidates.length === 1) return candidates[0].id;
  if (available.length === 0) {
    throw new Error(
      `no ${KIND[platform]} (\`${LIST[platform]}\`). ` +
        (IS_STAGING
          ? 'Boot one, install the staging Release artifact on it'
          : `Start one with the development build installed — \`npm run expo:${platform}\` —`) +
        ' and retry.',
    );
  }
  if (candidates.length === 0) {
    throw new Error(
      `no ${width} ${KIND[platform]}: boot ${WIDTH_DEVICES[platform][width as E2EWidth]}. Up now:` +
        listing(available),
    );
  }
  throw new Error(
    `${candidates.length} ${width ? `${width} ` : ''}${KIND[platform]}s; ` +
      'pass --device <id> to choose one:' +
      listing(candidates),
  );
}

interface DeviceType {
  identifier: string;
  bundlePath: string;
}

async function iosDeviceTypes(): Promise<DeviceType[]> {
  const result = await capture('xcrun', ['simctl', 'list', 'devicetypes', '--json']);
  return (JSON.parse(result.stdout) as { devicetypes: DeviceType[] }).devicetypes;
}

// A simulator's upright width, from its device type's profile — the screen it
// boots with, whatever way up Simulator is holding it.
async function iosWidth(deviceTypeIdentifier: string, types: DeviceType[]): Promise<E2EWidth> {
  const type = types.find((candidate) => candidate.identifier === deviceTypeIdentifier);
  if (!type) throw new Error(`unknown simulator device type ${deviceTypeIdentifier}`);
  const profile = join(type.bundlePath, 'Contents', 'Resources', 'profile.plist');
  const json = await capture('plutil', ['-convert', 'json', '-o', '-', profile]);
  const parsed = JSON.parse(json.stdout) as Parameters<typeof iosShortSide>[0];
  return widthOf(iosShortSide(parsed));
}

async function androidWidth(deviceId: string): Promise<E2EWidth> {
  const shell = async (...args: string[]) =>
    (await capture('adb', ['-s', deviceId, 'shell', ...args], { timeoutMs: 15_000 })).stdout;
  const [size, density] = await Promise.all([shell('wm', 'size'), shell('wm', 'density')]);
  return widthOf(androidShortSide(size, density));
}

interface ListedSimulator {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
}

function bootedSimulators(json: string): ListedSimulator[] {
  const listed = JSON.parse(json) as { devices: Record<string, ListedSimulator[]> };
  return Object.values(listed.devices)
    .flat()
    .filter((device) => device.state === 'Booted');
}

// One device's upright width — the preflight's check that a `--device` the run
// was handed is at the width it runs at.
export async function deviceWidth(platform: NativePlatform, deviceId: string): Promise<E2EWidth> {
  if (platform === 'android') return androidWidth(deviceId);
  const listed = bootedSimulators(
    (await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])).stdout,
  ).find((device) => device.udid === deviceId);
  if (!listed) throw new Error(`iOS device ${deviceId} is not booted`);
  return iosWidth(listed.deviceTypeIdentifier, await iosDeviceTypes());
}

// iPadOS's multitasking mode, from the two SpringBoard defaults Settings writes
// (docs/app-drivers.md, _the iPad simulator_): Full Screen Apps is both 0. A
// default that is missing has never been written, which is how a simulator comes,
// and that simulator is in Windowed Apps.
export function isFullScreenApps(medusa: string, chamois: string): boolean {
  return medusa === '0' && chamois === '0';
}

export async function iosFullScreenApps(deviceId: string): Promise<boolean> {
  const read = async (key: string) => {
    const defaults = ['spawn', deviceId, 'defaults', 'read', 'com.apple.springboard', key];
    return (await capture('xcrun', ['simctl', ...defaults], { allowFailure: true })).stdout.trim();
  };
  return isFullScreenApps(
    await read('SBMedusaMultitaskingEnabled'),
    await read('SBChamoisWindowingEnabled'),
  );
}

export async function resolveDevice(
  platform: NativePlatform,
  requested: string | undefined,
  width?: E2EWidth,
): Promise<string> {
  if (requested) return requested;
  let available: BootedDevice[];
  if (platform === 'ios') {
    const json = (await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])).stdout;
    const types = width ? await iosDeviceTypes() : [];
    available = await Promise.all(
      bootedSimulators(json).map(async (device) => ({
        id: device.udid,
        name: device.name,
        width: width ? await iosWidth(device.deviceTypeIdentifier, types) : undefined,
      })),
    );
  } else {
    const attached = parseAttachedAndroid(
      (await capture('adb', ['devices', '-l'], { timeoutMs: 15_000 })).stdout,
    );
    available = await Promise.all(
      attached.map(async (device) => ({
        ...device,
        width: width ? await androidWidth(device.id) : undefined,
      })),
    );
  }
  const deviceId = pickDevice(platform, undefined, available, width);
  const device = available.find((candidate) => candidate.id === deviceId);
  console.log(
    `using the one ${width ? `${width} ` : ''}${KIND[platform]}: ${device?.name} (${deviceId})`,
  );
  return deviceId;
}
