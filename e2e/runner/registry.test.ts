import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNativeCli, parseWebCli } from './cli';
import { readCaseRegistry, selectCases, selectCasesForPlatform } from './registry';

const ids = (cases: { id: string }[]) => cases.map((testCase) => testCase.id);

test('--from keeps the named case and everything after it, in registry order', () => {
  const all = ids(selectCasesForPlatform('native', 'android'));
  assert.deepEqual(ids(selectCasesForPlatform('native', 'android', { from: all[0] })), all);
  assert.deepEqual(
    ids(selectCasesForPlatform('native', 'android', { from: all[3] })),
    all.slice(3),
  );
  assert.deepEqual(ids(selectCasesForPlatform('native', 'android', { from: all.at(-1) })), [
    all.at(-1),
  ]);
  const web = ids(selectCases('web'));
  assert.deepEqual(ids(selectCases('web', { from: web[2] })), web.slice(2));
});

test('--from is applied to what the other filters left, and refuses an id they dropped', () => {
  const all = ids(selectCasesForPlatform('native', 'android'));
  const cases = [all[1], all[4], all[6]];
  assert.deepEqual(
    ids(selectCasesForPlatform('native', 'android', { cases, from: all[4] })),
    cases.slice(1),
  );
  // Left out by --case, unknown on this surface, and unsupported on the platform.
  assert.throws(
    () => selectCasesForPlatform('native', 'android', { cases, from: all[2] }),
    /--from .* is not one of the 3 selected cases/,
  );
  assert.throws(
    () => selectCasesForPlatform('native', 'android', { from: 'NOT-A-CASE-001' }),
    /--from NOT-A-CASE-001 is not one of/,
  );
  const iosOnly = readCaseRegistry().find(
    (testCase) =>
      testCase.surface === 'native' &&
      testCase.tier !== 'release' &&
      !testCase.traits.includes('baseline') &&
      !testCase.traits.includes('android'),
  );
  assert.ok(iosOnly, 'the registry holds an iOS-only native case');
  assert.throws(
    () => selectCasesForPlatform('native', 'android', { from: iosOnly.id }),
    /is not one of/,
  );
});

test('--from is a native flag: the web wrappers hand it on to Playwright', () => {
  assert.equal(
    parseNativeCli(['--platform', 'android', '--from', 'FILTER-001']).from,
    'FILTER-001',
  );
  assert.equal(parseNativeCli(['--platform', 'android']).from, undefined);
  assert.throws(
    () => parseNativeCli(['--platform', 'android', '--from']),
    /--from requires a value/,
  );
  assert.deepEqual(parseWebCli(['--from', 'WEB-LINK-001']).playwrightArgs, [
    '--from',
    'WEB-LINK-001',
  ]);
});
