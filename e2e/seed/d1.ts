import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E2E_ROOT } from '../paths';
import { IS_STAGING, requireLocalEnvironment } from '../runner/environment';
import { STAGING_PLAN_GRANTS, stagingD1Token } from '../runner/staging-credential';

const run = promisify(execFile);

// D1, for the few server rows the e2e suite writes directly: a seeded plan
// (plan.ts) and a purged session (sessions.ts).
//
// Two doors, and they are not the same width. `d1` is LOCAL and takes any
// binding: `--local` is fixed below, so it reads and writes miniflare's SQLite
// under `apps/bracemark-api/.wrangler/` and refuses a staging run outright.
// `planD1` is the directory database alone, and is the one statement path that
// may also reach a deployed environment — staging's remote D1, for the plan
// grant and nothing else (below).

const API_DIR = join(E2E_ROOT, '..', 'apps', 'bracemark-api');

const LOCAL = ['--env', 'development', '--local'];
// `--env staging` is the guard, not the token. It resolves DIRECTORY_DB to the
// `database_id` committed under `env.staging` in wrangler.jsonc, and wrangler
// addresses the query to that id — so a token for the other tier, or an exported
// CLOUDFLARE_ACCOUNT_ID that names it, gets a refusal or a 404 for a database
// that account does not hold. Nothing here can spell production.
const STAGING = ['--env', 'staging', '--remote'];

// A remote statement is one HTTPS round trip. Bounded, so a stalled connection
// fails the grant instead of spending the case's whole timeout in silence.
const REMOTE_TIMEOUT_MS = 60_000;

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
      return await d1Once(binding, sql, LOCAL);
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message);
      if (!busy || attempt >= D1_BUSY_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * attempt, 2000) + Math.random() * 250),
      );
    }
  }
}

// One statement against the directory database, where a plan lives: local D1 on a
// local run, staging's REMOTE D1 on a staging one.
//
// This is the only write the suite makes to a deployed environment outside the
// app, and it is allowed for the reason plan.ts gives for the local one: a plan
// is plaintext server state that no client can author, and the `manual` row is a
// real product state rather than a test hook. Everything that is not a plan
// statement — the session purge above all — stays behind `d1`.
//
// On staging it runs only inside a run that declared it. The web runner proves
// the credential first (`proveStagingPlanAccess`) and marks its Playwright child;
// without that mark this throws, so a grant can never be the first moment a
// missing token is discovered, and no other entrypoint reaches staging by
// importing plan.ts.
export async function planD1(sql: string): Promise<Record<string, unknown>[]> {
  if (!IS_STAGING) return d1('DIRECTORY_DB', sql);
  if (process.env[STAGING_PLAN_GRANTS] !== '1') {
    throw new Error(
      'a plan grant on staging runs only for a web case that declares it: add ' +
        '"stagingGrants": ["plan"] to its cases.json entry, so the runner proves the ' +
        'Cloudflare credential before any account is created (e2e/STAGING.md)',
    );
  }
  return stagingDirectory(sql);
}

// Resolve the staging credential and prove it reaches the directory with the
// right to write, before the runner provisions anything. The statement changes
// no row — `WHERE 0` — but it is an UPDATE of the table a grant writes, so one
// round trip answers for the token, the account, the database and the
// `purchases` migration together. Returns where the token came from, for the log.
export async function proveStagingPlanAccess(): Promise<string> {
  if (!IS_STAGING) throw new Error('the staging plan preflight requires a staging run');
  const { from } = await stagingD1Token();
  await stagingDirectory('UPDATE purchases SET updated_at = updated_at WHERE 0');
  return from;
}

async function stagingDirectory(sql: string): Promise<Record<string, unknown>[]> {
  const { token } = await stagingD1Token();
  try {
    return await d1Once('DIRECTORY_DB', sql, STAGING, {
      // For this one child, and no longer: the Playwright worker and the browser
      // it launches never see it. Neither stream of the child ever holds it
      // either — it is passed in the environment, not on the command line.
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      timeout: REMOTE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `staging D1 refused or did not answer (DIRECTORY_DB, --env staging --remote):\n` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

async function d1Once(
  binding: string,
  sql: string,
  target: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<Record<string, unknown>[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      'npx',
      ['wrangler', 'd1', 'execute', binding, ...target, '--json', '--command', sql],
      { cwd: API_DIR, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL', ...options },
    ));
  } catch (error) {
    // ⚠ With `--json` wrangler reports a failed statement on STDOUT, as
    // `{"error": {"text": …}}`, and leaves stderr empty — while execFile's
    // message is the command line plus stderr. So the reason has to be put into
    // the message here or it is nowhere: the busy retry in `d1` matched on a
    // string that was never in it and retried nothing, and a refused staging
    // token read as a bare "Command failed".
    const reason = (error as { stdout?: string }).stdout?.trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(reason ? `${message}\n${reason}` : message, { cause: error });
  }
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
