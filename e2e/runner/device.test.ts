import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isFullScreenApps,
  parseAttachedAndroid,
  parseBootedSimulators,
  pickDevice,
} from './device';

const SIMULATORS = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'AAAA-1', name: 'iPhone 17', state: 'Booted' },
      { udid: 'AAAA-2', name: 'iPad Air', state: 'Shutdown' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [],
  },
});

const ADB = [
  'List of devices attached',
  'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1',
  'emulator-5556          offline transport_id:2',
  'R58M123ABC             unauthorized usb:1-1 transport_id:3',
  '',
].join('\n');

test('only a booted simulator and a ready adb device count as available', () => {
  assert.deepEqual(parseBootedSimulators(SIMULATORS), [{ id: 'AAAA-1', name: 'iPhone 17' }]);
  assert.deepEqual(parseAttachedAndroid(ADB), [
    { id: 'emulator-5554', name: 'sdk_gphone64_arm64' },
  ]);
  assert.deepEqual(parseAttachedAndroid('List of devices attached\n\n'), []);
});

test('a device is defaulted only when there is exactly one, and never chosen between two', () => {
  const one = [{ id: 'AAAA-1', name: 'iPhone 17' }];
  const two = [...one, { id: 'AAAA-2', name: 'iPad Air' }];
  assert.equal(pickDevice('ios', undefined, one), 'AAAA-1');
  // An explicit id is passed through even when it is not in the listing: the
  // preflight owns "is not booted", with the id in its message.
  assert.equal(pickDevice('ios', 'ZZZZ', two), 'ZZZZ');
  assert.throws(() => pickDevice('ios', undefined, []), /no booted iOS simulator/);
  assert.throws(() => pickDevice('android', undefined, []), /no attached Android device/);
  assert.throws(
    () => pickDevice('ios', undefined, two),
    /pass --device <id>[\s\S]*AAAA-2 {2}iPad Air/,
  );
});

test('only an iPad that has chosen Full Screen Apps counts as full screen', () => {
  assert.equal(isFullScreenApps('0', '0'), true);
  assert.equal(isFullScreenApps('1', '0'), false); // Windowed Apps
  assert.equal(isFullScreenApps('0', '1'), false); // Stage Manager
  assert.equal(isFullScreenApps('', ''), false); // as a simulator comes: Windowed Apps
});

test('a width picks the one device on its side of 768, and names what to boot when none is', () => {
  const iphone = { id: 'AAAA-1', name: 'iPhone 17', width: 'narrow' as const };
  const ipad = { id: 'AAAA-2', name: 'iPad (A16)', width: 'wide' as const };
  const mini = { id: 'AAAA-3', name: 'iPad mini (A17 Pro)', width: 'narrow' as const };
  // An iPhone and an iPad up together need no --device.
  assert.equal(pickDevice('ios', undefined, [iphone, ipad], 'narrow'), 'AAAA-1');
  assert.equal(pickDevice('ios', undefined, [iphone, ipad], 'wide'), 'AAAA-2');
  assert.throws(
    () => pickDevice('ios', undefined, [iphone, mini], 'wide'),
    /no wide booted iOS simulator: boot an iPad 768pt[\s\S]*AAAA-3 {2}iPad mini \(A17 Pro\) {2}\(narrow\)/,
  );
  assert.throws(
    () => pickDevice('ios', undefined, [iphone, mini], 'narrow'),
    /2 narrow booted iOS simulators; pass --device/,
  );
  assert.throws(
    () =>
      pickDevice(
        'android',
        undefined,
        [{ id: 'emulator-5554', name: 'p', width: 'narrow' }],
        'wide',
      ),
    /boot the bracemark-tablet AVD/,
  );
});
