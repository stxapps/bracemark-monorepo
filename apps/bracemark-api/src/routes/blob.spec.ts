import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { BLOB_PATH, filesSignEndpoint, opsCommitEndpoint, type SignedUrl } from '@stxapps/shared';

import { app } from '../app';
import { userDataStub } from '../do/user-data';
import type { Bindings } from '../lib/env';
import { BLOB_AUTH_SCHEME, mintBlobToken } from '../r2/blob-token';
import { userFileKey } from '../r2/keys';
import { issueSession } from '../services/session';
import { deleteAllUserData } from '../services/sync';

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

  // A PUT answers with an upload receipt, and a commit that carries it records the
  // put without asking R2 whether it landed (r2/upload-receipt.ts) — the check
  // whose time grew with the library (docs/local-first-sync.md, _upload
  // receipts_). Each case below is a way the shortcut could record an op for an
  // object that is not there, or refuse one that is; the fence's own semantics
  // are pinned against the DO in do/user-data.spec.ts.
  describe('upload receipts', () => {
    type Committed = {
      results: { path: string; updatedAt: number }[];
      failed: { path: string; reason: string }[];
    };

    async function upload(signed: SignedUrl, body = 'ciphertext'): Promise<string | undefined> {
      const res = await transfer(signed, { method: 'PUT', body });
      expect(res.status).toBe(200);
      return ((await res.json()) as { receipt?: string }).receipt;
    }

    async function commit(
      auth: Record<string, string>,
      ops: { op: 'put' | 'delete'; path: string; receipt?: string }[],
    ): Promise<Committed> {
      const res = await app.request(
        opsCommitEndpoint.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ ops }),
        },
        env,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Committed;
    }

    // Proven by taking the object away behind the api's back: a commit that
    // still records the put never looked at R2, and one without the receipt,
    // which must, refuses it.
    it('records a receipted put at R2’s own stamp and size without asking R2', async () => {
      const userId = 'receipt-skip';
      const auth = await authFor(userId);
      const [a, b] = await sign(auth, 'put', ['links/a.enc', 'links/b.enc']);
      const receipt = await upload(a, 'ciphertext');
      await upload(b);
      const object = await env.USER_FILES.head(userFileKey(userId, 'links/a.enc'));
      await env.USER_FILES.delete([
        userFileKey(userId, 'links/a.enc'),
        userFileKey(userId, 'links/b.enc'),
      ]);

      expect(receipt).toMatch(/^v1\./);
      const committed = await commit(auth, [
        { op: 'put', path: 'links/a.enc', receipt },
        { op: 'put', path: 'links/b.enc' },
      ]);

      expect(committed.results).toEqual([
        { path: 'links/a.enc', updatedAt: object?.uploaded.getTime() },
      ]);
      expect(committed.failed).toEqual([{ path: 'links/b.enc', reason: 'no_object' }]);
      expect(await userDataStub(env, userId).usage()).toEqual({
        fileCount: 1,
        totalBytes: 'ciphertext'.length,
      });
    });

    it('checks R2 for a put whose receipt is another user’s', async () => {
      const auth = await authFor('receipt-owner');
      const [signed] = await sign(auth, 'put', ['links/a.enc']);
      const receipt = await upload(signed);

      const committed = await commit(await authFor('receipt-thief'), [
        { op: 'put', path: 'links/a.enc', receipt },
      ]);

      expect(committed.results).toEqual([]);
      expect(committed.failed).toEqual([{ path: 'links/a.enc', reason: 'no_object' }]);
    });

    // Another device's delete of the path, committed between this device's sign
    // and its commit, took the object this receipt describes.
    it('checks R2 for a receipted put whose path was deleted since its sign', async () => {
      const userId = 'receipt-deleted';
      const auth = await authFor(userId);
      const [signed] = await sign(auth, 'put', ['pins/l_a.enc']);
      const receipt = await upload(signed);
      await commit(auth, [{ op: 'delete', path: 'pins/l_a.enc' }]);

      const committed = await commit(auth, [{ op: 'put', path: 'pins/l_a.enc', receipt }]);

      expect(committed.failed).toEqual([{ path: 'pins/l_a.enc', reason: 'no_object' }]);
      const { ops } = await userDataStub(env, userId).listOps(null, null);
      expect(ops.map((o) => o.op)).toEqual(['delete']);
    });

    // The same fence, where the object DOES exist again — the delete landed
    // before this PUT re-created it. The receipt is turned down, R2 is asked,
    // and the whole batch lands, the clear receipt beside it included.
    it('records the whole batch from R2 when the fence turns one receipt down', async () => {
      const userId = 'receipt-recheck';
      const auth = await authFor(userId);
      const [pin, link] = await sign(auth, 'put', ['pins/l_a.enc', 'links/b.enc']);
      await commit(auth, [{ op: 'delete', path: 'pins/l_a.enc' }]);
      const pinReceipt = await upload(pin);
      const linkReceipt = await upload(link);

      const committed = await commit(auth, [
        { op: 'put', path: 'pins/l_a.enc', receipt: pinReceipt },
        { op: 'put', path: 'links/b.enc', receipt: linkReceipt },
      ]);

      expect(committed.results.map((r) => r.path)).toEqual(['pins/l_a.enc', 'links/b.enc']);
      expect(committed.failed).toEqual([]);
    });

    // A wipe appends no delete; only the log's generation says one happened.
    it('checks R2 for a receipted put from before a wipe', async () => {
      const userId = 'receipt-wiped';
      const auth = await authFor(userId);
      const [signed] = await sign(auth, 'put', ['links/a.enc']);
      const receipt = await upload(signed);
      await deleteAllUserData(env, userId);

      const committed = await commit(auth, [{ op: 'put', path: 'links/a.enc', receipt }]);

      expect(committed.failed).toEqual([{ path: 'links/a.enc', reason: 'no_object' }]);
      expect((await userDataStub(env, userId).listOps(null, null)).ops).toEqual([]);
    });

    // A token minted before receipts carries no fence, so the receipt it would
    // need cannot be vouched for — the PUT answers with none, and its commit is
    // checked against R2 as before.
    it('answers a PUT under a token with no fence with no receipt', async () => {
      const userId = 'receipt-old-token';
      const token = await mintBlobToken(env.R2_SECRET_ACCESS_KEY ?? '', {
        userId,
        path: 'links/a.enc',
        method: 'PUT',
        expiresIn: 300,
      });

      const res = await app.request(
        BLOB_PATH,
        {
          method: 'PUT',
          body: 'ciphertext',
          headers: { authorization: `${BLOB_AUTH_SCHEME} ${token}` },
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });
  });
});
