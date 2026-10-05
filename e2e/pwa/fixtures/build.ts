import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Page } from '@playwright/test';

import { pwaRoot } from './pwa';

// LATER BUILDS of the staged export, "deployed" over a copy of it — what a browser
// that installed build A meets after a deploy (docs/offline-mode.md, _update
// policy_ and _`/sw.js` is permanent_).
//
// The run stages ONE real export (runner/web-export.ts), so a later build is that
// export with the four things a real deploy changes, changed by hand:
//
//   - a PAGE, a stable URL whose precache entry carries a revision — `/links`
//     here, marked so a case can tell which build's document it was handed;
//   - a new content-addressed ASSET, an entry with no revision, as every chunk is;
//   - the BUILD ID, in `/build.json` and in that page's `<html data-build>` — what
//     the update pill compares (apps/bracemark-web/src/lib/build-id.ts), so a
//     derived build's page and worker agree with each other and differ from A's,
//     exactly as a real build's do;
//   - the WORKER SCRIPT, whose manifest names all three.
//
// Every build is derived from the PRISTINE export (`pwaRoot()`, never written to),
// not from whatever was deployed last — so a fix deployed after a broken build
// does not inherit the breakage, exactly as a rebuild would not.
//
// This is not two `next build`s: the chunk graph is A's throughout, so what an old
// tab does when it asks the new worker for a chunk only A had is still unit-level
// (docs/offline-mode.md, _testing_). What it is, is the worker's whole update
// path — detect, install, activate, replace the precache — on real bytes.
//
// ⚠ WHICH BUILD A DOCUMENT CAME FROM DEPENDS ON THE ORIGIN, not only on the
// worker. The worker answers a navigation with the NETWORK's copy whenever the
// origin answers (the navigation listener, sw.ts) and with its precache only
// when it is not. So "the worker holds build B" is provable from a document only
// with the origin STOPPED; with it up, a document is the latest deploy's whatever
// the worker holds. Stop the origin before reading a marker as the worker's, or
// read the precache itself (`precachedRevisions`).

export interface DeployedBuild {
  // This build's id: in `/build.json` and on its `/links` document.
  id: string;
  // In this build's `/links` document, and in no other build's.
  marker: string;
  // The revision this build's manifest gives `/links`.
  revision: string;
  // A URL only this build precaches.
  asset: string;
  // The precache URL the origin answers 404 (`missingPrecacheEntry`).
  missing: string;
}

export interface BuildOptions {
  // `no-scripts`: `/links` ships without a single script — the limiting case of a
  // build whose page crashes before it mounts. No app code runs at all, so nothing
  // on the page can register, ask for an update, or show the pill.
  document?: 'working' | 'no-scripts';
  // Name a precache URL the origin answers 404, which fails this worker's install.
  missingPrecacheEntry?: boolean;
  // ⚠ For proving a case, never for a case: keep A's revision on the changed page —
  // the "stable URL, unchanged revision" bug. PWA-008 must fail with this set.
  keepPageRevision?: boolean;
}

const LINKS_ENTRY = /\{revision:"([0-9a-f]+)",url:"\/links"\}/g;
const BUILD_ENTRY = /\{revision:"[0-9a-f]+",url:"\/build\.json"\}/g;

// A copy of the staged export a case may deploy over. The caller removes it.
export async function stageCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bracemark-pwa-build-'));
  await cp(pwaRoot(), root, { recursive: true });
  return root;
}

// Deploy build `label` to `root`. The worker script goes last, as in a real deploy
// (tools/scripts/deploy-static.sh): the browser cannot find a worker before the
// files its manifest names exist.
export async function deployBuild(
  root: string,
  label: string,
  options: BuildOptions = {},
): Promise<DeployedBuild> {
  const pristine = pwaRoot();
  const marker = `<!--e2e-build:${label}-->`;
  const asset = `/_next/static/chunks/e2e-build-${label.toLowerCase()}.js`;
  const missing = `/e2e-missing-${label.toLowerCase()}.txt`;

  // Build A's id, wherever its `/links` carries it — the attribute, and the copy
  // of the root layout in the inline route payload — becomes this build's.
  const pristineId = (
    JSON.parse(await readFile(join(pristine, 'build.json'), 'utf8')) as { id: string }
  ).id;
  const id = `e2e-${label}-${Date.now()}`;
  const page = await readFile(join(pristine, 'links.html'), 'utf8');
  if (!page.includes(`data-build="${pristineId}"`)) {
    throw new Error('the staged /links does not carry its build id on <html data-build>');
  }
  const stamped = page.replaceAll(pristineId, id);
  const document =
    options.document === 'no-scripts'
      ? stamped.replace(/<script\b[^>]*>.*?<\/script>/gs, '')
      : stamped;

  const worker = await readFile(join(pristine, 'sw.js'), 'utf8');
  const found = [...worker.matchAll(LINKS_ENTRY)];
  if (found.length !== 1 || [...worker.matchAll(BUILD_ENTRY)].length !== 1) {
    throw new Error(
      'expected one /links and one /build.json entry in the staged worker’s manifest',
    );
  }
  const revision = options.keepPageRevision ? found[0][1] : `e2e-${label}-${Date.now()}`;
  const entries = [
    `{revision:"${revision}",url:"/links"}`,
    `{revision:null,url:"${asset}"}`,
    ...(options.missingPrecacheEntry ? [`{revision:"${revision}",url:"${missing}"}`] : []),
  ];

  await writeFile(join(root, 'links.html'), `${document}${marker}`);
  await writeFile(join(root, 'build.json'), JSON.stringify({ id }));
  await mkdir(dirname(join(root, asset)), { recursive: true });
  await writeFile(join(root, asset), `// e2e build ${label}\n`);
  await writeFile(
    join(root, 'sw.js'),
    `${worker
      .replace(LINKS_ENTRY, entries.join(','))
      .replace(BUILD_ENTRY, `{revision:"${id}",url:"/build.json"}`)}\n// e2e build ${label}\n`,
  );

  return { id, marker, revision, asset, missing };
}

// Ask the browser to check for a new worker now, instead of waiting for the check
// it makes by itself after a navigation.
//
// Deliberately returns NOTHING about the outcome. The browser's own check can be
// in flight when this is called, and the two are merged into one job — so an
// `updatefound` listener attached here can miss the event it is waiting for and
// never settle (measured: a case hung its full timeout that way). Read the
// outcome from state instead: `precachedRevisions` for a worker that activated,
// `StaticOrigin.answered` for an install that failed.
export async function requestUpdateCheck(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('no service worker registration');
    await registration.update().catch(() => undefined);
  });
}

// The revisions of `pathname` the worker's precache holds. One, once a build has
// activated: the previous build's copy is deleted on activation, so `[revision]`
// says both "this build installed" and "nothing older can be served". Read from
// Cache Storage, which needs no script on the page and does not wake the worker.
export async function precachedRevisions(page: Page, pathname: string): Promise<string[]> {
  return page.evaluate(async (path) => {
    const revisions: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.includes('precache')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.pathname === path) revisions.push(url.searchParams.get('__WB_REVISION__') ?? '');
      }
    }
    return revisions;
  }, pathname);
}

// The build the worker in control of this page holds: `/build.json`, answered from
// its precache. The same question the update pill asks.
export async function controllingBuild(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/build.json', { cache: 'no-store' });
    return ((await response.json()) as { id: string }).id;
  });
}
