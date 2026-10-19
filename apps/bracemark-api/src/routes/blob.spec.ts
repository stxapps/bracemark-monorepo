import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { BLOB_PATH, filesSignEndpoint, opsCommitEndpoint, type SignedUrl } from '@stxapps/shared';

import { app } from '../app';
import type { Bindings } from '../lib/env';
import { userFileKey } from '../r2/keys';
import { issueSession } from '../services/session';

// The blob route (routes/blob.ts) end to end through the real app and the real
// (miniflare) bucket: a client signs with `via: 'api'`, moves the bytes over the
// URL and header it was handed, and commits — the path a current client takes on
// every tier, local included. What a presign does is pinned in sync.spec.ts; the
// token's own refusals in r2/blob-token.spec.ts.
describe('the blob route', () => {
  async function authFor(userId: string): Promise<Record<string, string>> {
    const { token } = await issueSession(env, { id: userId, accountDbId: '1' });
    return { authorization: `Bearer ${token}` };
  }

  async function sign(
    auth: Record<string, string>,
    op: 'put' | 'get',
    paths: string[],
    origin = '',
  ): Promise<SignedUrl[]> {
    const res = await app.request(
      `${origin}${filesSignEndpoint.path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ op, paths, via: 'api' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { urls: SignedUrl[] }).urls;
  }

  const transfer = (signed: SignedUrl, init: RequestInit = {}, onEnv: Bindings = env) =>
    app.request(
      new URL(signed.url).pathname,
      {
        ...init,
        headers: { ...(signed.authorization ? { authorization: signed.authorization } : {}) },
      },
      onEnv,
    );

  it('signs every path to the one route, each with its own token', async () => {
    const auth = await authFor('blob-sign-1');
    const urls = await sign(auth, 'put', ['links/a.enc', 'links/b.enc']);

    expect(urls.map((u) => new URL(u.url).pathname)).toEqual([BLOB_PATH, BLOB_PATH]);
    expect(urls[0].authorization).toMatch(/^Blob v1\./);
    expect(urls[0].authorization).not.toBe(urls[1].authorization);
  });

  // The shipped clients send no `via`; what they are answered must not move.
  it('still presigns a request that names no transport', async () => {
    const auth = await authFor('blob-sign-2');
    const res = await app.request(
      filesSignEndpoint.path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ op: 'get', paths: ['links/a.enc'] }),
      },
      env,
    );
    const [signed] = ((await res.json()) as { urls: SignedUrl[] }).urls;

    expect(signed.authorization).toBeUndefined();
    expect(new URL(signed.url).pathname).not.toBe(BLOB_PATH);
  });

  // Same reason the dev proxy's URL takes the caller's origin (sync.spec.ts): a
  // physical iPhone reaches `wrangler dev` at the Mac's LAN address.
  it('names the origin the caller reached the api on', async () => {
    const auth = await authFor('blob-sign-3');
    const [signed] = await sign(auth, 'get', ['links/a.enc'], 'http://192.0.2.10:8787');

    expect(new URL(signed.url).origin).toBe('http://192.0.2.10:8787');
  });

  it('round-trips a blob: PUT, commit, GET', async () => {
    const userId = 'blob-rt-1';
    const auth = await authFor(userId);
    const [put] = await sign(auth, 'put', ['links/rt.enc']);

    const uploaded = await transfer(put, { method: 'PUT', body: 'ciphertext' });
    expect(uploaded.status).toBe(200);
    expect(await env.USER_FILES.head(userFileKey(userId, 'links/rt.enc'))).not.toBeNull();

    const commit = await app.request(
      opsCommitEndpoint.path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ ops: [{ op: 'put', path: 'links/rt.enc' }] }),
      },
      env,
    );
    const committed = (await commit.json()) as { results: { path: string }[] };
    expect(committed.results.map((r) => r.path)).toEqual(['links/rt.enc']);

    const [get] = await sign(auth, 'get', ['links/rt.enc']);
    const read = await transfer(get);
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.headers.get('content-type')).toBe('application/octet-stream');
    await expect(read.text()).resolves.toBe('ciphertext');
  });

  // A browser reads with the token as the body of a POST, never preflighted
  // (routes/blob.ts says why); a native client with it in the header of a GET.
  // Both are the same read grant.
  it('reads with the token as a POST body, as a browser does', async () => {
    const userId = 'blob-post-1';
    const auth = await authFor(userId);
    await env.USER_FILES.put(userFileKey(userId, 'links/p.enc'), 'ciphertext');
    const [get] = await sign(auth, 'get', ['links/p.enc']);
    const [put] = await sign(auth, 'put', ['links/p.enc']);

    const read = await app.request(
      BLOB_PATH,
      { method: 'POST', body: get.authorization, headers: { 'content-type': 'text/plain' } },
      env,
    );
    expect(read.status).toBe(200);
    await expect(read.text()).resolves.toBe('ciphertext');

    // A PUT token is a write grant; it reads nothing, by either door.
    const asRead = await app.request(BLOB_PATH, { method: 'POST', body: put.authorization }, env);
    expect(asRead.status).toBe(403);
  });

  // The engines skip a GET 404 as a delete they have not pulled yet; a 403
  // would fail the cycle instead.
  it('answers 404 for an object that is gone', async () => {
    const auth = await authFor('blob-404');
    const [get] = await sign(auth, 'get', ['links/never.enc']);

    expect((await transfer(get)).status).toBe(404);
  });

  // 403 throughout, as R2 answers a bad presign — never 401, which a client
  // reads as a statement about its session (docs/sessions.md).
  it('refuses a transfer with no token, a session, or the wrong method (403)', async () => {
    const auth = await authFor('blob-403');
    const [get] = await sign(auth, 'get', ['links/a.enc']);
    await env.USER_FILES.put(userFileKey('blob-403', 'links/a.enc'), 'ciphertext');

    expect((await app.request(BLOB_PATH, {}, env)).status).toBe(403);
    expect((await app.request(BLOB_PATH, { headers: auth }, env)).status).toBe(403);
    const write = await transfer(get, { method: 'PUT', body: 'overwritten' });
    expect(write.status).toBe(403);
    await expect(
      (await env.USER_FILES.get(userFileKey('blob-403', 'links/a.enc')))?.text(),
    ).resolves.toBe('ciphertext');
  });

  // One path for every object: an IP+path bucket sized for api calls would 429 a
  // sync within seconds, so the route is exempt from it and carries its own.
  it('is limited by its own tier, not the standard one', async () => {
    const auth = await authFor('blob-limit');
    const [get] = await sign(auth, 'get', ['links/a.enc']);
    const deny = { limit: async () => ({ success: false }) };

    expect((await transfer(get, {}, { ...env, API_RATE_LIMIT: deny })).status).toBe(404);
    expect((await transfer(get, {}, { ...env, API_RATE_LIMIT_BLOB: deny })).status).toBe(429);
  });
});
