import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveStagingD1Token, STAGING_D1_KEYCHAIN_SERVICE } from './staging-credential';

test('the staging D1 token comes from the shell, then its own keychain item, then nowhere', async () => {
  const asked: string[] = [];
  const keychain = (answer: string | Error) => (service: string) => {
    asked.push(service);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };

  const shell = await resolveStagingD1Token(
    { CLOUDFLARE_API_TOKEN: 'from-shell' },
    keychain('from-keychain'),
  );
  assert.equal(shell.token, 'from-shell');
  assert.deepEqual(asked, [], 'an exported token must not touch the keychain');

  const stored = await resolveStagingD1Token({}, keychain('from-keychain'));
  assert.equal(stored.token, 'from-keychain');
  // Its own item: the deploy token can replace a Worker, and is never read here.
  assert.deepEqual(asked, [STAGING_D1_KEYCHAIN_SERVICE]);
  assert.notEqual(STAGING_D1_KEYCHAIN_SERVICE, 'bracemark-cf-token-staging');

  for (const missing of [keychain(new Error('no such item')), keychain('')]) {
    await assert.rejects(
      () => resolveStagingD1Token({}, missing),
      /security add-generic-password .*bracemark-cf-token-staging-e2e/,
    );
  }
});

test('on staging only a declared plan statement leaves the machine', async () => {
  // `environment.ts` resolves once, at import — so the tier is set first and the
  // seed modules are imported after it. Nothing below spawns wrangler or reads a
  // keychain: every call is refused before it could.
  process.env.E2E_ENVIRONMENT = 'staging';
  delete process.env.E2E_STAGING_PLAN_GRANTS;
  const { d1, planD1 } = await import('../seed/d1');
  const { forgetSessions } = await import('../seed/sessions');

  // Undeclared: the runner proved no credential for this run, so none is resolved.
  await assert.rejects(() => planD1('SELECT 1'), /"stagingGrants": \["plan"\]/);
  // Every other binding, and the purge that would start with a directory lookup.
  await assert.rejects(() => d1('SESSIONS_DB', 'SELECT 1'), /requires the local E2E environment/);
  await assert.rejects(() => forgetSessions('nobody'), /requires the local E2E environment/);
});
