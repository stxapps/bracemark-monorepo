import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import {
  bytesToHex,
  changePasswordEndpoint,
  changePasswordPayloadSchema,
  type ChangePasswordResponse,
  checkUsernameEndpoint,
  type CheckUsernameResponse,
  createAccountEndpoint,
  createAccountPayloadSchema,
  type CreateAccountResponse,
  deleteAccountEndpoint,
  deleteAccountPayloadSchema,
  type DeleteAccountResponse,
  hexToBytes,
  passwordDoorEndpoint,
  type PasswordDoorResponse,
  putRecoveryDoorEndpoint,
  putRecoveryDoorPayloadSchema,
  type PutRecoveryDoorResponse,
  recoveryDoorEndpoint,
  type RecoveryDoorResponse,
  signInEndpoint,
  signInPayloadSchema,
  type SignInResponse,
  signOutEndpoint,
  signOutOthersEndpoint,
  type SignOutOthersResponse,
  type SignOutResponse,
} from '@stxapps/shared';

import { verifyAuthProof } from '../lib/auth-proof';
import type { AppEnv } from '../lib/env';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import {
  changePasswordDoor,
  createAccount,
  deleteAccount,
  getPasswordDoor,
  getRecoveryDoor,
  isUsernameTaken,
  putRecoveryDoor,
  signIn,
} from '../services/account';
import { revokeOtherSessions, revokeSession } from '../services/session';

