import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { diedInStatusBarFetch, lostDriverToStatusBarRace } from './driver-loss';

const FATAL =
  '<unknown>:0: error: -[maestro_driver_iosUITests.maestro_driver_iosUITests testHttpServer] : ' +
  'Failed to resolve query: Failed to resolve remote element AX element pid: 21570, ' +
  'elementOrHash.elementID: 1.9999. (Underlying Error: Error kAXErrorInvalidUIElement)';
const FETCH_START = '[ViewHierarchyHandler] Fetch status bar hierarchy - start';
const FETCH_END = 'Fetch status bar hierarchy - duration 0.08';
const UNREACHABLE = '<failure>maestro.DeviceUnreachableException: Device became unreachable';

const lines = (...text: string[]) => text.join('\n');

test('a resolve failure inside the status-bar fetch is the driver race', () => {
  assert.equal(
    diedInStatusBarFetch(lines(FETCH_START, FETCH_END, FETCH_START, FATAL, FETCH_END)),
    true,
  );
});

test('the same failure outside the fetch is not: that walk can be the app', () => {
  assert.equal(diedInStatusBarFetch(lines(FETCH_START, FETCH_END, FATAL)), false);
  assert.equal(diedInStatusBarFetch(FATAL), false);
});

test('the AX error XCTest absorbs is not the race, inside the fetch or out', () => {
  const absorbed =
    't = 92.10s Ignoring failure to get hierarchy for remote element in process 21570 ' +
    '(Error getting main window kAXErrorInvalidUIElement)';
  assert.equal(diedInStatusBarFetch(lines(FETCH_START, absorbed, FETCH_END)), false);
});

async function withCaseDir(run: (caseDir: string) => Promise<void>): Promise<void> {
  const caseDir = await mkdtemp(join(tmpdir(), 'driver-loss-'));
  try {
    await run(caseDir);
  } finally {
    await rm(caseDir, { recursive: true, force: true });
  }
}

async function writeStep(
  caseDir: string,
  suffix: string,
  report: string,
  runnerLog: string,
): Promise<void> {
  const outputDir = join(caseDir, `maestro${suffix}`, '2026-10-31_091040');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(caseDir, `junit${suffix}.xml`), report, 'utf8');
  await writeFile(join(outputDir, 'xctest_runner_2026-10-31_091044.log'), runnerLog, 'utf8');
}

test('a case lost to the race is found by its report and its runner log together', async () => {
  await withCaseDir(async (caseDir) => {
    await writeStep(caseDir, '', UNREACHABLE, lines(FETCH_START, FATAL));
    assert.equal(await lostDriverToStatusBarRace(caseDir), true);
  });
});

test('a failed assertion with a fatal log is not a lost driver', async () => {
  await withCaseDir(async (caseDir) => {
    await writeStep(
      caseDir,
      '',
      '<failure>Assertion is false</failure>',
      lines(FETCH_START, FATAL),
    );
    assert.equal(await lostDriverToStatusBarRace(caseDir), false);
  });
});

test('an unreachable device with no race in its log is not this loss', async () => {
  await withCaseDir(async (caseDir) => {
    await writeStep(caseDir, '', UNREACHABLE, lines(FETCH_START, FETCH_END));
    assert.equal(await lostDriverToStatusBarRace(caseDir), false);
  });
});

test('a step is judged by its own log, not by a neighbouring step', async () => {
  await withCaseDir(async (caseDir) => {
    await writeStep(caseDir, '-1', '<testsuites/>', lines(FETCH_START, FATAL));
    await writeStep(caseDir, '-2', UNREACHABLE, lines(FETCH_START, FETCH_END));
    assert.equal(await lostDriverToStatusBarRace(caseDir), false);
  });
});

test('Android has no runner log to match, and that is not an error', async () => {
  await withCaseDir(async (caseDir) => {
    await writeFile(join(caseDir, 'junit.xml'), UNREACHABLE, 'utf8');
    assert.equal(await lostDriverToStatusBarRace(caseDir), false);
  });
});
