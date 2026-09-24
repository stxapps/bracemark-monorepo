import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function capture(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (options.allowFailure && error && typeof error === 'object') {
      const output = error as { stdout?: string; stderr?: string };
      return { stdout: output.stdout ?? '', stderr: output.stderr ?? '' };
    }
    throw error;
  }
}

// `adb shell` receives one command string and re-splits it on the device. Quote
// every word here so a multi-word value remains one value there
// (docs/app-drivers.md, _adb shell has no argv_). With no `deviceId` it talks to
// the one attached device, as a bare `adb shell` does.
export async function adbShell(
  deviceId: string | undefined,
  words: string[],
  allowFailure = false,
): Promise<string> {
  const command = words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
  const target = deviceId ? ['-s', deviceId] : [];
  return (await capture('adb', [...target, 'shell', command], { allowFailure })).stdout.trim();
}

export async function inherit(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code ?? 'without a status'}`));
    });
  });
}

export async function isWithin(candidate: string, parent: string): Promise<boolean> {
  const [resolvedCandidate, resolvedParent] = await Promise.all([
    realpath(resolve(candidate)),
    realpath(resolve(parent)),
  ]);
  const path = relative(resolvedParent, resolvedCandidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
