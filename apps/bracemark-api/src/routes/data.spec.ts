import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { dataDeleteAllEndpoint, filesListEndpoint, opsCommitEndpoint } from '@stxapps/shared';

import { app } from '../app';
import { userDataStub } from '../do/user-data';
import { userFileKey } from '../r2/keys';
import { issueSession } from '../services/session';

// End-to-end coverage of the delete-all data-plane route through the real Hono
// app + the real (miniflare) bindings, same style as sync.spec.ts: seed a user's
// namespace exactly as a client would (R2 PUT, then ops/commit), wipe it, then
// verify all three stores — R2, the op log, the quota map — through the same
// surfaces the sync engine reads. See docs/data-lifecycle.md.
describe('data lifecycle routes', () => {
  async function authFor(
    userId: string,
  ): Promise<{ userId: string; auth: Record<string, string> }> {
    const { token } = await issueSession(env, { id: userId, accountDbId: '1' });
    return { userId, auth: { authorization: `Bearer ${token}` } };
  }

  const json = (auth: Record<string, string>, body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });

  // Seed one committed entity: the blob in R2 (as the client's presigned PUT
  // would land it) + its op recorded through the real commit route, so the op
  // log AND the quota map both hold state for the wipe to clear.
  async function seedFile(
    userId: string,
    auth: Record<string, string>,
    path: string,
  ): Promise<void> {
    await env.USER_FILES.put(userFileKey(userId, path), 'ciphertext');
    const res = await app.request(
      opsCommitEndpoint.path,
      json(auth, { ops: [{ op: 'put', path }] }),
      env,
    );
    expect(res.status).toBe(200);
  }

  it('rejects the call without a bearer token (401)', async () => {
    const res = await app.request(dataDeleteAllEndpoint.path, json({}, {}), env);
    expect(res.status).toBe(401);
  });

  it('wipes R2, the op log, and the quota map — and reports the count', async () => {
    const { userId, auth } = await authFor('data-wipe-1');
    await seedFile(userId, auth, 'links/a.enc');
    await seedFile(userId, auth, 'tags/t.enc');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, {}), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deletedCount: 2 });

    // R2: nothing left under the prefix — through the same fallback listing a
    // returning client reconciles against.
    const list = await app.request(filesListEndpoint.path, { headers: auth }, env);
    await expect(list.json()).resolves.toEqual({ files: [], nextPageToken: null });

    // Op log: wiped — null bounds are exactly what routes a returning client
    // (cursor set) into the download-authoritative fallback.
    const ops = await userDataStub(env, userId).listOps(null, null);
    expect(ops).toEqual({ ops: [], oldestUpdatedAt: null, newestUpdatedAt: null, hasMore: false });

    // Quota map: usage back to zero, so a fresh start isn't charged for deleted bytes.
    await expect(userDataStub(env, userId).usage()).resolves.toEqual({
      fileCount: 0,
      totalBytes: 0,
    });
  });

  it('wipes only the caller, never a neighbor namespace', async () => {
    const { userId, auth } = await authFor('data-wipe-caller');
    const neighbor = await authFor('data-wipe-neighbor');
    await seedFile(userId, auth, 'links/mine.enc');
    await seedFile(neighbor.userId, neighbor.auth, 'links/theirs.enc');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, {}), env);
    await expect(res.json()).resolves.toEqual({ deletedCount: 1 });

    const theirs = await env.USER_FILES.head(userFileKey(neighbor.userId, 'links/theirs.enc'));
    expect(theirs).not.toBeNull();
    const theirOps = await userDataStub(env, neighbor.userId).listOps(null, null);
    expect(theirOps.ops).toHaveLength(1);
  });

  it('is idempotent — an empty namespace deletes 0 and still succeeds', async () => {
    const { auth } = await authFor('data-wipe-empty');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, {}), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deletedCount: 0 });
  });
});
