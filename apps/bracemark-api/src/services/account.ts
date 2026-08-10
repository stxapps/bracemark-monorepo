import { DOOR_PASSWORD, DOOR_RECOVERY, type DoorType } from '@stxapps/shared';

import { accountsDb, assignAccountDbId } from '../db/db-routes';
import { accountKeysRepo } from '../db/repositories/account-keys';
import { sessionsRepo } from '../db/repositories/sessions';
import { usernamesRepo } from '../db/repositories/usernames';
import { usersRepo } from '../db/repositories/users';
import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { newId } from '../lib/ids';
import { getSubscriptionStatus } from './iap';
import { type IssuedSession, issueSession, revokeOtherSessions } from './session';
import { deleteAllUserData } from './sync';

// Account creation under the DEK door model, across separate databases. The root
// of an account is a random DEK (generated client-side, never sent); the client
// sends the derived public key plus one wrapped-DEK blob per "door" (password at
// minimum). The user's actual data lives in the durable object keyed by userId.
// See docs/account.md.
//
// The username DIRECTORY (DIRECTORY_DB) and the account rows (an ACCOUNTS_DB_N
// shard) are in different databases, so this is CLAIM-THEN-WRITE rather than one
// transaction: (1) claim the username (the authoritative uniqueness gate), (2)
// atomically write users + account_keys in the shard, (3) release the claim if
// (2) fails so a crash mid-create can't orphan the name. Uniqueness is always
// enforced (directory PK) and users↔account_keys stay atomic (same shard); only
// the claim↔account link is non-transactional, with the orphan reclaimable.
//
// STATUS: wired end-to-end. POST /v1/auth/create-account (routes/auth.ts) verifies
// proof-of-possession + the signed contract (verifyAuthProof over the shared
// createAccountPayloadSchema), then calls this to claim + write. This service owns
// only the claim-then-write; the route owns transport + proof. The orphan-claim
// sweeper is still open — see docs/account.md "open items".

export type CreateAccountResult = {
  userId: string;
  session: IssuedSession;
};

// One wrapped-DEK door to persist. wrappedDek = AES-256-GCM(KEK, DEK), iv = its
// GCM nonce. At create-account this is at least the 'password' door.
export type CreateAccountDoor = {
  doorType: DoorType;
  wrappedDek: Uint8Array;
  iv: Uint8Array;
};

export type CreateAccountInput = {
  username: string;
  publicKey: string;
  doors: CreateAccountDoor[];
};

// Cheap pre-check behind GET /v1/auth/username-available. NOT authoritative: the
// claim in createAccount is the real race guard. The directory lives in
// DIRECTORY_DB (global), queried directly, not via db-routes.
export async function isUsernameTaken(env: Bindings, username: string): Promise<boolean> {
  return (await usernamesRepo(env.DIRECTORY_DB).findByUsername(username)) !== null;
}

export async function createAccount(
  env: Bindings,
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  // Proof-of-possession and contract/door validation already happened upstream in
  // the route (verifyAuthProof + the zod request schema), so this trusts its typed
  // input and owns only the claim-then-write.

  const directory = usernamesRepo(env.DIRECTORY_DB);
  const userId = newId();

  // Placement: which shard this account's rows go in, stored explicitly on the
  // account (and its directory/session rows). Today always '1'; the policy lives
  // in assignAccountDbId(). The claim ALWAYS stays in the global directory.
  const accountDbId = assignAccountDbId();

  // (1) CLAIM the username — the authoritative, race-free uniqueness gate. A
  // concurrent claim of the same name returns false (no row written), not an
  // error, so a lost race is a clean 409.
  const claimed = await directory.claim({ username: input.username, userId, accountDbId });
  if (!claimed) {
    throw new HttpError(409, 'username_taken', 'Username is already taken');
  }

  // (2) WRITE the account in the shard — users + every wrapped-DEK door in ONE
  // atomic batch (all-or-nothing). This is a DIFFERENT db than the directory, so
  // it can't join the claim in a single transaction.
  const shard = accountsDb(env, accountDbId);
  const users = usersRepo(shard);
  const keys = accountKeysRepo(shard);
  try {
    await shard.batch([
      users.insertStmt({ id: userId, publicKey: input.publicKey }),
      ...input.doors.map((d) =>
        keys.insertStmt({ userId, doorType: d.doorType, wrappedDek: d.wrappedDek, iv: d.iv }),
      ),
    ]);
  } catch (err) {
    // (3) COMPENSATE: the account write failed after we claimed the name, so
    // release the claim to avoid orphaning the username. Best-effort — if this
    // also fails (e.g. the worker dies), a sweeper reclaims claims that have no
    // backing `users` row after a short TTL (TODO: wire the sweeper alongside
    // sessions.deleteExpired). Uniqueness is never violated either way.
    await directory.release(input.username, userId).catch(() => {
      // Best-effort: if the compensating release itself fails, the orphan claim
      // is reclaimed by the sweeper (TODO) — never block on cleanup here.
    });
    // Log the cause for observability (wrangler tail); never leak it to the client.
    console.error('createAccount shard write failed:', err);
    throw new HttpError(500, 'account_create_failed', 'Could not create account, please retry');
  }

  const session = await issueSession(env, { id: userId, accountDbId });
  return { userId, session };
}

