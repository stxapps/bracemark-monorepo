import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { Bindings } from '../lib/env';
import { userFileKey } from './keys';
import { userFilesRepo } from './user-files';

// The bucket gateway. routes/sync.spec.ts drives it end to end — but only in the
// `development` env, where presigning is replaced by the dev blob proxy
// (r2/local.ts). So the two things pinned here are the ones that only exist off
// that env: the REAL presign branch namespacing each key under its caller, and
// the credential guard that must fail loudly rather than mint URLs a deploy
// can't use.

// A deployed-looking env: a real account id (so isLocalR2 is false) plus S3
// credentials, over the same real miniflare bucket binding.
const signingEnv = {
  ...env,
  R2_ACCOUNT_ID: 'a1b2c3d4e5f6000000000000000000ab',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretkey',
  R2_USER_FILES_BUCKET: 'bracemark-user-files',
} as Bindings;

// Stands in for the incoming request's URL. Only the local-dev blob-proxy branch
// reads it (r2/local.ts); on `signingEnv` the URL names R2's S3 endpoint instead,
// so every expectation below is about the presign and not about this.
const REQUEST_URL = 'https://api.example.com/v1/files/sign';

describe('userFilesRepo.presignUrls', () => {
  it('signs each path under the caller’s own prefix', async () => {
    const [signed] = await userFilesRepo(signingEnv).presignUrls(
      'u1',
      ['links/a.enc'],
      'PUT',
      300,
      REQUEST_URL,
    );

    expect(signed.path).toBe('links/a.enc'); // the wire path, unchanged
    const url = new URL(signed.url);
    expect(url.pathname).toBe('/bracemark-user-files/users/u1/links/a.enc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  // Cross-user signing is meant to be structurally impossible: the caller names
  // a RELATIVE path and the prefix is applied here, so the same path signed for
  // two accounts can only ever resolve to two different objects.
  it('cannot be made to sign another account’s object', async () => {
    const repo = userFilesRepo(signingEnv);
    const [mine] = await repo.presignUrls('u1', ['links/a.enc'], 'GET', 300, REQUEST_URL);
    const [theirs] = await repo.presignUrls('u2', ['links/a.enc'], 'GET', 300, REQUEST_URL);

    expect(new URL(mine.url).pathname).not.toBe(new URL(theirs.url).pathname);
    expect(new URL(theirs.url).pathname).toContain('/users/u2/');
  });

  // A deploy missing one secret would otherwise hand out URLs signed with
  // `undefined` — a 403 from R2 on every upload, surfacing as a broken sync
  // rather than as the configuration error it is.
  it('refuses to sign when a credential is missing', async () => {
    for (const missing of [
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_USER_FILES_BUCKET',
    ] as const) {
      const broken = { ...signingEnv, [missing]: '' } as Bindings;

      await expect(
        userFilesRepo(broken).presignUrls('u1', ['links/a.enc'], 'PUT', 300, REQUEST_URL),
      ).rejects.toMatchObject({ status: 500, code: 'r2_unconfigured' });
    }
  });
});

describe('userFilesRepo namespacing over the bucket binding', () => {
  it('heads and deletes only the caller’s objects', async () => {
    const repo = userFilesRepo(env);
    await env.USER_FILES.put(userFileKey('files-u1', 'links/shared-name.enc'), 'mine');
    await env.USER_FILES.put(userFileKey('files-u2', 'links/shared-name.enc'), 'theirs');

    // The same relative path resolves per user…
    await expect(repo.head('files-u1', 'links/shared-name.enc')).resolves.toMatchObject({
      size: 4,
    });
    await expect(repo.head('files-u1', 'links/never-written.enc')).resolves.toBeNull();

    // …and a delete of it takes only the caller's object with it.
    await repo.deleteMany('files-u1', ['links/shared-name.enc']);

    expect(await env.USER_FILES.head(userFileKey('files-u1', 'links/shared-name.enc'))).toBeNull();
    expect(
      await env.USER_FILES.head(userFileKey('files-u2', 'links/shared-name.enc')),
    ).not.toBeNull();
  });

  it('makes no bucket call for an empty delete batch', async () => {
    // A commit carrying no deletes must not issue a bulk delete at all (an empty
    // key list is an R2 error, not a no-op).
    await expect(userFilesRepo(env).deleteMany('files-u1', [])).resolves.toBeUndefined();
  });
});

// The commit's existence check (statMany). Whatever strategy it takes, it must
// answer exactly what a HEAD per path answers — present with R2's stamp and size,
// absent as absent — because that answer is the op-without-object invariant.
// The strategy itself is read off the calls it makes, through the same timer the
// commit's Server-Timing uses.
describe('userFilesRepo.statMany', () => {
  const id = (n: number) => `id-${String(n).padStart(4, '0')}`;

  function countingTimer() {
    const calls: Record<string, number> = {};
    const time = <T>(name: string, run: () => Promise<T>): Promise<T> => {
      calls[name] = (calls[name] ?? 0) + 1;
      return run();
    };
    return { calls, time };
  }

  async function seed(userId: string, paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => env.USER_FILES.put(userFileKey(userId, p), `bytes:${p}`)));
  }

  async function headsOf(userId: string, paths: string[]) {
    const repo = userFilesRepo(env);
    const out = new Map<string, { updatedAt: number; size: number }>();
    for (const path of paths) {
      const stat = await repo.head(userId, path);
      if (stat) out.set(path, stat);
    }
    return out;
  }

  it('answers a dense batch from listings, across page boundaries and namespaces', async () => {
    const userId = 'stat-dense';
    const links = Array.from({ length: 30 }, (_, n) => `links/${id(n)}.enc`);
    const extractions = Array.from({ length: 12 }, (_, n) => `extractions/${id(n)}.enc`);
    // Every fifth link never landed; a namespace's neighbours outside the batch
    // are listed too and must not leak into the answer.
    await seed(userId, [...links.filter((_, n) => n % 5 !== 0), ...extractions, 'tags/x.enc']);
    const batch = [...links, ...extractions];
    const { calls, time } = countingTimer();

    const found = await userFilesRepo(env).statMany(userId, batch, { time, pageSize: 13 });

    expect(found).toEqual(await headsOf(userId, batch));
    expect(found.size).toBe(24 + 12);
    expect(calls['r2-head']).toBeUndefined();
    // A page of 13 OBJECTS answers the batch keys up to its last, the missing
    // ones among them — 17 links on the first page, which keeps the walk on
    // listings: 24 link objects take 2 pages, the 12 extractions 1.
    expect(calls['r2-list']).toBe(2 + 1);
  });

  // A few edits among many objects: a page answers almost nothing, so the rest
  // of that namespace is HEADed rather than walked a page at a time — a page
  // answering under 13 keys cost more than HEADing them (r2/user-files.ts,
  // LIST_MIN_HITS).
  it('hands a sparse batch to HEADs after one page that answers too little', async () => {
    const userId = 'stat-sparse';
    const all = Array.from({ length: 60 }, (_, n) => `links/${id(n)}.enc`);
    await seed(userId, all);
    const batch = all.filter((_, n) => n % 4 === 0); // 15 keys, 3 objects apart
    const { calls, time } = countingTimer();

    const found = await userFilesRepo(env).statMany(userId, batch, { time, pageSize: 8 });

    expect(found).toEqual(await headsOf(userId, batch));
    expect(calls['r2-list']).toBe(1);
    expect(calls['r2-head']).toBe(batch.length - 2);
  });

  it('HEADs a small batch outright', async () => {
    const userId = 'stat-small';
    await seed(userId, ['links/a.enc', 'files/b.enc']);
    const batch = ['links/a.enc', 'files/b.enc', 'links/missing.enc'];
    const { calls, time } = countingTimer();

    const found = await userFilesRepo(env).statMany(userId, batch, { time });

    expect([...found.keys()].sort()).toEqual(['files/b.enc', 'links/a.enc']);
    expect(calls).toEqual({ 'r2-head': 3 });
  });

  it('reads only the caller’s namespace', async () => {
    const batch = Array.from({ length: 20 }, (_, n) => `links/${id(n)}.enc`);
    await seed('stat-other', batch);

    const found = await userFilesRepo(env).statMany('stat-mine', batch);

    expect(found.size).toBe(0);
  });
});
