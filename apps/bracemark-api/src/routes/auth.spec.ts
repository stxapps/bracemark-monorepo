import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  changePasswordEndpoint,
  checkUsernameEndpoint,
  deleteAccountEndpoint,
  DOOR_PASSWORD,
  DOOR_RECOVERY,
  passwordDoorEndpoint,
  putRecoveryDoorEndpoint,
  recoveryDoorEndpoint,
  signInEndpoint,
  signOutEndpoint,
  signOutOthersEndpoint,
} from '@stxapps/shared';

import { app } from '../app';
import { accountKeysRepo } from '../db/repositories/account-keys';
import { purchasesRepo } from '../db/repositories/purchases';
import { sessionsRepo } from '../db/repositories/sessions';
import { usernamesRepo } from '../db/repositories/usernames';
import { usersRepo } from '../db/repositories/users';
import { hashToken, newId } from '../lib/ids';
import { userFileKey } from '../r2/keys';
import { createAccount } from '../services/account';
import { issueSession } from '../services/session';

// Build request URLs from the shared contract path so these stay correct across
// version-prefix changes (e.g. /v1 → /v2) without editing every literal here.
const usernamePath = checkUsernameEndpoint.path;

// app.request(path, init, env) — the third arg is the bindings the handlers see.
// Under vitest-pool-workers `env` is the REAL local Workers env (D1/R2/DO/rate
// limits), so the username routes that query DIRECTORY_DB actually run. Storage
// is isolated per test (see vitest.config.ts) and seeded with migrations only.
describe('auth routes', () => {
  describe(`GET ${checkUsernameEndpoint.path}`, () => {
    it('reports an available username', async () => {
      const res = await app.request(`${usernamePath}?username=freshname`, {}, env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ available: true });
    });

    it('reports a taken username, case-insensitively', async () => {
      // Seed the directory with the canonical (lowercase) form, then query a
      // different-cased spelling: the lookup canonicalizes, so 'Zoe_42' must
      // resolve to the stored 'zoe_42' and report unavailable.
      await usernamesRepo(env.DIRECTORY_DB).claim({
        username: 'zoe_42',
        userId: 'u_seed',
        accountDbId: '1',
      });

      const res = await app.request(`${usernamePath}?username=Zoe_42`, {}, env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ available: false });
    });

    // This one needs no DB: it fails at the zValidator (shared schema) before the
    // handler ever touches a binding.
    it('rejects a username that fails the shared validation rules', async () => {
      const res = await app.request(`${usernamePath}?username=no`, {}, env);

      expect(res.status).toBe(400);
    });

    // The reserved-name blocklist lives in the shared usernameSchema, so it's
    // enforced at the zValidator server-side too — a reserved handle never reaches
    // the handler (and any casing collapses to the canonical form first).
    it('rejects a reserved username at the server', async () => {
      const res = await app.request(`${usernamePath}?username=Admin`, {}, env);

      expect(res.status).toBe(400);
    });
  });

  // Generate a REAL Ed25519 keypair in the Workers runtime (workerd has Web Crypto
  // Ed25519), seed an account holding its publicKey + a password door, and return
  // what a sign-in needs. This exercises the actual signature path + the
  // load-bearing publicKey comparison without importing the client crypto lib
  // (@stxapps/web-crypto is platform:web; bracemark-api is platform:worker).
  async function newKeyPair(): Promise<{ keyPair: CryptoKeyPair; publicKey: string }> {
    const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    return { keyPair, publicKey: bytesToHex(raw) };
  }

  async function sign(keyPair: CryptoKeyPair, payload: string): Promise<string> {
    const sig = await crypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(payload),
    );
    return bytesToHex(new Uint8Array(sig));
  }

  // A realistic password door: a 48-byte wrapped DEK (32-byte DEK + 16-byte GCM
  // tag) and a 12-byte IV. The bytes are filler — the server stores and echoes them
  // opaquely; only the client ever unwraps.
  const door = { wrappedDek: new Uint8Array(48).fill(7), iv: new Uint8Array(12).fill(9) };

  async function seedAccount(
    username: string,
  ): Promise<{ keyPair: CryptoKeyPair; publicKey: string }> {
    const kp = await newKeyPair();
    await createAccount(env, {
      username,
      publicKey: kp.publicKey,
      doors: [{ doorType: 'password', ...door }],
    });
    return kp;
  }

  describe(`GET ${passwordDoorEndpoint.path}`, () => {
    it('returns the password door blob for an existing account', async () => {
      await seedAccount('doorholder');

      const res = await app.request(`${passwordDoorEndpoint.path}?username=doorholder`, {}, env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        wrappedDek: bytesToHex(door.wrappedDek),
        iv: bytesToHex(door.iv),
      });
    });

    it('returns 404 for an unknown username', async () => {
      const res = await app.request(`${passwordDoorEndpoint.path}?username=ghostuser`, {}, env);

      expect(res.status).toBe(404);
    });

    it('rejects a malformed username at the contract boundary', async () => {
      const res = await app.request(`${passwordDoorEndpoint.path}?username=no`, {}, env);

      expect(res.status).toBe(400);
    });
  });

  describe(`POST ${signInEndpoint.path}`, () => {
    const body = (payload: string, signature: string) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload, signature }),
    });

    it('issues a session for a valid proof matching the stored credential', async () => {
      const { keyPair, publicKey } = await seedAccount('validsigner');
      const payload = JSON.stringify({
        action: 'sign-in',
        username: 'validsigner',
        publicKey,
        timestamp: Date.now(),
      });

      const res = await app.request(
        signInEndpoint.path,
        body(payload, await sign(keyPair, payload)),
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { token: string; expiresAt: number };
      expect(typeof json.token).toBe('string');
      expect(typeof json.expiresAt).toBe('number');
      // The session is real — resolvable by token hash, exactly what the auth guard reads.
      expect(
        await sessionsRepo(env.SESSIONS_DB).findByTokenHash(await hashToken(json.token)),
      ).not.toBeNull();
    });

    it('rejects a valid proof for an unknown username with an opaque 401', async () => {
      const { keyPair, publicKey } = await newKeyPair();
      const payload = JSON.stringify({
        action: 'sign-in',
        username: 'noaccount',
        publicKey,
        timestamp: Date.now(),
      });

      const res = await app.request(
        signInEndpoint.path,
        body(payload, await sign(keyPair, payload)),
        env,
      );

      expect(res.status).toBe(401);
    });

    it('rejects a valid signature whose key is not the stored credential', async () => {
      // Seed under one key, then sign with a DIFFERENT key and present it in the
      // payload. The signature is internally valid, so this isolates THE
      // load-bearing check: the presented key ≠ stored credential ⇒ 401.
      await seedAccount('keymismatch');
      const other = await newKeyPair();
      const payload = JSON.stringify({
        action: 'sign-in',
        username: 'keymismatch',
        publicKey: other.publicKey,
        timestamp: Date.now(),
      });

      const res = await app.request(
        signInEndpoint.path,
        body(payload, await sign(other.keyPair, payload)),
        env,
      );

      expect(res.status).toBe(401);
    });

    it('rejects a create-account proof replayed at sign-in (action mismatch)', async () => {
      const { keyPair, publicKey } = await seedAccount('replayer');
      // action 'create-account' fails signInPayloadSchema's z.literal('sign-in')
      // inside verifyAuthProof → 400, never reaching the credential lookup.
      const payload = JSON.stringify({
        action: 'create-account',
        username: 'replayer',
        publicKey,
        timestamp: Date.now(),
      });

      const res = await app.request(
        signInEndpoint.path,
        body(payload, await sign(keyPair, payload)),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe(`POST ${signOutEndpoint.path}`, () => {
    // The real client sends an empty JSON body — the session to revoke is named by
    // the bearer token, not the body — so mirror that here.
    const post = (headers: Record<string, string>) =>
      app.request(
        signOutEndpoint.path,
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' },
        env,
      );

    it('revokes the session for a valid bearer token', async () => {
      // Mint a real session, then confirm it resolves BEFORE sign-out so the
      // post-condition (it's gone) is meaningful rather than vacuously true.
      const { token } = await issueSession(env, { id: 'u_signout', accountDbId: '1' });
      const tokenHash = await hashToken(token);
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(tokenHash)).not.toBeNull();

      const res = await post({ authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      // The row is deleted, so the same token no longer authenticates — exactly
      // what the auth guard checks on the next request.
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(tokenHash)).toBeNull();
    });

    it('rejects a request with no bearer token', async () => {
      const res = await post({});

      expect(res.status).toBe(401);
    });

    it('rejects an unknown bearer token', async () => {
      const res = await post({ authorization: 'Bearer not-a-real-token' });

      expect(res.status).toBe(401);
    });
  });

  describe(`POST ${signOutOthersEndpoint.path}`, () => {
    const post = (headers: Record<string, string>) =>
      app.request(
        signOutOthersEndpoint.path,
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' },
        env,
      );

    it('revokes the account’s other sessions but keeps the caller’s', async () => {
      // Two live sessions for the same account: the caller (this device) and one
      // other device.
      const mine = await issueSession(env, { id: 'u_soo', accountDbId: '1' });
      const other = await issueSession(env, { id: 'u_soo', accountDbId: '1' });
      const mineHash = await hashToken(mine.token);
      const otherHash = await hashToken(other.token);
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(otherHash)).not.toBeNull();

      const res = await post({ authorization: `Bearer ${mine.token}` });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      // The other device is gone; the caller's own session still authenticates.
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(otherHash)).toBeNull();
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(mineHash)).not.toBeNull();
    });

    it('leaves OTHER accounts’ sessions untouched', async () => {
      const mine = await issueSession(env, { id: 'u_soo_a', accountDbId: '1' });
      const stranger = await issueSession(env, { id: 'u_soo_b', accountDbId: '1' });
      const strangerHash = await hashToken(stranger.token);

      const res = await post({ authorization: `Bearer ${mine.token}` });

      expect(res.status).toBe(200);
      // A different user's session is never in scope of this account's revoke.
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(strangerHash)).not.toBeNull();
    });

    it('rejects a request with no bearer token', async () => {
      const res = await post({});

      expect(res.status).toBe(401);
    });
  });

  describe(`POST ${deleteAccountEndpoint.path}`, () => {
    // Seed a full account THROUGH the service (directory claim + shard rows +
    // session), returning everything a delete-account call needs: the session's
    // bearer header and the keypair to sign the fresh proof with.
    async function seedFullAccount(username: string) {
      const kp = await newKeyPair();
      const { userId, session } = await createAccount(env, {
        username,
        publicKey: kp.publicKey,
        doors: [{ doorType: 'password', ...door }],
      });
      return {
        ...kp,
        userId,
        token: session.token,
        auth: { authorization: `Bearer ${session.token}` },
      };
    }

    const signedBody = async (keyPair: CryptoKeyPair, payload: string) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload, signature: await sign(keyPair, payload) }),
    });

    const deletePayload = (username: string, publicKey: string) =>
      JSON.stringify({ action: 'delete-account', username, publicKey, timestamp: Date.now() });

    it('tears the account down: data, doors, user row, sessions, tombstone', async () => {
      const acct = await seedFullAccount('goodbye');
      // Something in the data plane, so the wipe half is observable too.
      await env.USER_FILES.put(userFileKey(acct.userId, 'links/x.enc'), 'ciphertext');

      const req = await signedBody(acct.keyPair, deletePayload('goodbye', acct.publicKey));
      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });

      // Shard rows gone — credential and doors together (the cryptographic kill).
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).toBeNull();
      expect(await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserId(acct.userId)).toEqual([]);
      // Every session revoked — the token that made this very call is dead.
      expect(
        await sessionsRepo(env.SESSIONS_DB).findByTokenHash(await hashToken(acct.token)),
      ).toBeNull();
      // Data plane wiped.
      expect(await env.USER_FILES.head(userFileKey(acct.userId, 'links/x.enc'))).toBeNull();
      // Directory row TOMBSTONED, not deleted: still present (occupied), marked.
      const entry = await usernamesRepo(env.DIRECTORY_DB).findByUsername('goodbye');
      expect(entry).not.toBeNull();
      expect(entry?.deletedAt).not.toBeNull();
    });

    it('keeps the tombstoned username occupied and sign-in opaque', async () => {
      const acct = await seedFullAccount('tombstoned');
      const req = await signedBody(acct.keyPair, deletePayload('tombstoned', acct.publicKey));
      await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      // Availability: taken, forever.
      const avail = await app.request(`${checkUsernameEndpoint.path}?username=tombstoned`, {}, env);
      await expect(avail.json()).resolves.toEqual({ available: false });
      // The pre-auth door fetch answers like a name that never existed.
      const doorRes = await app.request(
        `${passwordDoorEndpoint.path}?username=tombstoned`,
        {},
        env,
      );
      expect(doorRes.status).toBe(404);
      // A re-claim (create-account) loses to the tombstone's PK — clean 409.
      const kp = await newKeyPair();
      const claimed = await usernamesRepo(env.DIRECTORY_DB).claim({
        username: 'tombstoned',
        userId: 'u_newcomer',
        accountDbId: '1',
      });
      expect(claimed).toBe(false);
      void kp;
    });

    it('rejects the call without a bearer token', async () => {
      const acct = await seedFullAccount('nobearer');
      const req = await signedBody(acct.keyPair, deletePayload('nobearer', acct.publicKey));

      const res = await app.request(deleteAccountEndpoint.path, req, env);

      expect(res.status).toBe(401);
      // Nothing was torn down.
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).not.toBeNull();
    });

    it('rejects a valid signature whose key is not the stored credential', async () => {
      // A stolen bearer token + a self-signed proof: the signature is internally
      // valid, so this isolates the load-bearing stored-credential check.
      const acct = await seedFullAccount('stolentoken');
      const thief = await newKeyPair();
      const req = await signedBody(thief.keyPair, deletePayload('stolentoken', thief.publicKey));

      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(401);
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).not.toBeNull();
    });

    it('rejects a proof for a DIFFERENT account riding this session', async () => {
      // Account B signs a perfectly valid proof for B — but the bearer session
      // names A, so the proof→session binding refuses it and neither account is
      // touched.
      const a = await seedFullAccount('bindinga');
      const b = await seedFullAccount('bindingb');
      const req = await signedBody(b.keyPair, deletePayload('bindingb', b.publicKey));

      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...a.auth } },
        env,
      );

      expect(res.status).toBe(401);
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(a.userId)).not.toBeNull();
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(b.userId)).not.toBeNull();
    });

    it('rejects a sign-in proof replayed here (action mismatch)', async () => {
      const acct = await seedFullAccount('actionbound');
      const payload = JSON.stringify({
        action: 'sign-in',
        username: 'actionbound',
        publicKey: acct.publicKey,
        timestamp: Date.now(),
      });
      const req = await signedBody(acct.keyPair, payload);

      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('refuses with 409 while the subscription would keep billing', async () => {
      const acct = await seedFullAccount('stillbilling');
      // A renewing Paddle subscription: active, period end in the future, not
      // canceled ⇒ willRenew — the gate case.
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId: acct.userId,
        source: 'paddle',
        externalId: `sub-${acct.userId}`,
        plan: 'plus',
        status: 'active',
        providerCustomerId: 'ctm_test',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        canceledAt: null,
        eventOccurredAt: Date.now(),
      });

      const req = await signedBody(acct.keyPair, deletePayload('stillbilling', acct.publicKey));
      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: 'subscription_active' });
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).not.toBeNull();
    });

    it('allows deletion once the subscription is canceled (entitlement forfeited)', async () => {
      const acct = await seedFullAccount('canceledsub');
      // Canceled but still inside the paid period: entitled, willRenew false —
      // billing already ended, so deletion proceeds.
      const end = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId: acct.userId,
        source: 'paddle',
        externalId: `sub-${acct.userId}`,
        plan: 'plus',
        status: 'canceled',
        providerCustomerId: 'ctm_test',
        expiresAt: end,
        canceledAt: Date.now(),
        eventOccurredAt: Date.now(),
      });

      const req = await signedBody(acct.keyPair, deletePayload('canceledsub', acct.publicKey));
      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).toBeNull();
    });

    it('skips the subscription gate on a resumed teardown (already tombstoned)', async () => {
      // Crash-recovery path: a first delete already tombstoned the directory
      // entry but didn't finish (here the crash landed before the shard batch,
      // so the user row is still present). The SAME renewing subscription that
      // 409s a fresh delete (test above) must NOT strand a committed teardown —
      // once tombstoned the gate is skipped, so the retry proceeds.
      const acct = await seedFullAccount('resumedteardown');
      await usernamesRepo(env.DIRECTORY_DB).tombstone('resumedteardown', acct.userId);
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId: acct.userId,
        source: 'paddle',
        externalId: `sub-${acct.userId}`,
        plan: 'plus',
        status: 'active',
        providerCustomerId: 'ctm_test',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        canceledAt: null,
        eventOccurredAt: Date.now(),
      });

      const req = await signedBody(acct.keyPair, deletePayload('resumedteardown', acct.publicKey));
      const res = await app.request(
        deleteAccountEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      // Proceeds despite the renewing subscription, and finishes the teardown.
      expect(res.status).toBe(200);
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).toBeNull();
      expect(
        await sessionsRepo(env.SESSIONS_DB).findByTokenHash(await hashToken(acct.token)),
      ).toBeNull();
    });
  });

  // A DISTINCT door from `door` above, so an upsert/rotation is observable — the
  // stored blob must change to this. Filler bytes; the server never unwraps.
  const newDoor = { wrappedDek: new Uint8Array(48).fill(3), iv: new Uint8Array(12).fill(4) };
  const hexDoor = (d: { wrappedDek: Uint8Array; iv: Uint8Array }) => ({
    wrappedDek: bytesToHex(d.wrappedDek),
    iv: bytesToHex(d.iv),
  });

  // Seed a full account (directory + shard rows + session), optionally with a
  // recovery door too, returning what the authed door-rotation calls need.
  async function seedSessioned(username: string, withRecovery = false) {
    const kp = await newKeyPair();
    const { userId, session } = await createAccount(env, {
      username,
      publicKey: kp.publicKey,
      doors: [
        { doorType: 'password', ...door },
        ...(withRecovery ? [{ doorType: 'recovery' as const, ...door }] : []),
      ],
    });
    return {
      ...kp,
      userId,
      token: session.token,
      auth: { authorization: `Bearer ${session.token}` },
    };
  }

  const signedReq = async (keyPair: CryptoKeyPair, payload: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, signature: await sign(keyPair, payload) }),
  });

  describe(`GET ${recoveryDoorEndpoint.path}`, () => {
    it('returns the recovery door blob when the account has one', async () => {
      await seedSessioned('recoveryholder', true);

      const res = await app.request(
        `${recoveryDoorEndpoint.path}?username=recoveryholder`,
        {},
        env,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(hexDoor(door));
    });

    it('returns 404 when the account skipped recovery (password door only)', async () => {
      await seedAccount('norecovery');

      const res = await app.request(`${recoveryDoorEndpoint.path}?username=norecovery`, {}, env);

      expect(res.status).toBe(404);
    });
  });

  describe(`POST ${changePasswordEndpoint.path}`, () => {
    const payload = (username: string, publicKey: string) =>
      JSON.stringify({
        action: 'change-password',
        username,
        publicKey,
        passwordDoor: hexDoor(newDoor),
        timestamp: Date.now(),
      });

    it('re-wraps the password door for a valid proof + bearer', async () => {
      const acct = await seedSessioned('pwchanger');
      const req = await signedReq(acct.keyPair, payload('pwchanger', acct.publicKey));

      const res = await app.request(
        changePasswordEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      // The stored password door is now the NEW blob; publicKey untouched.
      const stored = await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserIdAndDoorType(
        acct.userId,
        DOOR_PASSWORD,
      );
      expect(stored?.wrappedDek).toEqual(newDoor.wrappedDek);
      expect(stored?.version).toBe(2); // bumped from 1 on the re-wrap
      expect(await usersRepo(env.ACCOUNTS_DB_1).findById(acct.userId)).toMatchObject({
        publicKey: acct.publicKey,
      });
    });

    it('signs out other devices but keeps the caller’s own session', async () => {
      const acct = await seedSessioned('pwrevoke');
      // A second device: another live session for the same account.
      const other = await issueSession(env, { id: acct.userId, accountDbId: '1' });
      const otherHash = await hashToken(other.token);
      const thisHash = await hashToken(acct.token);
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(otherHash)).not.toBeNull();

      const req = await signedReq(acct.keyPair, payload('pwrevoke', acct.publicKey));
      const res = await app.request(
        changePasswordEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      // The other device is revoked; the session that made this call survives.
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(otherHash)).toBeNull();
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(thisHash)).not.toBeNull();
    });

    it('rejects without a bearer token (session-only is never enough)', async () => {
      const acct = await seedSessioned('pwnobearer');
      const req = await signedReq(acct.keyPair, payload('pwnobearer', acct.publicKey));

      const res = await app.request(changePasswordEndpoint.path, req, env);

      expect(res.status).toBe(401);
      const stored = await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserIdAndDoorType(
        acct.userId,
        DOOR_PASSWORD,
      );
      expect(stored?.wrappedDek).toEqual(door.wrappedDek); // unchanged
    });

    it('rejects a valid signature whose key is not the stored credential', async () => {
      const acct = await seedSessioned('pwthief');
      const thief = await newKeyPair();
      const req = await signedReq(thief.keyPair, payload('pwthief', thief.publicKey));

      const res = await app.request(
        changePasswordEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  describe(`POST ${putRecoveryDoorEndpoint.path}`, () => {
    const payload = (username: string, publicKey: string) =>
      JSON.stringify({
        action: 'put-recovery-door',
        username,
        publicKey,
        recoveryDoor: hexDoor(newDoor),
        timestamp: Date.now(),
      });

    it('creates the recovery door when the account had none', async () => {
      const acct = await seedSessioned('addrecovery'); // password door only
      expect(
        await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserIdAndDoorType(
          acct.userId,
          DOOR_RECOVERY,
        ),
      ).toBeNull();

      const req = await signedReq(acct.keyPair, payload('addrecovery', acct.publicKey));
      const res = await app.request(
        putRecoveryDoorEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      const stored = await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserIdAndDoorType(
        acct.userId,
        DOOR_RECOVERY,
      );
      expect(stored?.wrappedDek).toEqual(newDoor.wrappedDek);
      expect(stored?.version).toBe(1);
    });

    it('replaces (regenerates) an existing recovery door, bumping its version', async () => {
      const acct = await seedSessioned('regenrecovery', true); // seeded with `door`
      const req = await signedReq(acct.keyPair, payload('regenrecovery', acct.publicKey));

      const res = await app.request(
        putRecoveryDoorEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      const stored = await accountKeysRepo(env.ACCOUNTS_DB_1).findByUserIdAndDoorType(
        acct.userId,
        DOOR_RECOVERY,
      );
      expect(stored?.wrappedDek).toEqual(newDoor.wrappedDek);
      expect(stored?.version).toBe(2);
    });

    it('leaves other sessions alone (regenerating a recovery code is not a sign-out)', async () => {
      const acct = await seedSessioned('recoverykeepssessions', true);
      const other = await issueSession(env, { id: acct.userId, accountDbId: '1' });
      const otherHash = await hashToken(other.token);

      const req = await signedReq(acct.keyPair, payload('recoverykeepssessions', acct.publicKey));
      const res = await app.request(
        putRecoveryDoorEndpoint.path,
        { ...req, headers: { ...req.headers, ...acct.auth } },
        env,
      );

      expect(res.status).toBe(200);
      // Unlike change-password, both devices stay signed in.
      expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(otherHash)).not.toBeNull();
    });
  });
});