// Sign-in, step 1 (PRE-AUTH): hand back the password door's wrapped DEK for a
// username so the client can unwrap the DEK and derive its keys. Resolve the
// username through the directory (the only username→account map), then read the
// 'password' door from the user's shard. A missing user or door is a 404; a hit is
// a 200 with the blob. The client maps that 404 to the same "incorrect username or
// password" message as a wrong password, so the UI stays opaque — but on the wire
// the 404-vs-200 still distinguishes which usernames exist.
//
// AWARENESS (not a TODO): that existence signal is ACCEPTED, by design. Masking it
// here in isolation would buy nothing, because GET /v1/auth/username-available
// (isUsernameTaken, above) is an intentional existence oracle that signup UX
// requires — it already leaks the same bit, cheaply. So username existence is
// observable on purpose; this path is rate-limited to blunt mass-scraping, not
// existence-masked. The real defense for this pre-auth offline-attack oracle is
// password entropy (the entropy gate / generated passphrase), not blob secrecy —
// see docs/account.md "why the wrapped DEK is served pre-auth".
export async function getPasswordDoor(
  env: Bindings,
  username: string,
): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array }> {
  const entry = await usernamesRepo(env.DIRECTORY_DB).findByUsername(username);
  // A tombstone (deleted account — the name stays occupied) answers exactly like
  // a name that never existed: there is no door to serve, and the deleted state
  // shouldn't be distinguishable from absent on this pre-auth path.
  if (!entry || entry.deletedAt !== null) {
    throw new HttpError(404, 'not_found', 'No account for that username');
  }

  const password = await accountKeysRepo(
    accountsDb(env, entry.accountDbId),
  ).findByUserIdAndDoorType(entry.userId, DOOR_PASSWORD);
  if (!password) throw new HttpError(404, 'not_found', 'No password door for that account');

  return { wrappedDek: password.wrappedDek, iv: password.iv };
}

// The RECOVERY-door analogue of getPasswordDoor (pre-auth): hand back the recovery
// door's wrapped DEK for a username so a client that lost its password can unwrap
// the DEK with the recovery code. Same directory→shard resolution and tombstone
// opacity. A 404 here means either no such account OR an account that never set up
// a recovery door (it's skippable) — indistinguishable on this pre-auth path, and
// the client maps both to "check your recovery code" the same way.
export async function getRecoveryDoor(
  env: Bindings,
  username: string,
): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array }> {
  const entry = await usernamesRepo(env.DIRECTORY_DB).findByUsername(username);
  if (!entry || entry.deletedAt !== null) {
    throw new HttpError(404, 'not_found', 'No account for that username');
  }

  const recovery = await accountKeysRepo(
    accountsDb(env, entry.accountDbId),
  ).findByUserIdAndDoorType(entry.userId, DOOR_RECOVERY);
  if (!recovery) throw new HttpError(404, 'not_found', 'No recovery door for that account');

  return { wrappedDek: recovery.wrappedDek, iv: recovery.iv };
}

// Shared guard for the tier-1 door rotations (change password, put recovery
// door). Binds the fresh signed proof to the authed session's account and runs
// the load-bearing stored-credential check — the SAME defense as delete-account:
// a bearer token alone must never mutate an account's doors. A door rotation on a
// tombstoned/absent account is simply invalid (no tombstone exception like
// deleteAccount's resumed-teardown case — there is nothing to resume). Returns the
// account shard for the follow-up upsert.
async function authorizeDoorRotation(
  env: Bindings,
  session: { userId: string; accountDbId: string },
  proof: { username: string; publicKey: string },
): Promise<D1Database> {
  const invalid = () => new HttpError(401, 'invalid_credentials', 'Incorrect username or password');

  const entry = await usernamesRepo(env.DIRECTORY_DB).findByUsername(proof.username);
  if (!entry || entry.deletedAt !== null || entry.userId !== session.userId) throw invalid();

  const shard = accountsDb(env, session.accountDbId);
  const user = await usersRepo(shard).findById(session.userId);
  // publicKey is unchanged by any door rotation (only the DEK wrapping changes),
  // so the presented credential must still equal the stored one.
  if (!user || proof.publicKey !== user.publicKey) throw invalid();

  return shard;
}

