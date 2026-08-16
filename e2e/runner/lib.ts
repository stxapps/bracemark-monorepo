import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ARTIFACTS, E2E_ROOT, profileDir } from '../paths';
import { type Credentials } from '../web/fixtures/account';
import { API_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';

// --- the dev stack ----------------------------------------------------------

// `playwright test` boots and waits for the stack itself (webServer in
// playwright.config.ts). Everything in this folder runs outside Playwright's
// runner, so it checks by hand and fails with an instruction instead of a stack
// trace against a closed port.
export async function waitForApi(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `bracemark-api did not answer ${API_URL}/health within ${timeoutMs / 1000}s ` +
      `(last: ${lastError}). Start the stack with \`npm run dev\` and retry.`,
  );
}

// --- accounts ---------------------------------------------------------------

// Mobile flows need an account, and the fastest reliable way to get one is the
// web create-account flow: it is already scripted, already covered by the web
// specs, and produces a SERVER-side account the phone can then sign into. Doing
// it on-device instead would mean a second create-account flow to maintain for no
// extra coverage — the native form's own behaviour is jest's job.
//
// The password is generated here and handed to Maestro, which is the reason the
// web fixture takes the "Choose my own" path rather than the generated
// passphrase: a secret we chose can be passed along, one the app generated would
// have to be scraped off a screen.
//
// `withRecovery` is the one case where that preference has nothing to prefer —
// a recovery code cannot be chosen, only minted — so it IS scraped, off the
// show-once panel, and handed along the same way.
export interface ProvisionOptions {
  // Also mint a recovery code and return it. `mobile/flows/recovery-sign-in.yaml`
  // is the only thing that needs one, and it cannot bring its own: the code is
  // CSPRNG-minted by the client and shown once, so the ceremony is the only place
  // to capture it (createAccountWithRecovery carries the full reasoning).
  withRecovery?: boolean;
}

export interface ProvisionedAccount extends Credentials {
  recoveryCode?: string;
}

export async function provisionAccount(
  label: string,
  options: ProvisionOptions = {},
): Promise<ProvisionedAccount> {
  await waitForApi();
  const app = await launchApp(profileDir(`provision-${label}`), {
    withRecovery: options.withRecovery,
  });
  try {
    return { ...app.credentials, recoveryCode: app.recoveryCode };
  } finally {
    await app.close();
  }
}

// --- maestro ----------------------------------------------------------------

// Maestro's PATH entry lives in `.zshenv`, not `.zshrc` — `.zshrc` is
// interactive-only, so anything that shells out gets NOT FOUND (docs/testing.md).
// npm scripts usually inherit it correctly, but falling back to the known install
// path turns a confusing ENOENT into a run that just works.
function maestroBin(): string {
  const installed = join(homedir(), '.maestro', 'bin', 'maestro');
  return existsSync(installed) ? installed : 'maestro';
}

export interface MaestroOptions {
  // `-e KEY=VALUE` pairs, read inside a flow as `${KEY}`.
  env?: Record<string, string>;
  // Where to drop screenshots/recordings for this run.
  outputDir?: string;
}

// Run a flow (or a directory of flows) and reject on a non-zero exit. Output is
// inherited rather than captured: Maestro's per-step COMPLETED/FAILED lines are
// the useful signal when a flow breaks, and swallowing them to re-print a summary
// loses which step it was.
export async function maestro(target: string, options: MaestroOptions = {}): Promise<void> {
  const args = ['test', target];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  if (options.outputDir) args.push('--format', 'junit', '--output', options.outputDir);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(maestroBin(), args, { cwd: E2E_ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`maestro test ${target} exited ${code}`));
    });
  });
}

// --- run manifests ----------------------------------------------------------

// Written for the human (or agent) reading a failed run, not for the flows: the
// credentials are already passed to Maestro as `-e`. What this is for is being
// able to sign into the account a failed run left behind and look at it.
export async function writeManifest(name: string, data: unknown): Promise<string> {
  await mkdir(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, `${name}.json`);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return path;
}
