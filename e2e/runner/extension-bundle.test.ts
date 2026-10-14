import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STAGING_ORIGINS } from './environment';
import { extensionBundleProblems } from './extension-bundle';

const LOCAL = { api: 'http://localhost:8787', web: 'http://localhost:3000' };
const STAGING = { api: STAGING_ORIGINS.api, web: STAGING_ORIGINS.web };

function bundle(origins: { api: string; web: string }, extra = '') {
  return {
    hostPermissions: [`${origins.api}/*`],
    scripts: `const API="${origins.api}";const WEB="${origins.web}";${extra}`,
  };
}

test('a browser-extension build is admitted only by the tier it was built for', () => {
  assert.deepEqual(extensionBundleProblems(bundle(STAGING), 'staging', STAGING), []);
  assert.deepEqual(extensionBundleProblems(bundle(LOCAL), 'local', LOCAL), []);

  // The development build on a staging run, and the reverse.
  assert.ok(extensionBundleProblems(bundle(LOCAL), 'staging', STAGING).length > 0);
  assert.ok(extensionBundleProblems(bundle(STAGING), 'local', LOCAL).length > 0);
});

test('a staging build that also names another tier, or grants the wrong host, is refused', () => {
  for (const stray of [
    'http://localhost:8787',
    'http://localhost:3000',
    'https://api.bracemark.com',
    'https://app.bracemark.com',
  ]) {
    assert.deepEqual(
      extensionBundleProblems(bundle(STAGING, `fetch("${stray}")`), 'staging', STAGING),
      [`a script names ${stray}`],
    );
  }
  // The api right in the scripts but the grant left on the local host: every
  // background call would lose its CORS exemption.
  assert.match(
    extensionBundleProblems(
      { ...bundle(STAGING), hostPermissions: ['http://localhost:8787/*'] },
      'staging',
      STAGING,
    ).join(),
    /host_permissions/,
  );
  // A second grant widens what the store build asks for.
  assert.match(
    extensionBundleProblems(
      { ...bundle(STAGING), hostPermissions: [`${STAGING.api}/*`, '<all_urls>'] },
      'staging',
      STAGING,
    ).join(),
    /host_permissions/,
  );
  // The web-app origin missing: sign-up and "Upgrade to Plus" would open elsewhere.
  assert.deepEqual(
    extensionBundleProblems(
      { hostPermissions: [`${STAGING.api}/*`], scripts: `"${STAGING.api}"` },
      'staging',
      STAGING,
    ),
    [`no script names ${STAGING.web}`],
  );
});