// Change the password door (authed + fresh proof). Tier-1 rotation: the client
// recovered the DEK by opening an existing door (current password OR recovery
// code — never seen here), re-wrapped it under the new password's KEK, and signed.
// We only replace the 'password' door row; the DEK, publicKey, and data are
// untouched.
//
// But we DO revoke every OTHER session (keeping this one — the UI stays signed in
// on this device). A password change can't un-leak data an attacker already
// exfiltrated (no DEK rotation — docs/account.md), but it must cut off ongoing
// access: whoever had the old password can no longer mint new sessions, and any
// session they already minted dies here. The upsert is the load-bearing mutation,
// so it lands first; session revocation is idempotent hygiene after it.
export async function changePasswordDoor(
  env: Bindings,
  session: { id: string; userId: string; accountDbId: string },
  proof: { username: string; publicKey: string; door: { wrappedDek: Uint8Array; iv: Uint8Array } },
): Promise<void> {
  const shard = await authorizeDoorRotation(env, session, proof);
  await accountKeysRepo(shard)
    .upsertStmt({
      userId: session.userId,
      doorType: DOOR_PASSWORD,
      wrappedDek: proof.door.wrappedDek,
      iv: proof.door.iv,
    })
    .run();
  await revokeOtherSessions(env, session);
}

// Generate/regenerate the recovery door (authed + fresh proof). Upsert: writes the
// door if the account had none, or replaces it (invalidating the old code) if it
// did. Same tier-1 rotation guarantees as changePasswordDoor.
export async function putRecoveryDoor(
  env: Bindings,
  session: { userId: string; accountDbId: string },
  proof: { username: string; publicKey: string; door: { wrappedDek: Uint8Array; iv: Uint8Array } },
): Promise<void> {
  const shard = await authorizeDoorRotation(env, session, proof);
  await accountKeysRepo(shard)
    .upsertStmt({
      userId: session.userId,
      doorType: DOOR_RECOVERY,
      wrappedDek: proof.door.wrappedDek,
      iv: proof.door.iv,
    })
    .run();
}

// Sign-in, step 3: mint a session for a proven sign-in. Proof-of-possession (the
// signature over the payload, freshness, and action) is verified upstream in the
// route via verifyAuthProof; this owns THE load-bearing check — that the presented
// `publicKey` equals the STORED credential for the username — plus the session
// mint. Without that comparison anyone could "sign in" with their own keypair (see
// docs/account.md "the load-bearing sign-in check"). Every credential miss returns
// the SAME opaque 401 so it leaks neither which username exists nor why it failed.
export async function signIn(
  env: Bindings,
  input: { username: string; publicKey: string },
): Promise<{ userId: string; session: IssuedSession }> {
  const invalid = () => new HttpError(401, 'invalid_credentials', 'Incorrect username or password');

  const entry = await usernamesRepo(env.DIRECTORY_DB).findByUsername(input.username);
  // A tombstone is an expected miss (the account was deleted; the name stays
  // occupied) — same opaque answer, no error log.
  if (!entry || entry.deletedAt !== null) throw invalid();

  const user = await usersRepo(accountsDb(env, entry.accountDbId)).findById(entry.userId);
  if (!user) {
    // The directory points at a user row that must exist (both are Tier-0, written
    // together; a deleted account is tombstoned above, not dangling). A dangling
    // pointer is a server-side inconsistency, not a caller error — log it for
    // observability but still answer opaquely.
    console.error('signIn: directory references missing user', entry.userId);
    throw invalid();
  }

  // publicKey is a public credential (not a secret), so a plain compare is fine —
  // there's no secret to leak via timing. It must match the key the signature was
  // already verified against upstream.
  if (input.publicKey !== user.publicKey) throw invalid();

  const session = await issueSession(env, { id: user.id, accountDbId: entry.accountDbId });
  return { userId: user.id, session };
}

