import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The credential behind the one write a staging run makes outside the app: the
// `manual` purchase row that puts a disposable account on a plan (seed/plan.ts,
// seed/d1.ts). Every other staging journey needs no credential at all, and this
// one is resolved only for a run whose registry entries declare `stagingGrants`.
//
// It is a SEPARATE token from the deploy one (`bracemark-cf-token-staging`,
// tools/scripts/deploy-worker.sh), minted against the staging account with D1
// Edit and nothing else. A test runner drives a browser against the public
// internet for minutes at a time; it should not hold the right to replace a
// Worker while it does. There is deliberately no fallback to the deploy item.
//
//   security add-generic-password -a bracemark -s bracemark-cf-token-staging-e2e -w
//
// Never a file in this worktree (docs/env-files.md, _what's committed vs
// ignored_), and never `wrangler login`: with no token wrangler falls back to an
// OAuth session, which authenticates the USER, and one user owns both tiers'
// accounts. So a missing token is an error here, before wrangler is spawned.
export const STAGING_D1_KEYCHAIN_SERVICE = 'bracemark-cf-token-staging-e2e';

// Set by the web and browser-extension runners for their Playwright child once
// the credential is proved, and required by the remote executor in seed/d1.ts. It
// is what keeps the opening as narrow as the registry says it is: a grant from a
// run that declared none — an undeclared case, the native runner, the account
// seed pointed at staging — is refused rather than quietly resolving a credential
// mid-test.
export const STAGING_PLAN_GRANTS = 'E2E_STAGING_PLAN_GRANTS';

type KeychainReader = (service: string) => Promise<string>;

const run = promisify(execFile);

async function readKeychain(service: string): Promise<string> {
  const { stdout } = await run('security', [
    'find-generic-password',
    '-a',
    'bracemark',
    '-s',
    service,
    '-w',
  ]);
  return stdout.trim();
}

// The shell first, then the login keychain, then nothing — the same order as the
// deploy scripts, so CI passes a real env var and a laptop never has to.
export async function resolveStagingD1Token(
  env: NodeJS.ProcessEnv = process.env,
  keychain: KeychainReader = readKeychain,
): Promise<{ token: string; from: string }> {
  const fromShell = env.CLOUDFLARE_API_TOKEN;
  if (fromShell) return { token: fromShell, from: 'the shell (CLOUDFLARE_API_TOKEN)' };

  let token = '';
  try {
    token = await keychain(STAGING_D1_KEYCHAIN_SERVICE);
  } catch {
    // No keychain on this platform, or no such item — the same answer below.
  }
  if (token) return { token, from: `the keychain (${STAGING_D1_KEYCHAIN_SERVICE})` };

  throw new Error(
    `no Cloudflare token for a staging plan grant. Add one to the login keychain with:\n` +
      `  security add-generic-password -a bracemark -s ${STAGING_D1_KEYCHAIN_SERVICE} -w\n` +
      'Mint it as an ACCOUNT-owned token against the staging account with D1 Edit only. ' +
      'It is not the deploy token, and it never goes in a file here.',
  );
}

// One keychain read per process: a Playwright worker grants a plan per case.
let cached: Promise<{ token: string; from: string }> | undefined;

export function stagingD1Token(): Promise<{ token: string; from: string }> {
  cached ??= resolveStagingD1Token();
  return cached;
}
