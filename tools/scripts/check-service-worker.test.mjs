/**
 * `check-service-worker.mjs`, pinned.
 *
 *   npm run test:check-service-worker
 *
 * NOT part of `npm run test`, for the reason `tools/cloudfront/rewrite-url.test.mjs`
 * gives: `tools/` is not a project in the graph (docs/testing.md, _outside the two
 * runners_).
 *
 * The check exists to catch a failure that is silent everywhere else, so the way
 * IT fails silently is the thing to pin: reading only part of the manifest and
 * passing. Every refusal below has a passing control built from the same fixture.
 *
 * WHAT THIS CANNOT CATCH: whether a real CloudFront + S3 answers each URL. The
 * server here is node's, which is exactly the gap the deployed half of the check
 * closes when deploy-static.sh runs it against the real host.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  checkArtifact,
  checkDeployed,
  exportFileFor,
  parsePrecacheManifest,
} from './check-service-worker.mjs';

// The shape `serwist build` leaves after minification.
const worker = (entries) => `var _=[${entries.join(',')}];new Serwist({precacheEntries:_});`;
const PAGE = '{revision:"aaa",url:"/links"}';
const PAYLOAD = '{revision:"bbb",url:"/links/__next.!KGFwcCk.links.txt"}';
const CHUNK = '{revision:null,url:"/_next/static/chunks/0a1b.js"}';

const FILES = {
  'links.html': '<html></html>',
  'links/__next.!KGFwcCk.links.txt': 'rsc',
  '_next/static/chunks/0a1b.js': '//',
};

const dirs = [];
const tempDir = () => dirs[dirs.push(mkdtempSync(join(tmpdir(), 'check-service-worker-'))) - 1];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function exportWith(entries, files = FILES) {
  const dir = tempDir();
  for (const [name, body] of Object.entries({ ...files, 'sw.js': worker(entries) })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('parsePrecacheManifest', () => {
  it('reads every entry, in either key order, quoted or not', () => {
    const source = worker([PAGE, '{"url":"/","revision":"ccc"}', CHUNK]);

    assert.deepEqual(parsePrecacheManifest(source), [
      { url: '/links', revision: 'aaa' },
      { url: '/', revision: 'ccc' },
      { url: '/_next/static/chunks/0a1b.js', revision: null },
    ]);
  });

  it('refuses a manifest it can only read part of', () => {
    // A bare-string entry is legal to Serwist and unknown to this parser: it
    // must not be skipped, leaving the entries around it to pass on its behalf.
    assert.throws(() => parsePrecacheManifest(worker([PAGE, '"/offline"', CHUNK])), /manifest/);
    assert.throws(
      () => parsePrecacheManifest(worker([PAGE, '{integrity:"sha",revision:"d",url:"/x"}'])),
      /manifest/,
    );
  });

  it('refuses a worker with no manifest at all', () => {
    assert.throws(() => parsePrecacheManifest('new Serwist({precacheEntries:[]});'), /found 0/);
  });
});

describe('exportFileFor', () => {
  it('maps a URL the way the CloudFront function does', () => {
    assert.equal(exportFileFor('/'), 'index.html');
    assert.equal(exportFileFor('/settings/data'), 'settings/data.html');
    assert.equal(exportFileFor('/links.txt'), 'links.txt');
    assert.equal(
      exportFileFor('/settings/__next.!KGFwcCk.settings.txt'),
      'settings/__next.!KGFwcCk.settings.txt',
    );
  });
});

describe('checkArtifact', () => {
  it('passes an export that holds every precached URL', () => {
    const { entries, problems } = checkArtifact(exportWith([PAGE, PAYLOAD, CHUNK]));

    assert.equal(entries.length, 3);
    assert.deepEqual(problems, []);
  });

  it('names a precached URL the export has no file for', () => {
    const { problems } = checkArtifact(exportWith([PAGE, '{revision:"x",url:"/gone"}']));

    assert.deepEqual(problems, ['/gone is precached but the export has no gone.html']);
  });

  it('does not accept a directory index the CDN would never serve', () => {
    const dir = exportWith(['{revision:"x",url:"/settings"}'], { 'settings/index.html': '' });

    assert.equal(checkArtifact(dir).problems.length, 1);
  });

  it('names a stable URL shipped without a revision', () => {
    const { problems } = checkArtifact(exportWith(['{revision:null,url:"/links"}', CHUNK]));

    assert.deepEqual(problems, ['/links has no revision and is not content-addressed']);
  });

  it('reports a missing worker', () => {
    const dir = tempDir();

    assert.match(checkArtifact(dir).problems[0], /sw\.js does not exist/);
  });
});

describe('checkDeployed', () => {
  const dir = exportWith([PAGE, PAYLOAD, CHUNK]);
  const { entries } = checkArtifact(dir);
  // What the "CDN" does with a path, overridden per case.
  let respond;
  let server;
  let origin;

  before(async () => {
    server = createServer((request, response) => respond(request, response));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const faithful = (request, response) => {
    const path = decodeURIComponent(new URL(request.url, origin).pathname);
    if (path === '/sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      return response.end(worker([PAGE, PAYLOAD, CHUNK]));
    }
    const known = entries.some((entry) => entry.url === path);
    response.writeHead(known ? 200 : 404);
    response.end(known ? 'ok' : 'missing');
  };
  const except = (path, answer) => (request, response) =>
    new URL(request.url, origin).pathname === path ? answer(response) : faithful(request, response);

  it('passes a host that serves the worker and every entry', async () => {
    respond = faithful;

    assert.deepEqual(await checkDeployed(origin, dir, entries), []);
  });

  it('names a precache URL the host answers 404', async () => {
    respond = except('/links', (response) => response.writeHead(404).end());

    assert.deepEqual(await checkDeployed(origin, dir, entries), [
      `${origin}/links answered 404, not 200`,
    ]);
  });

  it('refuses a redirected worker script, which a browser will not install', async () => {
    respond = except('/sw.js', (response) =>
      response.writeHead(301, { location: '/sw.js?moved' }).end(),
    );

    assert.deepEqual(await checkDeployed(origin, dir, entries), [
      `${origin}/sw.js answered 301, not 200`,
    ]);
  });

  it('refuses a worker served as a page', async () => {
    respond = except('/sw.js', (response) =>
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>'),
    );

    assert.match((await checkDeployed(origin, dir, entries))[0], /not JavaScript/);
  });

  it('refuses a host still serving another build’s worker', async () => {
    respond = except('/sw.js', (response) =>
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(worker([PAGE])),
    );

    assert.match((await checkDeployed(origin, dir, entries))[0], /still serves another build/);
  });
});