// All routes carry their own '/v1/auth/…' path (from the shared contract,
// version prefix and all), so this sub-app is mounted at the root in app.ts.
export const authRoutes = new Hono<AppEnv>()
  .get(
    checkUsernameEndpoint.path,
    // Validates the query against the SAME schema the client used — the contract
    // is enforced on both ends from one definition in @stxapps/shared.
    zValidator('query', checkUsernameEndpoint.request),
    async (c) => {
      const { username } = c.req.valid('query');
      // Typing the payload against the contract makes the handler fail to compile
      // if the response shape ever drifts from checkUsernameResponseSchema.
      const body: CheckUsernameResponse = {
        available: !(await isUsernameTaken(c.env, username)),
      };
      return c.json(body);
    },
  )
  .post(
    createAccountEndpoint.path,
    // Account creation is expensive (a shard write + a session mint) and a prime
    // abuse target, so stack the tight tier on top of the global standard limit.
    rateLimit('tight'),
    // Validate only the OUTER envelope here ({ payload: string, signature }); the
    // inner signed payload is parsed + validated inside verifyAuthProof, after the
    // signature is checked over its exact bytes.
    zValidator('json', createAccountEndpoint.request),
    async (c) => {
      const { payload, signature } = c.req.valid('json');

      // Proof-of-possession: verify the signature over the exact signed bytes, and
      // that the payload is fresh and for this action, BEFORE provisioning anything.
      const proof = await verifyAuthProof(payload, signature, createAccountPayloadSchema);

      const result = await createAccount(c.env, {
        username: proof.username,
        publicKey: proof.publicKey,
        // The password door is always present; the recovery door is optional (the
        // ceremony lets users skip it). Both arrive hex-encoded in the signed
        // payload, so the signature covers exactly what we persist.
        doors: [
          {
            doorType: 'password',
            wrappedDek: hexToBytes(proof.passwordDoor.wrappedDek),
            iv: hexToBytes(proof.passwordDoor.iv),
          },
          ...(proof.recoveryDoor
            ? [
                {
                  doorType: 'recovery' as const,
                  wrappedDek: hexToBytes(proof.recoveryDoor.wrappedDek),
                  iv: hexToBytes(proof.recoveryDoor.iv),
                },
              ]
            : []),
        ],
      });

      const body: CreateAccountResponse = {
        token: result.session.token,
        expiresAt: result.session.expiresAt,
      };
      return c.json(body, 201);
    },
  )
  .get(
    passwordDoorEndpoint.path,
    // Pre-auth and an offline-attack oracle (it hands the wrapped DEK to anyone who
    // names a username), so stack the tight tier to blunt mass-scraping. Rate-limiting
    // is the defense here; username existence stays observable by design (see the
    // AWARENESS note on getPasswordDoor and docs/account.md).
    rateLimit('tight'),
    zValidator('query', passwordDoorEndpoint.request),
    async (c) => {
      const { username } = c.req.valid('query');
      // A missing user/door throws a 404 inside the service; the client maps it to
      // the same "incorrect username or password" as a wrong password, so the UI
      // stays opaque — though the 404-vs-200 is still an existence signal on the
      // wire, which we accept (see getPasswordDoor's AWARENESS note).
      const door = await getPasswordDoor(c.env, username);
      const body: PasswordDoorResponse = {
        wrappedDek: bytesToHex(door.wrappedDek),
        iv: bytesToHex(door.iv),
      };
      return c.json(body);
    },
  )
  .get(
    recoveryDoorEndpoint.path,
    // Pre-auth, same offline-oracle posture as the password door (tight tier to
    // blunt scraping). Here the code is high-entropy, so the served blob isn't a
    // brute-force target the way the password door is. 404s when the account has
    // no recovery door (skipped at create) — the client treats that like a wrong
    // code, so the "forgot password" UI stays opaque.
    rateLimit('tight'),
    zValidator('query', recoveryDoorEndpoint.request),
    async (c) => {
      const { username } = c.req.valid('query');
      const door = await getRecoveryDoor(c.env, username);
      const body: RecoveryDoorResponse = {
        wrappedDek: bytesToHex(door.wrappedDek),
        iv: bytesToHex(door.iv),
      };
      return c.json(body);
    },
  )
  .post(
    signInEndpoint.path,
    // Credential verification is a prime abuse target, so stack the tight tier.
    rateLimit('tight'),
    // Validate the OUTER envelope ({ payload: string, signature }); the inner signed
    // payload is parsed + validated inside verifyAuthProof, after the signature is
    // checked over its exact bytes.
    zValidator('json', signInEndpoint.request),
    async (c) => {
      const { payload, signature } = c.req.valid('json');

      // Proof-of-possession: verify the signature over the exact signed bytes, that
      // the payload is fresh, and that action === 'sign-in' (so a create-account
      // proof can't be replayed here). signIn then runs THE load-bearing check:
      // the presented publicKey must equal the stored credential for the username.
      const proof = await verifyAuthProof(payload, signature, signInPayloadSchema);

      const result = await signIn(c.env, {
        username: proof.username,
        publicKey: proof.publicKey,
      });

      const body: SignInResponse = {
        token: result.session.token,
        expiresAt: result.session.expiresAt,
      };
      return c.json(body);
    },
  )
  .post(
    signOutEndpoint.path,
    // Protected: the bearer token names the session to revoke. requireAuth
    // resolves it onto the context (404/expired tokens 401 out before here).
    // No 'tight' tier here (unlike the pre-auth routes above): this is authed,
    // cheap (one idempotent delete), and self-limiting — the first call removes
    // the row, so repeats 401 at requireAuth before the handler. Tightening it
    // would also be counterproductive: sign-out should reliably succeed so the
    // token actually gets revoked. The global 'standard' tier is enough.
    requireAuth,
    async (c) => {
      // Idempotent delete — a token that already passed requireAuth has a live
      // row; deleting it makes the token stop authenticating immediately.
      await revokeSession(c.env, c.get('session').id);
      const body: SignOutResponse = { ok: true };
      return c.json(body);
    },
  )
  .post(
    signOutOthersEndpoint.path,
    // "Sign out other devices" — session-only, like sign-out (its plural). No
    // fresh proof: this touches no doors or credentials and is low-harm and
    // reversible (the owner just signs back in), so requireAuth is the right gate,
    // exactly as for sign-out. Same 'standard' tier reasoning too — authed, cheap,
    // idempotent (re-running just deletes nothing more).
    requireAuth,
    async (c) => {
      await revokeOtherSessions(c.env, c.get('session'));
      const body: SignOutOthersResponse = { ok: true };
      return c.json(body);
    },
  )
  .post(
    deleteAccountEndpoint.path,
    // The most destructive call on the API — irreversible, whole-account. Tight
    // tier on top of the global limit (the proof verification alone makes it a
    // brute-force target if the bearer token leaked), and DOUBLE-guarded:
    // requireAuth names the account, the fresh signed proof proves the caller
    // still holds the DEK-derived key — a stolen session token alone is never
    // enough to erase an account.
    rateLimit('tight'),
    requireAuth,
    // Validate the OUTER envelope ({ payload: string, signature }); the inner
    // signed payload is parsed + validated inside verifyAuthProof, after the
    // signature is checked over its exact bytes.
    zValidator('json', deleteAccountEndpoint.request),
    async (c) => {
      const { payload, signature } = c.req.valid('json');

      // Proof-of-possession: signature over the exact signed bytes, freshness,
      // and action === 'delete-account' (a sign-in/create-account proof can't be
      // replayed here). deleteAccount then binds the proof to the SESSION's
      // account and runs the load-bearing stored-credential check + the
      // subscription gate before any teardown.
      const proof = await verifyAuthProof(payload, signature, deleteAccountPayloadSchema);

      await deleteAccount(c.env, c.get('session'), {
        username: proof.username,
        publicKey: proof.publicKey,
      });

      const body: DeleteAccountResponse = { ok: true };
      return c.json(body);
    },
  )
  .post(
    changePasswordEndpoint.path,
    // Tier-1 door rotation, double-guarded like delete-account: requireAuth names
    // the account and the fresh signed proof proves the caller still holds the
    // DEK-derived key (a stolen session token alone can't rotate a door — forging
    // the new wrapped door needs the DEK, which the session never carries).
    rateLimit('tight'),
    requireAuth,
    zValidator('json', changePasswordEndpoint.request),
    async (c) => {
      const { payload, signature } = c.req.valid('json');
      const proof = await verifyAuthProof(payload, signature, changePasswordPayloadSchema);

      await changePasswordDoor(c.env, c.get('session'), {
        username: proof.username,
        publicKey: proof.publicKey,
        door: {
          wrappedDek: hexToBytes(proof.passwordDoor.wrappedDek),
          iv: hexToBytes(proof.passwordDoor.iv),
        },
      });

      const body: ChangePasswordResponse = { ok: true };
      return c.json(body);
    },
  )
  .post(
    putRecoveryDoorEndpoint.path,
    // Same guards as change-password. Upsert: generates the recovery door if the
    // account had none, or replaces it (invalidating the old code) if it did.
    rateLimit('tight'),
    requireAuth,
    zValidator('json', putRecoveryDoorEndpoint.request),
    async (c) => {
      const { payload, signature } = c.req.valid('json');
      const proof = await verifyAuthProof(payload, signature, putRecoveryDoorPayloadSchema);

      await putRecoveryDoor(c.env, c.get('session'), {
        username: proof.username,
        publicKey: proof.publicKey,
        door: {
          wrappedDek: hexToBytes(proof.recoveryDoor.wrappedDek),
          iv: hexToBytes(proof.recoveryDoor.iv),
        },
      });

      const body: PutRecoveryDoorResponse = { ok: true };
      return c.json(body);
    },
  );
