// Checks that bracemark-web's service worker can still REPLACE the one already in
// users' browsers (docs/offline-mode.md, _`/sw.js` is permanent_).
//
//   node tools/scripts/check-service-worker.mjs <out-dir>                    the artifact
//   node tools/scripts/check-service-worker.mjs <out-dir> --origin <origin>  + the deployed copy
//
// `npm run check:service-worker` is the first form against apps/bracemark-web/out;
// tools/scripts/deploy-static.sh runs the first before it uploads anything and the
// second once the CDN serves the new build.
//
// WHY A SCRIPT AND NOT ONLY A TEST. A browser keeps its installed worker until a
// new one finishes INSTALLING, and Serwist's install is all-or-nothing: every URL
// in the precache manifest has to answer 200 or the whole install is thrown away
// and the old worker stays in control — in every browser that has one, with no
// error anywhere. Online that is easy to miss, because the worker hands a
// navigation the network's copy of the page (the navigation listener, sw.ts) and the
// new build appears to have arrived. What has not arrived is everything the
// worker answers from its precache: the build a device opens with the origin
// unreachable, which stays the old one deploy after deploy, and the route
// payloads an in-app move fetches. `e2e-pwa` proves that mechanism (PWA-010), but
// against its own static server; whether each manifest URL resolves on the REAL
// host is a fact about CloudFront + S3 (the clean-URL function, the bucket's keys)
// that only a request to that host settles.
//
// THE ARTIFACT HALF — no network, so it fails before a byte is published:
//   - every manifest URL names a file in the export, by the same mapping the
//     CloudFront function applies (tools/cloudfront/rewrite-url.js, rules 4-6);
//   - an entry without a revision is content-addressed (`/_next/static/…`). The
//     revision is what makes a new worker re-fetch a URL whose name did not change;
//     a stable name without one keeps the copy the FIRST worker fetched, however
//     many builds replace the file — the one way a worker that installs and
//     activates perfectly still holds old content (PWA-008).
//
// THE DEPLOYED HALF:
//   - `<origin>/sw.js` answers 200, as JavaScript, WITHOUT a redirect (a browser
//     refuses a redirected worker script), byte-identical to the artifact;
//   - every manifest URL answers 200 there.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// One manifest entry as `serwist build` writes it and the minifier leaves it:
// `{revision:"…",url:"…"}` / `{revision:null,url:"…"}`, keys quoted or not, in
// either order.
const KEY = (name) => `"?${name}"?\\s*:\\s*`;
const REVISION = '("(?:[^"\\\\]|\\\\.)*"|null)';
const URL_VALUE = '("(?:[^"\\\\]|\\\\.)*")';
const ENTRY = `\\{\\s*(?:${KEY('revision')}${REVISION}\\s*,\\s*${KEY('url')}${URL_VALUE}|${KEY('url')}${URL_VALUE}\\s*,\\s*${KEY('revision')}${REVISION})\\s*\\}`;

/**
 * The precache manifest inlined into a built worker.
 *
 * Throws unless the entries form exactly ONE array and nothing entry-shaped sits
 * outside it. That is what keeps this check from passing on a fraction of the
 * manifest: an entry shape this pattern does not know (a bare string, an
 * `integrity` field) splits the array, and a split array is refused rather than
 * half-read.
 *
 * @param {string} source - the text of `sw.js`
 * @returns {{ url: string, revision: string | null }[]}
 */
export function parsePrecacheManifest(source) {
  const arrays =
    source.match(new RegExp(`\\[\\s*${ENTRY}(?:\\s*,\\s*${ENTRY})*\\s*\\]`, 'g')) ?? [];
  const total = (source.match(new RegExp(ENTRY, 'g')) ?? []).length;
  if (arrays.length !== 1) {
    throw new Error(
      `expected one precache manifest in the worker, found ${arrays.length} — the manifest's shape changed; update ENTRY in tools/scripts/check-service-worker.mjs`,
    );
  }
  const entries = [...arrays[0].matchAll(new RegExp(ENTRY, 'g'))].map((match) => ({
    url: JSON.parse(match[2] ?? match[3]),
    revision: JSON.parse(match[1] ?? match[4]),
  }));
  if (entries.length !== total) {
    throw new Error(
      `the worker holds ${total} precache-shaped entries but its manifest array only ${entries.length}`,
    );
  }
  return entries;
}

