import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT } from '../paths';
import { API_URL } from '../web/fixtures/env';
import { inherit } from './process';

// bracemark-web's production export, built against the LOCAL stack and staged
// into a run directory. Two callers need the bytes a deployed tier would serve
// rather than the dev server's: the PWA runner (runner/pwa.ts), for the service
// worker that development never registers, and the data-path measurement
// (measure/data-web.ts), because React's development build does several times the
// main-thread work of the production one and would overstate every number.
//
// A module of its own because runner/pwa.ts runs its `main()` on import: a second
// caller importing from there would start a PWA run (the trap seed/steps.ts
// describes).

const REPO_ROOT = join(E2E_ROOT, '..');
const EXPORT_DIR = join(REPO_ROOT, 'apps', 'bracemark-web', 'out');
// The deployed tiers' api origins. A staged export naming either is a build of
// the wrong environment, and would test nothing here — or worse, reach them.
const DEPLOYED_APIS = ['https://api.bracemark.com', 'https://api.dryrunbase.com'];

// The production build (NODE_ENV=production, `serwist build` after `next
// build`) of the DEVELOPMENT env: .env.development's origins through the
// target's `envFile`, exactly the way `staging` gets its own
// (docs/env-files.md).
export const WEB_EXPORT_BUILD = [
  'nx',
  'build',
  '@stxapps/bracemark-web',
  '--configuration=development',
];

export interface StagedWebExport {
  root: string;
  precacheEntries: number;
}

// Build, then copy out at once, so the run uses these bytes even if `out/` is
// rebuilt meanwhile, and the run directory records them. `build: false` stages
// whatever `out/` holds now — still checked below, so a deployed-tier build is
// refused either way.
export async function stageLocalWebExport(
  runDir: string,
  options: { build?: boolean } = {},
): Promise<StagedWebExport> {
  if (options.build !== false) await inherit('npx', WEB_EXPORT_BUILD, { cwd: REPO_ROOT });
  const root = join(runDir, 'web-export');
  await cp(EXPORT_DIR, root, { recursive: true });
  return { root, ...(await assertLocalBuild(root)) };
}

// Prove the staged export is the build this run needs: a service worker, and
// a bundle whose baked api origin is the local one.
async function assertLocalBuild(root: string): Promise<{ precacheEntries: number }> {
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const chunksDir = join(root, '_next', 'static', 'chunks');
  const chunks = (await readdir(chunksDir)).filter((name) => name.endsWith('.js'));
  let local = false;
  for (const name of chunks) {
    const source = await readFile(join(chunksDir, name), 'utf8');
    const deployed = DEPLOYED_APIS.find((origin) => source.includes(origin));
    if (deployed)
      throw new Error(`the staged export names ${deployed} (${name}) — not a local build`);
    if (source.includes(API_URL)) local = true;
  }
  if (!local) throw new Error(`no chunk of the staged export names ${API_URL}`);
  return { precacheEntries: (sw.match(/revision/g) ?? []).length };
}
