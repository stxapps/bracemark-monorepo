import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNativeCli, parseVisualCli, parseWebCli } from './cli';
import {
  readCaseRegistry,
  selectCases,
  selectCasesForPlatform,
  validateCaseRegistry,
  widthsOf,
} from './registry';

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

test('a native case runs narrow unless its entry admits wide, and a wide run takes only those', () => {
  const narrow = ids(selectCasesForPlatform('native', 'android', { width: 'narrow' }));
  const wide = ids(selectCasesForPlatform('native', 'android', { width: 'wide' }));
  const admitted = readCaseRegistry().filter(
    (testCase) =>
      testCase.surface === 'native' &&
      testCase.tier !== 'release' &&
      !testCase.traits.includes('baseline') &&
      testCase.traits.includes('android') &&
      testCase.widths?.includes('wide'),
  );
  assert.deepEqual(wide, ids(admitted));
  assert.ok(wide.includes('RAIL-WIDE-001') && !narrow.includes('RAIL-WIDE-001'));
  assert.ok(wide.includes('NATIVE-LINK-001') && narrow.includes('NATIVE-LINK-001'));
  assert.throws(
    () =>
      selectCasesForPlatform('native', 'android', { width: 'wide', cases: ['NATIVE-ACCOUNT-002'] }),
    /NATIVE-ACCOUNT-002 does not run wide/,
  );
  assert.throws(
    () =>
      selectCasesForPlatform('native', 'android', { width: 'narrow', cases: ['RAIL-WIDE-001'] }),
    /RAIL-WIDE-001 does not run narrow/,
  );
});

test('widths is a native or web field, a non-empty set of the two, and web keeps wide', () => {
  const entry = readCaseRegistry().find((testCase) => testCase.id === 'RAIL-WIDE-001');
  assert.ok(entry);
  const web = readCaseRegistry().find((testCase) => testCase.id === 'WEB-LINK-001');
  assert.ok(web);
  const extension = readCaseRegistry().find((testCase) => testCase.surface === 'extension');
  assert.ok(extension);
  for (const bad of [
    { ...entry, widths: [] },
    { ...entry, widths: ['wide', 'wide'] },
    { ...entry, widths: ['tablet'] },
    { ...web, widths: ['narrow'] },
    { ...extension, widths: ['wide'] },
  ]) {
    assert.throws(
      () => validateCaseRegistry([bad as typeof entry]),
      /invalid widths \(an automated native case, or a web case that keeps wide\)/,
    );
  }
  validateCaseRegistry(
    readCaseRegistry().map((testCase) =>
      testCase.surface === 'web' && testCase.id === web.id
        ? { ...web, widths: ['wide', 'narrow'] }
        : testCase,
    ),
  );
});

test('a web case is wide unless it admits narrow, and a native one narrow unless it admits wide', () => {
  const web = readCaseRegistry().find((testCase) => testCase.id === 'WEB-LINK-001');
  const native = readCaseRegistry().find((testCase) => testCase.id === 'NATIVE-ACCOUNT-002');
  assert.ok(web && native);
  assert.deepEqual(widthsOf({ ...web, widths: undefined }), ['wide']);
  assert.deepEqual(widthsOf({ ...native, widths: undefined }), ['narrow']);
  const narrowWeb = selectCases('web', { width: 'narrow' });
  assert.ok(narrowWeb.length > 0);
  for (const testCase of narrowWeb) assert.ok(testCase.widths?.includes('narrow'), testCase.id);
  assert.equal(selectCases('web', { width: 'wide' }).length, selectCases('web').length);
});

test('--width defaults to narrow, and is refused where it means nothing', () => {
  assert.equal(parseNativeCli(['--platform', 'ios']).width, 'narrow');
  assert.equal(parseNativeCli(['--platform', 'ios', '--width', 'wide']).width, 'wide');
  assert.throws(
    () => parseNativeCli(['--platform', 'ios', '--width', 'tablet']),
    /--width must be "narrow" or "wide"/,
  );
  assert.equal(parseVisualCli(['--platform', 'android']).width, 'narrow');
  assert.equal(parseVisualCli(['--platform', 'android', '--width', 'wide']).width, 'wide');
  assert.throws(
    () => parseVisualCli(['--platform', 'web', '--width', 'wide']),
    /--width is for ios and android only/,
  );
});

test('--width is the web wrapper’s, unset means both windows, and the others hand it on', () => {
  assert.equal(parseWebCli([], true).width, undefined);
  assert.equal(parseWebCli(['--width', 'narrow'], true).width, 'narrow');
  assert.deepEqual(parseWebCli(['--width=wide', '--headed'], true).playwrightArgs, ['--headed']);
  assert.throws(
    () => parseWebCli(['--width', 'tablet'], true),
    /--width must be "narrow" or "wide"/,
  );
  assert.throws(() => parseWebCli(['--width'], true), /--width requires a value/);
  assert.deepEqual(parseWebCli(['--width', 'narrow']).playwrightArgs, ['--width', 'narrow']);
});
