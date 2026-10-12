import { type NativePlatform } from './cli';
import { IS_STAGING } from './environment';
import { capture } from './process';

export interface BootedDevice {
  id: string;
  name: string;
}

export function parseBootedSimulators(json: string): BootedDevice[] {
  const listed = JSON.parse(json) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
  };
  return Object.values(listed.devices)
    .flat()
    .filter((device) => device.state === 'Booted')
    .map((device) => ({ id: device.udid, name: device.name }));
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

// `--device` wins untouched; the preflight (native-run.ts) is what proves it is
// booted. Without it the run takes the ONE device this platform has up and never
// chooses between two: a result has to say which runtime it exercised, and the
// manifest records the device either way.
export function pickDevice(
  platform: NativePlatform,
  requested: string | undefined,
  available: BootedDevice[],
): string {
  if (requested) return requested;
  if (available.length === 1) return available[0].id;
  if (available.length === 0) {
    throw new Error(
      `no ${KIND[platform]} (\`${LIST[platform]}\`). ` +
        (IS_STAGING
          ? 'Boot one, install the staging Release artifact on it'
          : `Start one with the development build installed — \`npm run expo:${platform}\` —`) +
        ' and retry.',
    );
  }
  throw new Error(
    `${available.length} ${KIND[platform]}s; pass --device <id> to choose one:` +
      available.map((device) => `\n    ${device.id}  ${device.name}`).join(''),
  );
}

export async function resolveDevice(
  platform: NativePlatform,
  requested: string | undefined,
): Promise<string> {
  if (requested) return requested;
  const listing =
    platform === 'ios'
      ? parseBootedSimulators(
          (await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])).stdout,
        )
      : parseAttachedAndroid(
          (await capture('adb', ['devices', '-l'], { timeoutMs: 15_000 })).stdout,
        );
  const deviceId = pickDevice(platform, undefined, listing);
  const device = listing.find((candidate) => candidate.id === deviceId);
  console.log(`using the one ${KIND[platform]}: ${device?.name} (${deviceId})`);
  return deviceId;
}
