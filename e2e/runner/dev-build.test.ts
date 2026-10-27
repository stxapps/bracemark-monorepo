import assert from 'node:assert/strict';
import { test } from 'node:test';

import { androidDevBuildProblem, iosDevBuildProblem } from './dev-build';

test('Android: a debuggable package is a dev build, the staging Release build is refused', () => {
  // `dumpsys package com.bracemark.app`, trimmed to the lines that differ.
  const debug = 'versionName=1.1.0\n    pkgFlags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n';
  // Read off the Pixel 8 AVD on 2026-10-27, left there by a staging run.
  const release = 'versionName=1.1.0\n    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n';
  assert.equal(androidDevBuildProblem(debug), undefined);
  assert.match(androidDevBuildProblem(release) ?? '', /Release build/);
});

test('iOS: the dev launcher marks a dev build; an embedded bundle names a Release one', () => {
  const debug = ['Bracemark', 'EXDevLauncher.bundle', 'EXDevMenu.bundle', 'Info.plist'];
  const release = ['Bracemark', 'Info.plist', 'main.jsbundle'];
  assert.equal(iosDevBuildProblem(debug), undefined);
  assert.match(iosDevBuildProblem(release) ?? '', /Release build/);
  assert.match(iosDevBuildProblem(['Bracemark', 'Info.plist']) ?? '', /not an Expo development/);
});
