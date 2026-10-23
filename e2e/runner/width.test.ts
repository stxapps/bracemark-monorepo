import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expectedCaptures, IOS_SHARE_CHECKPOINTS } from './visual-catalog';
import { androidShortSide, type E2EWidth, iosShortSide, widthOf, wmDensity, wmSize } from './width';

test('the upright width decides the side of 768: phones and the iPad mini narrow, tablets wide', () => {
  // `adb shell wm size` / `wm density`, as the two AVDs print them.
  const pixel8 = androidShortSide('Physical size: 1080x2400\n', 'Physical density: 420\n');
  const tablet = androidShortSide('Physical size: 1920x1200\n', 'Physical density: 240\n');
  assert.equal(pixel8, 411);
  assert.equal(tablet, 800);
  assert.equal(widthOf(pixel8), 'narrow');
  assert.equal(widthOf(tablet), 'wide');

  // Simulator device-type profiles: points are pixels over the scale.
  const iphone = iosShortSide({
    mainScreenWidth: 1206,
    mainScreenHeight: 2622,
    mainScreenScale: 3,
  });
  const ipad = iosShortSide({ mainScreenWidth: 1640, mainScreenHeight: 2360, mainScreenScale: 2 });
  const mini = iosShortSide({ mainScreenWidth: 1488, mainScreenHeight: 2266, mainScreenScale: 2 });
  assert.deepEqual([iphone, ipad, mini].map(widthOf), ['narrow', 'wide', 'narrow']);
  assert.equal(widthOf(768), 'wide');
  assert.equal(widthOf(767), 'narrow');
});

test('an override is what the app is laid out in, so it wins over the physical value', () => {
  const size = 'Physical size: 1920x1200\nOverride size: 900x1200\n';
  const density = 'Physical density: 240\nOverride density: 320\n';
  assert.deepEqual(wmSize(size), [900, 1200]);
  assert.equal(wmDensity(density), 320);
  assert.equal(androidShortSide(size, 'Physical density: 240\n'), 600);
  assert.throws(() => wmSize('error: no devices/emulators found'), /unreadable `wm size`/);
});

test('a wide iOS run owes no capture from inside the share extension, and nothing else is dropped', () => {
  const ids = (platform: 'ios' | 'android', width: E2EWidth) =>
    expectedCaptures(['VISUAL-SHARE-001', 'VISUAL-FONT-001'], platform, undefined, width).map(
      (capture) => capture.checkpoint.id,
    );
  const iphone = ids('ios', 'narrow');
  const ipad = ids('ios', 'wide');
  for (const id of IOS_SHARE_CHECKPOINTS) {
    assert.ok(iphone.includes(id), id);
    assert.ok(!ipad.includes(id), id);
    assert.ok(ids('android', 'wide').includes(id), id);
  }
  assert.deepEqual(
    ipad,
    iphone.filter((id) => !IOS_SHARE_CHECKPOINTS.has(id)),
  );
});