// The full account teardown (POST /v1/auth/delete-account). The route verified
// the fresh signed proof (verifyAuthProof over deleteAccountPayloadSchema) and
// resolved the bearer session; this owns the proof→account binding, the
// load-bearing publicKey check, the subscription gate, and the teardown itself.
// See docs/data-lifecycle.md.
//
// Steps are ordered so EVERY crash window is finishable by retrying with the
// still-live session (sessions go last for exactly that reason), and each step
// is idempotent:
//   gate → wipe data (DO + R2) → tombstone the username → delete doors + user
//   (one atomic shard batch — the credential and its keys leave together, the
//   same pairing create-account writes them with) → revoke every session.
// The tombstone lands BEFORE the shard delete so the retry path can always
// recognize an in-progress deletion: a tombstoned entry with the user row gone
// is a resumed teardown (finish the remaining steps), while a missing user row
// WITHOUT a tombstone stays what it always was — a server-side inconsistency to
// log and answer opaquely. From the tombstone on, sign-in is already refused.
//
// Deliberately NOT deleted: `purchases` rows (money-adjacent audit state — a
// provider id + our random userId, no personal data; late provider webhooks for
// a deleted account just log-and-drop in applyPaddleEvent), and the username row
// itself (the tombstone — the handle stays occupied so nobody can re-register it
// and be mistaken for the previous owner).
export async function deleteAccount(
  env: Bindings,
  session: { userId: string; accountDbId: string },
  proof: { username: string; publicKey: string },
): Promise<void> {
  const invalid = () => new HttpError(401, 'invalid_credentials', 'Incorrect username or password');

  // Bind the proof to the SESSION's account: the signed username must resolve to
  // the authed user, so a valid proof for account A riding a session for account
  // B (or a replay against the wrong account) dies here.
  const directory = usernamesRepo(env.DIRECTORY_DB);
  const entry = await directory.findByUsername(proof.username);
  if (!entry || entry.userId !== session.userId) throw invalid();

  // THE load-bearing check, same as sign-in: the proof's publicKey must equal
  // the STORED credential — a bearer token alone must never be enough to erase
  // an account. A missing user row under a tombstone is the one sanctioned
  // exception: that's a crashed teardown resuming (the doors are already gone,
  // so there is no stored credential left to compare — and nothing left for the
  // check to protect).
  const shard = accountsDb(env, session.accountDbId);
  const user = await usersRepo(shard).findById(session.userId);
  if (user) {
    if (proof.publicKey !== user.publicKey) throw invalid();
  } else if (entry.deletedAt === null) {
    console.error('deleteAccount: directory references missing user', session.userId);
    throw invalid();
  }

  // Refuse while a subscription would keep billing: renewing, or in dunning
  // (grace — the provider is still retrying charges). A canceled-but-entitled
  // subscription passes — the user already ended billing, and holding deletion
  // until the paid period runs out would be hostile (the client's copy says the
  // remaining time is forfeited). Cancellation happens in the Paddle portal
  // (POST /v1/iap/portal), never here — deletion must not mutate provider state.
  //
  // Only gate a FRESH deletion (no tombstone yet). Once tombstoned, the teardown
  // is committed and the data is already wiped, so the billing check is moot —
  // and re-running it on a resumed teardown could 409 and strand the remaining
  // steps (notably the session revoke), leaving live sessions for a deleted
  // account. A tombstone always implies this account already cleared the gate
  // once (it's only set below, after this check), so skipping it here can never
  // weaken a first-time deletion. Matches the "every crash window is finishable
  // by retrying" invariant above.
  //
  // REFRESHES (the third opt-in — see services/iap.ts): this is the last read
  // before an IRREVERSIBLE action whose wrong answer bills the user. A row stale
  // in the "period ended, renewal event never landed" direction reads as free
  // and waves the deletion through while the provider keeps charging — and there
  // is no account left to reach the portal with (POST /v1/iap/portal needs a
  // session). That shape is exactly what needsRefresh catches. The opposite
  // staleness (looks healthy, actually canceled at the provider) is invisible to
  // any read-path heuristic — the scheduled-sweep case — so refreshing here can
  // never 409 a deletion that would otherwise have passed. Once per account
  // ever, on a path already doing proof verification plus a DO + R2 wipe; and
  // refreshPurchase never throws, so a provider that's down simply leaves the
  // gate reading the stored row, exactly as it does today.
  if (entry.deletedAt === null) {
    const subscription = await getSubscriptionStatus(env, session.userId, { refresh: true });
    if (subscription.status === 'grace' || subscription.willRenew) {
      throw new HttpError(
        409,
        'subscription_active',
        'Cancel your subscription before deleting your account',
      );
    }
  }

  await deleteAllUserData(env, session.userId);
  await directory.tombstone(proof.username, session.userId);
  await shard.batch([
    accountKeysRepo(shard).deleteAllByUserIdStmt(session.userId),
    usersRepo(shard).deleteStmt(session.userId),
  ]);
  await sessionsRepo(env.SESSIONS_DB).deleteByUserId(session.userId);
}
