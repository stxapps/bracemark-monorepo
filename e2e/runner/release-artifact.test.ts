import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { STAGING_ORIGINS } from './environment';
import {
  artifactHash,
  assertStagingBundle,
  latestReleaseReceipt,
  readReleaseReceipt,
  type ReleaseReceipt,
} from './release-artifact';

test('embedded release bundle must name staging and refuse opposite API origins', () => {
  const bundle = `${STAGING_ORIGINS.api}\0${STAGING_ORIGINS.site}`;
  assert.doesNotThrow(() => assertStagingBundle(Buffer.from(bundle)));
  for (const text of [
    '',
    STAGING_ORIGINS.site,
    `${bundle}\0https://api.bracemark.com`,
    `${bundle}\0http://localhost:8787`,
  ]) {
    assert.throws(() => assertStagingBundle(Buffer.from(text)));
  }
});

test('receipt detects changed APK/mapping bytes, wrong environment and escaping paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bracemark-release-'));
  try {
    const artifact = join(root, 'app.apk');
    const mapping = join(root, 'mapping.txt');
    const path = join(root, 'release.json');
    await writeFile(artifact, 'APK fixture');
    await writeFile(mapping, '# compiler: R8\nclass -> a:\n');
    const receipt: ReleaseReceipt = {
      schemaVersion: 1,
      platform: 'android',
      configuration: 'Release',
      environment: 'staging',
      api: STAGING_ORIGINS.api,
      site: STAGING_ORIGINS.site,
      artifact: 'app.apk',
      sha256: await artifactHash(artifact),
      builtAt: new Date().toISOString(),
      checkout: { commit: 'fixture', dirty: false },
      mapping: { path: 'mapping.txt', sha256: await artifactHash(mapping) },
    };
    await writeFile(path, JSON.stringify(receipt));
    assert.equal((await readReleaseReceipt(path, 'android')).artifact, artifact);
    await assert.rejects(readReleaseReceipt(path, 'ios'), /invalid/);
    await writeFile(artifact, 'different APK');
    await assert.rejects(readReleaseReceipt(path, 'android'), /artifact hash changed/);
    await writeFile(artifact, 'APK fixture');
    await writeFile(mapping, '# compiler: R8\nchanged -> b:\n');
    await assert.rejects(readReleaseReceipt(path, 'android'), /mapping hash changed/);
    await writeFile(path, JSON.stringify({ ...receipt, artifact: '../app.apk' }));
    await assert.rejects(readReleaseReceipt(path, 'android'), /escapes/);
    await writeFile(path, JSON.stringify({ ...receipt, api: 'https://api.bracemark.com' }));
    await assert.rejects(readReleaseReceipt(path, 'android'), /invalid/);
    await writeFile(path, JSON.stringify({ ...receipt, mapping: undefined }));
    await assert.rejects(readReleaseReceipt(path, 'android'), /missing its R8 mapping/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app hash survives relocation and detects changes inside the embedded share extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bracemark-app-'));
  try {
    for (const name of ['built.app', 'installed.app']) {
      await mkdir(join(root, name, 'PlugIns', 'Share.appex'), { recursive: true });
      await writeFile(join(root, name, 'main.jsbundle'), 'Hermes fixture');
      await writeFile(join(root, name, 'PlugIns', 'Share.appex', 'Share'), 'native extension');
      await symlink('main.jsbundle', join(root, name, 'bundle-link'));
    }
    const expected = await artifactHash(join(root, 'built.app'));
    assert.equal(await artifactHash(join(root, 'installed.app')), expected);
    await writeFile(
      join(root, 'installed.app', 'PlugIns', 'Share.appex', 'Share'),
      'different extension',
    );
    assert.notEqual(await artifactHash(join(root, 'installed.app')), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the default receipt is the newest build of the requested platform only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bracemark-releases-'));
  try {
    await assert.rejects(latestReleaseReceipt(join(root, 'absent'), 'ios'), /no staging Release/);
    const builds = [
      ['staging-android-a', 'android', '2026-10-08T13:09:55.305Z'],
      ['staging-android-b', 'android', '2026-10-09T08:00:00.000Z'],
      ['staging-ios-a', 'ios', '2026-10-10T08:00:00.000Z'],
    ];
    for (const [name, platform, builtAt] of builds) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'release.json'), JSON.stringify({ platform, builtAt }));
    }
    // A build that died before its receipt, and a receipt that is not JSON.
    await mkdir(join(root, 'staging-android-c'));
    await mkdir(join(root, 'staging-android-d'));
    await writeFile(join(root, 'staging-android-d', 'release.json'), 'truncated');
    assert.equal(
      await latestReleaseReceipt(root, 'android'),
      join(root, 'staging-android-b', 'release.json'),
    );
    assert.equal(
      await latestReleaseReceipt(root, 'ios'),
      join(root, 'staging-ios-a', 'release.json'),
    );
    await rm(join(root, 'staging-ios-a'), { recursive: true });
    await assert.rejects(latestReleaseReceipt(root, 'ios'), /e2e:build:staging:ios/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