/**
 * The export file a manifest URL is served from — the CloudFront function's
 * mapping (tools/cloudfront/rewrite-url.js, rules 4-6), not a local server's: no
 * `<path>/index.html`, because the CDN has no such rule.
 *
 * @param {string} url - a manifest URL, e.g. `/links` or `/links.txt`
 * @returns {string} a path relative to the export
 */
export function exportFileFor(url) {
  const path = decodeURIComponent(new URL(url, 'https://export.invalid').pathname);
  if (path === '/') return 'index.html';
  if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return path.slice(1);
  return `${path.slice(1)}.html`;
}

/**
 * @param {string} outDir - the static export
 * @returns {{ entries: { url: string, revision: string | null }[], problems: string[] }}
 */
export function checkArtifact(outDir) {
  const workerPath = join(outDir, 'sw.js');
  if (!existsSync(workerPath)) return { entries: [], problems: [`${workerPath} does not exist`] };
  const entries = parsePrecacheManifest(readFileSync(workerPath, 'utf8'));
  const problems = [];
  for (const { url, revision } of entries) {
    const file = join(outDir, exportFileFor(url));
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push(`${url} is precached but the export has no ${exportFileFor(url)}`);
    }
    if (revision === null && !url.startsWith('/_next/static/')) {
      problems.push(`${url} has no revision and is not content-addressed`);
    }
  }
  return { entries, problems };
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * @param {string} origin - e.g. `https://app.bracemark.com`
 * @param {string} outDir - the export that was deployed there
 * @param {{ url: string }[]} entries - its precache manifest
 * @returns {Promise<string[]>} problems
 */
export async function checkDeployed(origin, outDir, entries) {
  const problems = [];

  const workerUrl = new URL('/sw.js', origin);
  const worker = await fetch(workerUrl, { redirect: 'manual', cache: 'no-store' });
  const type = worker.headers.get('content-type') ?? '';
  if (worker.status !== 200) {
    problems.push(`${workerUrl} answered ${worker.status}, not 200`);
  } else if (!/javascript/i.test(type)) {
    problems.push(`${workerUrl} is served as '${type}', not JavaScript`);
  } else if (
    !sameBytes(new Uint8Array(await worker.arrayBuffer()), readFileSync(join(outDir, 'sw.js')))
  ) {
    problems.push(
      `${workerUrl} is not the sw.js in ${outDir} — the CDN still serves another build`,
    );
  }

  const queue = [...entries];
  const probe = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const url = new URL(entry.url, origin);
      try {
        const response = await fetch(url, { cache: 'no-store' });
        await response.body?.cancel();
        if (response.status !== 200) problems.push(`${url} answered ${response.status}, not 200`);
      } catch (error) {
        problems.push(`${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, probe));

  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const originAt = args.indexOf('--origin');
  const origin = originAt === -1 ? undefined : args[originAt + 1];
  if (originAt !== -1) args.splice(originAt, 2);
  const [outDir] = args;
  if (!outDir || (originAt !== -1 && !origin)) {
    console.error('Usage: check-service-worker.mjs <out-dir> [--origin <origin>]');
    process.exit(2);
  }

  const { entries, problems } = checkArtifact(outDir);
  if (problems.length === 0) {
    console.log(`ok: ${entries.length} precache entries, each a file in ${outDir}`);
    if (origin) {
      problems.push(...(await checkDeployed(origin, outDir, entries)));
      if (problems.length === 0) console.log(`ok: ${origin} serves this worker and all of them`);
    }
  }
  if (problems.length === 0) return;

  console.error(`\nBLOCKED: this worker cannot replace the one users already run.\n`);
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`);
  console.error(
    '\nA precache URL that does not answer 200 fails the new worker’s install, and every\n' +
      'installed browser silently keeps the previous worker and its precache\n' +
      '(docs/offline-mode.md, _`/sw.js` is permanent_).',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
