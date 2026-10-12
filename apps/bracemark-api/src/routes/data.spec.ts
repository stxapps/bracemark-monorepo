import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  DATA_DELETE_ALL_ERROR,
  dataDeleteAllEndpoint,
  filesListEndpoint,
  opsCommitEndpoint,
} from '@stxapps/shared';

import { app } from '../app';
import { usernamesRepo } from '../db/repositories/usernames';
import { userDataStub } from '../do/user-data';
import { userFileKey } from '../r2/keys';
import { issueSession } from '../services/session';

// End-to-end coverage of the delete-all data-plane route through the real Hono
// app + the real (miniflare) bindings, same style as sync.spec.ts: seed a user's
// namespace exactly as a client would (R2 PUT, then ops/commit), wipe it, then
// verify all three stores — R2, the op log, the quota map — through the same
// surfaces the sync engine reads. See docs/data-lifecycle.md.
describe('data lifecycle routes', () => {
  // A session AND the directory row that names its account: the route wipes only
  // for a body naming the account the token belongs to, so a session with no
  // username behind it can no longer delete anything.
  async function authFor(
    userId: string,
  ): Promise<{ userId: string; username: string; auth: Record<string, string> }> {
    const username = `${userId}-name`;
    await usernamesRepo(env.DIRECTORY_DB).claim({ username, userId, accountDbId: '1' });
    const { token } = await issueSession(env, { id: userId, accountDbId: '1' });
    return { userId, username, auth: { authorization: `Bearer ${token}` } };
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

  // What a wipe would have removed, read straight off the two stores.
  async function stored(userId: string, path: string): Promise<{ object: boolean; ops: number }> {
    const object = await env.USER_FILES.head(userFileKey(userId, path));
    const { ops } = await userDataStub(env, userId).listOps(null, null);
    return { object: object !== null, ops: ops.length };
  }

  it('rejects the call without a bearer token (401)', async () => {
    const res = await app.request(
      dataDeleteAllEndpoint.path,
      json({}, { username: 'nobody-name' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('wipes R2, the op log, and the quota map — and reports the count', async () => {
    const { userId, username, auth } = await authFor('data-wipe-1');
    await seedFile(userId, auth, 'links/a.enc');
    await seedFile(userId, auth, 'tags/t.enc');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, { username }), env);
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
    const { userId, username, auth } = await authFor('data-wipe-caller');
    const neighbor = await authFor('data-wipe-neighbor');
    await seedFile(userId, auth, 'links/mine.enc');
    await seedFile(neighbor.userId, neighbor.auth, 'links/theirs.enc');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, { username }), env);
    await expect(res.json()).resolves.toEqual({ deletedCount: 1 });

    const theirs = await env.USER_FILES.head(userFileKey(neighbor.userId, 'links/theirs.enc'));
    expect(theirs).not.toBeNull();
    const theirOps = await userDataStub(env, neighbor.userId).listOps(null, null);
    expect(theirOps.ops).toHaveLength(1);
  });

  it('is idempotent — an empty namespace deletes 0 and still succeeds', async () => {
    const { username, auth } = await authFor('data-wipe-empty');

    const res = await app.request(dataDeleteAllEndpoint.path, json(auth, { username }), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deletedCount: 0 });
  });

  // The bearer token says whose namespace a wipe would touch. It cannot say whose
  // the client MEANT: a client attaches whichever session is current as the request
  // leaves, and the flow behind this call can have decided to delete while another
  // account was signed in. So the body names the account, and a token that isn't
  // that account's wipes nothing — not its own namespace, and not the named one.
  describe('the account the body names', () => {
    it('refuses a token that belongs to another account, and wipes neither', async () => {
      const meant = await authFor('data-bind-meant');
      const current = await authFor('data-bind-current');
      await seedFile(meant.userId, meant.auth, 'links/meant.enc');
      await seedFile(current.userId, current.auth, 'links/current.enc');

      // The current account's token, on a request made for the other one.
      const res = await app.request(
        dataDeleteAllEndpoint.path,
        json(current.auth, { username: meant.username }),
        env,
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: DATA_DELETE_ALL_ERROR.accountMismatch,
      });
      await expect(stored(current.userId, 'links/current.enc')).resolves.toEqual({
        object: true,
        ops: 1,
      });
      await expect(stored(meant.userId, 'links/meant.enc')).resolves.toEqual({
        object: true,
        ops: 1,
      });
    });

    // The same answer as somebody else's name, so the code says nothing about which
    // usernames exist.
    it('refuses a name no account holds, the same way', async () => {
      const { userId, auth } = await authFor('data-bind-unknown');
      await seedFile(userId, auth, 'links/a.enc');

      const res = await app.request(
        dataDeleteAllEndpoint.path,
        json(auth, { username: 'no-such-account' }),
        env,
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: DATA_DELETE_ALL_ERROR.accountMismatch,
      });
      await expect(stored(userId, 'links/a.enc')).resolves.toEqual({ object: true, ops: 1 });
    });

    it('refuses the name of a deleted account, even for its own user id', async () => {
      const { userId, username, auth } = await authFor('data-bind-tombstone');
      await seedFile(userId, auth, 'links/a.enc');
      await usernamesRepo(env.DIRECTORY_DB).tombstone(username, userId);

      const res = await app.request(dataDeleteAllEndpoint.path, json(auth, { username }), env);

      expect(res.status).toBe(409);
      await expect(stored(userId, 'links/a.enc')).resolves.toEqual({ object: true, ops: 1 });
    });

    // A client from before the field existed sends `{}`. It fails CLOSED: an unbound
    // wipe is exactly what the field is there to stop.
    it('refuses a body that names no account (400), and wipes nothing', async () => {
      const { userId, auth } = await authFor('data-bind-missing');
      await seedFile(userId, auth, 'links/a.enc');

      const res = await app.request(dataDeleteAllEndpoint.path, json(auth, {}), env);

      expect(res.status).toBe(400);
      await expect(stored(userId, 'links/a.enc')).resolves.toEqual({ object: true, ops: 1 });
    });

    // The directory stores the canonical form, and so do the clients' sessions. The
    // comparison canonicalizes anyway, like sign-in does, so the bind never turns on
    // how a client happened to spell its own name.
    it('accepts the caller’s own name in another spelling', async () => {
      const { userId, username, auth } = await authFor('data-bind-spelling');
      await seedFile(userId, auth, 'links/a.enc');

      const res = await app.request(
        dataDeleteAllEndpoint.path,
        json(auth, { username: ` ${username.toUpperCase()} ` }),
        env,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ deletedCount: 1 });
    });
  });
});
