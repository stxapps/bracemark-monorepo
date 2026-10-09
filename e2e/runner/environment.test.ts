import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEnvironment, STAGING_ORIGINS } from './environment';
import { selectCases, selectCasesForPlatform } from './registry';

test('staging pins every role and refuses production, mixed tiers and credential URLs', () => {
  assert.deepEqual(resolveEnvironment({ E2E_ENVIRONMENT: 'staging' }).origins, STAGING_ORIGINS);
  for (const env of [
    { E2E_ENVIRONMENT: 'production' },
    { E2E_ENVIRONMENT: 'staging', E2E_API_URL: 'https://api.bracemark.com' },
    { E2E_ENVIRONMENT: 'staging', E2E_WEB_URL: 'http://localhost:3000' },
    { E2E_ENVIRONMENT: 'staging', E2E_SITE_URL: 'https://secret@dryrunbase.com' },
    { E2E_ENVIRONMENT: 'staging', E2E_EXTRACTOR_URL: 'https://extractor.dryrunbase.com/v1' },
    { E2E_API_URL: 'https://api.bracemark.com' },
    { E2E_API_URL: 'https://api.dryrunbase.com' },
  ])
    assert.throws(() => resolveEnvironment(env));
  assert.equal(
    resolveEnvironment({ E2E_API_URL: 'http://127.0.0.1:9787' }).origins.api,
    'http://127.0.0.1:9787',
  );
});

test('staging selection includes deployment checks and rejects unavailable fixture cases explicitly', () => {
  const selected = selectCases('web', { environment: 'staging', suite: 'smoke' });
  assert.ok(selected.some((entry) => entry.id === 'STAGING-CSP-001'));
  assert.ok(selected.some((entry) => entry.id === 'WEB-LINK-001'));
  // Server extraction is admitted, and says what it writes to get there.
  for (const id of ['EXTRACT-WEB-001', 'EXTRACT-WEB-ALL-001']) {
    const [extraction] = selectCases('web', { environment: 'staging', cases: [id] });
    assert.deepEqual(extraction.stagingGrants, ['plan']);
  }
  assert.ok(
    selected.every((entry) => !entry.stagingGrants),
    'smoke needs no credential',
  );
  assert.throws(
    () => selectCases('web', { environment: 'staging', cases: ['EXTRACT-OFFLINE-001'] }),
    /does not support staging/,
  );
  assert.throws(
    () => selectCases('native', { environment: 'staging', cases: ['OFFLINE-ANDROID-001'] }),
    /does not support staging/,
  );
  assert.throws(
    () => selectCases('contract', { environment: 'staging', cases: ['CONTRACT-VECTORS-001'] }),
    /does not support staging/,
  );
  const local = selectCases('web');
  assert.ok(!local.some((entry) => entry.id.startsWith('STAGING-')));
  for (const platform of ['ios', 'android'] as const) {
    assert.equal(
      selectCasesForPlatform('contract', platform, { environment: 'staging' }).length,
      2,
    );
  }
});
