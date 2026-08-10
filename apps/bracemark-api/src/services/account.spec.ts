import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { accountsDb } from '../db/db-routes';
import { accountKeysRepo } from '../db/repositories/account-keys';
import { sessionsRepo } from '../db/repositories/sessions';
import { usernamesRepo } from '../db/repositories/usernames';
import { usersRepo } from '../db/repositories/users';
import { hashToken } from '../lib/ids';
import { createAccount, type CreateAccountInput } from './account';

// These exercise the part of bracemark-api a Node runner can't: createAccount's
// claim-then-write across TWO databases (the global directory + an accounts
// shard) and its compensating release. Real D1 here means real PK constraints
// and a real atomic batch — the failure modes a mock would paper over.

// users.public_key is UNIQUE, so every account needs a distinct key.
let pubKeyCounter = 0;
function uniquePublicKey(): string {
  pubKeyCounter += 1;
  return `pubkey_${pubKeyCounter.toString().padStart(4, '0')}`;
}

function input(overrides: Partial<CreateAccountInput> = {}): CreateAccountInput {
  return {
    username: 'alice',
    publicKey: uniquePublicKey(),
    doors: [
      {
        doorType: 'password',
        wrappedDek: new Uint8Array([1, 2, 3]),
        iv: new Uint8Array([4, 5, 6]),
      },
    ],
    ...overrides,
  };
}

describe('createAccount', () => {
  it('claims the username, writes user + doors, and mints a session', async () => {
    const args = input({ username: 'alice' });
    const { userId, session } = await createAccount(env, args);

    // (1) the username is now claimed in the global directory, pointing at this user
    const claim = await usernamesRepo(env.DIRECTORY_DB).findByUsername('alice');
    expect(claim).toEqual({ username: 'alice', userId, accountDbId: '1', deletedAt: null });

    // (2) the user row + its door committed in the accounts shard
    const shard = accountsDb(env, '1');
    expect(await usersRepo(shard).findById(userId)).toMatchObject({
      id: userId,
      publicKey: args.publicKey,
    });
    const doors = await accountKeysRepo(shard).findByUserId(userId);
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ userId, doorType: 'password' });

    // (3) a session was minted — only the token HASH is stored, so look it up by hash
    const stored = await sessionsRepo(env.SESSIONS_DB).findByTokenHash(
      await hashToken(session.token),
    );
    expect(stored).toMatchObject({ userId, accountDbId: '1' });
  });

  it('rejects a username already taken with a 409', async () => {
    await createAccount(env, input({ username: 'bob' }));

    await expect(createAccount(env, input({ username: 'bob' }))).rejects.toMatchObject({
      status: 409,
      code: 'username_taken',
    });
  });

  it('releases the claim when the shard write fails (compensation)', async () => {
    // Two doors with the SAME doorType collide on account_keys' (user_id,
    // door_type) PK, so the atomic batch throws AFTER the username is claimed —
    // driving the compensating release. This is the orphan-claim guard.
    const args = input({
      username: 'carol',
      doors: [
        { doorType: 'password', wrappedDek: new Uint8Array([1]), iv: new Uint8Array([2]) },
        { doorType: 'password', wrappedDek: new Uint8Array([3]), iv: new Uint8Array([4]) },
      ],
    });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(createAccount(env, args)).rejects.toMatchObject({ status: 500 });

    // The client gets an opaque 500 on purpose, so the cause exists in exactly
    // one place — this log. Spying keeps the suite quiet and pins that.
    expect(error).toHaveBeenCalledWith('createAccount shard write failed:', expect.any(Error));
    error.mockRestore();

    // The name must be free again (claim released) and no user row left behind —
    // the whole point of the compensation: a failed create never orphans a name.
    expect(await usernamesRepo(env.DIRECTORY_DB).findByUsername('carol')).toBeNull();
    const { results } = await accountsDb(env, '1')
      .prepare(`SELECT id FROM users WHERE public_key = ?`)
      .bind(args.publicKey)
      .all();
    expect(results).toHaveLength(0);
  });
});
