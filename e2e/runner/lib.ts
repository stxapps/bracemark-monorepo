import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { E2E_ROOT, profileDir } from '../paths';
import { type Credentials } from '../web/fixtures/account';
import { API_URL } from '../web/fixtures/env';
import { launchApp, type LaunchedApp } from '../web/fixtures/launch';
import { type NativePlatform } from './cli';

// --- the dev stack ----------------------------------------------------------

// `playwright test` boots and waits for the stack itself (webServer in
// playwright.config.ts). Everything in this folder runs outside Playwright's
// runner, so it checks by hand and fails with an instruction instead of a stack
// trace against a closed port.
export async function waitForApi(timeoutMs = 90_000): Promise<void> {
  await waitForHttp(`${API_URL}/health`, 'bracemark-api', timeoutMs);
}

export async function waitForHttp(url: string, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `${label} did not answer ${url} within ${timeoutMs / 1000}s ` +
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
  // Put the account in the state a case starts from, while the browser that
  // created it is still signed in: a Plus grant, an imported library that has
  // to reach the server before the device signs in and pulls it. Anything the
  // case itself is about stays in the flow.
  prepare?: (app: LaunchedApp) => Promise<void>;
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
    await options.prepare?.(app);
    return { ...app.credentials, recoveryCode: app.recoveryCode };
  } finally {
    await app.close();
  }
}

// --- maestro ----------------------------------------------------------------

// Maestro's PATH entry lives in `.zshenv`, not `.zshrc` — `.zshrc` is
// interactive-only, so anything that shells out gets NOT FOUND (docs/app-drivers.md).
// npm scripts usually inherit it correctly, but falling back to the known install
// path turns a confusing ENOENT into a run that just works.
function maestroBin(): string {
  const installed = join(homedir(), '.maestro', 'bin', 'maestro');
  return existsSync(installed) ? installed : 'maestro';
}

export interface MaestroOptions {
  platform: NativePlatform;
  deviceId: string;
  // `-e KEY=VALUE` pairs, read inside a flow as `${KEY}`.
  env?: Record<string, string>;
  // Where to write a JUnit report. This is a file, not Maestro's artifact directory.
  reportPath?: string;
  // Where Maestro may safely write this run's screenshots, recordings and logs.
  testOutputDir?: string;
  // Maestro's diagnostic logs and hierarchy snapshots.
  debugOutputDir?: string;
  includeTags?: string[];
  excludeTags?: string[];
}

export interface MaestroCommand {
  command: string;
  args: string[];
  environmentKeys: string[];
}

export function maestroCommand(target: string, options: MaestroOptions): MaestroCommand {
  const args = ['--device', options.deviceId, '--platform', options.platform, 'test'];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  if (options.reportPath) args.push('--format', 'JUNIT', '--output', options.reportPath);
  if (options.testOutputDir) args.push('--test-output-dir', options.testOutputDir);
  if (options.debugOutputDir) args.push('--debug-output', options.debugOutputDir);
  if (options.includeTags?.length) args.push('--include-tags', options.includeTags.join(','));
  if (options.excludeTags?.length) args.push('--exclude-tags', options.excludeTags.join(','));
  args.push(target);

  return {
    command: maestroBin(),
    args,
    environmentKeys: Object.keys(options.env ?? {}).sort(),
  };
}

// Run a flow (or a directory of flows) and reject on a non-zero exit. Output is
// inherited rather than captured: Maestro's per-step COMPLETED/FAILED lines are
// the useful signal when a flow breaks, and swallowing them to re-print a summary
// loses which step it was.
export async function maestro(target: string, options: MaestroOptions): Promise<void> {
  const command = maestroCommand(target, options);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd: E2E_ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`maestro test ${target} exited ${code}`));
    });
  });
}

export async function maestroHierarchy(options: {
  platform: NativePlatform;
  deviceId: string;
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      maestroBin(),
      ['--device', options.deviceId, '--platform', options.platform, 'hierarchy'],
      { cwd: E2E_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`maestro hierarchy exited ${code}: ${stderr.trim()}`));
    });
  });
}

// --- run metadata -----------------------------------------------------------

export function createRunId(kind: string): string {
  const time = new Date().toISOString().replace(/[:.]/g, '-');
  return `${kind}-${time}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

export async function writeJson(path: string, data: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return path;
}
