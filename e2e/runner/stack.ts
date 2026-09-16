import { join } from 'node:path';

import { E2E_ROOT } from '../paths';
import { capture, isWithin } from './process';

const REPO_ROOT = join(E2E_ROOT, '..');

function localPort(value: string): number | undefined {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return undefined;
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

async function listenerPids(port: number): Promise<string[]> {
  const result = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    allowFailure: true,
  });
  return [...new Set(result.stdout.split(/\s+/).filter(Boolean))];
}

async function processCwd(pid: string): Promise<string | undefined> {
  const result = await capture('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
    allowFailure: true,
  });
  return result.stdout
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
}

export async function assertOriginOwnedByRepo(
  origin: string,
  label: string,
  options: { required?: boolean } = {},
): Promise<void> {
  const port = localPort(origin);
  if (!port) return;

  const pids = await listenerPids(port);
  if (pids.length === 0) {
    if (options.required) throw new Error(`${label} has no listener at ${origin}`);
    return;
  }

  const owners = await Promise.all(pids.map(async (pid) => ({ pid, cwd: await processCwd(pid) })));
  const wrong = [];
  for (const owner of owners) {
    if (!owner.cwd || !(await isWithin(owner.cwd, REPO_ROOT))) wrong.push(owner);
  }
  if (wrong.length > 0) {
    const detail = wrong.map(({ pid, cwd }) => `pid ${pid}: ${cwd ?? 'unknown cwd'}`).join(', ');
    throw new Error(
      `${label} at ${origin} belongs outside this checkout (${detail}). ` +
        `Stop that process before running E2E from ${REPO_ROOT}.`,
    );
  }
}

export async function assertStackOwnedByRepo(
  origins: Array<{ origin: string; label: string; required?: boolean }>,
): Promise<void> {
  for (const entry of origins) {
    await assertOriginOwnedByRepo(entry.origin, entry.label, { required: entry.required });
  }
}
