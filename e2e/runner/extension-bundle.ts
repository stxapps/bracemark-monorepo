import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type E2EEnvironment, STAGING_ORIGINS } from './environment';

// Which tier a browser-extension build talks to is baked in at build time —
// `WXT_PUBLIC_API_URL` from `.env.<mode>` into the bundle and the manifest's one
// host grant, the web-app origin from `utils/web-app-url.ts` — and the runner's
// origins cannot change it. A bundle that answers another tier still signs in and
// still syncs, against an api the run's accounts were not created on, so every
// case fails as a wrong password or a link that never arrives. An override
// in a gitignored `.env.staging.local` does exactly that and is invisible to
// `git`. So the runner reads the build it is about to stage before any account
// exists, the way the native Release receipt reads the embedded JS
// (release-artifact.ts, `assertStagingBundle`).

// The api and web origins of the tiers a run must NOT reach. Production is named
// here only to be refused; no runner can be pointed at it (environment.ts).
const OTHER_TIERS: Record<E2EEnvironment, string[]> = {
  local: [
    STAGING_ORIGINS.api,
    STAGING_ORIGINS.web,
    'https://api.bracemark.com',
    'https://app.bracemark.com',
  ],
  staging: [
    'http://localhost:8787',
    'http://localhost:3000',
    'https://api.bracemark.com',
    'https://app.bracemark.com',
  ],
};

export interface ExtensionBundle {
  hostPermissions: string[];
  // Every script in the build, concatenated.
  scripts: string;
}

export function extensionBundleProblems(
  bundle: ExtensionBundle,
  environment: E2EEnvironment,
  origins: { api: string; web: string },
): string[] {
  const problems: string[] = [];
  const grant = `${origins.api}/*`;
  if (bundle.hostPermissions.length !== 1 || bundle.hostPermissions[0] !== grant) {
    problems.push(
      `manifest host_permissions is ${JSON.stringify(bundle.hostPermissions)}, not ["${grant}"]`,
    );
  }
  for (const origin of [origins.api, origins.web]) {
    if (!bundle.scripts.includes(origin)) problems.push(`no script names ${origin}`);
  }
  for (const origin of OTHER_TIERS[environment]) {
    if (bundle.scripts.includes(origin)) problems.push(`a script names ${origin}`);
  }
  return problems;
}

async function scriptsUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(entry.parentPath, entry.name));
}

export async function assertExtensionBundle(
  directory: string,
  environment: E2EEnvironment,
  origins: { api: string; web: string },
): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
  };
  const scripts = await Promise.all(
    (await scriptsUnder(directory)).map((path) => readFile(path, 'utf8')),
  );
  const problems = extensionBundleProblems(
    { hostPermissions: manifest.host_permissions ?? [], scripts: scripts.join('\n') },
    environment,
    origins,
  );
  if (problems.length > 0) {
    throw new Error(
      `the ${environment} browser-extension build at ${directory} does not answer the run’s ` +
        `tier:\n  ${problems.join('\n  ')}\n` +
        'Check apps/bracemark-extension/.env.* (and any .env.*.local beside them).',
    );
  }
}
