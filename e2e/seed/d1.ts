import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E2E_ROOT } from '../paths';
import { requireLocalEnvironment } from '../runner/environment';

const run = promisify(execFile);

// Local D1, for the few server rows the e2e suite writes directly: a seeded
// plan (plan.ts) and a purged session (sessions.ts). `--local` is fixed below,
// so nothing here can reach a deployed environment — it reads and writes
// miniflare's SQLite under `apps/bracemark-api/.wrangler/`.

const API_DIR = join(E2E_ROOT, '..', 'apps', 'bracemark-api');

// One statement against a local D1 binding, via the wrangler CLI. `--json`
// suppresses wrangler's banner, so the whole of stdout parses.
//
// SQLITE_BUSY is retried, and only that. The local database is one SQLite file
// shared by the running `wrangler dev` and every CLI invocation, and the parallel
// e2e workers each grant a plan: two `d1 execute`s landing together fail one of
// them with "database is locked" before either statement ran. That is contention
// for a file, not an outcome of the grant, so it is waited out rather than
// reported; every other failure still throws on the first attempt.
const D1_BUSY_ATTEMPTS = 20;

export async function d1(binding: string, sql: string): Promise<Record<string, unknown>[]> {
  requireLocalEnvironment('direct D1 fixtures');
  for (let attempt = 1; ; attempt++) {
    try {
      return await d1Once(binding, sql);
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message);
      if (!busy || attempt >= D1_BUSY_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * attempt, 2000) + Math.random() * 250),
      );
    }
  }
}

async function d1Once(binding: string, sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await run(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      binding,
      '--env',
      'development',
      '--local',
      '--json',
      '--command',
      sql,
    ],
    { cwd: API_DIR, maxBuffer: 16 * 1024 * 1024 },
  );
  // Defensive rather than superstitious: wrangler has historically printed an
  // update notice above --json output, and one stray line turns a parse error
  // into "the seed failed" with no clue why.
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`wrangler d1 execute returned no JSON:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start)) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

// SQLite string literal — the seed's inputs are its own constants, but a quoting
// bug here would corrupt the directory rather than fail, so it is spelled out.
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
