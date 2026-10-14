import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBrowser } from './browser';
import { readCaseRegistry, selectCases, validateCaseRegistry } from './registry';

test('the engine is chrome unless named, and only chrome or firefox', () => {
  assert.equal(resolveBrowser({}), 'chrome');
  assert.equal(resolveBrowser({ E2E_BROWSER: 'firefox' }), 'firefox');
  for (const value of ['chromium', 'webkit', 'Firefox', ''])
    assert.throws(() => resolveBrowser({ E2E_BROWSER: value }), /E2E_BROWSER must be/);
});

test('firefox runs only the web cases that list it, and only the backup round trip runs nowhere else', () => {
  const firefox = selectCases('web', { browser: 'firefox' });
  assert.ok(firefox.length > 0);
  assert.ok(firefox.every((entry) => entry.browsers?.includes('firefox')));
  // A Firefox-only case is one whose subject Chrome cannot reach: the backup
  // export, which Chrome saves through a native dialog no driver can answer.
  const chrome = new Set(selectCases('web').map((entry) => entry.id));
  assert.deepEqual(
    firefox.filter((entry) => !chrome.has(entry.id)).map((entry) => entry.id),
    ['DATA-ROUNDTRIP-WEB-002'],
  );
  assert.throws(
    () => selectCases('web', { cases: ['DATA-ROUNDTRIP-WEB-002'] }),
    /does not run on chrome/,
  );

  // A case left off is refused by name rather than skipped.
  const chromeOnly = readCaseRegistry().find(
    (entry) => entry.surface === 'web' && entry.tier !== 'release' && !entry.browsers,
  );
  assert.ok(chromeOnly);
  assert.throws(
    () => selectCases('web', { browser: 'firefox', cases: [chromeOnly.id] }),
    /does not run on firefox/,
  );

  // The two axes compose: staging on Firefox is the intersection.
  const both = selectCases('web', { browser: 'firefox', environment: 'staging' });
  assert.ok(
    both.every(
      (entry) => entry.environments?.includes('staging') && entry.browsers?.includes('firefox'),
    ),
  );
});

test('browsers is accepted on an automated web case only', () => {
  const [web] = readCaseRegistry().filter((entry) => entry.browsers);
  const extension = readCaseRegistry().find((entry) => entry.surface === 'extension');
  assert.ok(web && extension);
  for (const bad of [
    { ...web, browsers: [] },
    { ...web, browsers: ['firefox', 'firefox'] },
    { ...web, browsers: ['webkit'] },
    { ...extension, browsers: ['chrome', 'firefox'] },
  ]) {
    assert.throws(
      () => validateCaseRegistry([bad as typeof web]),
      /invalid browsers/,
      JSON.stringify(bad.browsers),
    );
  }
});
