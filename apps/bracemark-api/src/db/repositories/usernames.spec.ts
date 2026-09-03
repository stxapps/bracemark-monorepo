import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usernamesRepo } from './usernames';

// The global uniqueness namespace, against real D1 (real PK, real ON CONFLICT).
// services/account.spec.ts covers the happy claim-then-write and its
// compensation, and routes/auth.spec.ts covers the tombstone as a user sees it
// (the handle stays taken, sign-in stays opaque). What neither can reach is the
// pair of GUARDS on the two write paths — release() and tombstone() are both
// scoped by user_id, and release() must not touch a tombstone. Nothing else
// enforces either: without them a compensating release could free a name that a
// re-created account legitimately holds, or reopen a deleted account's handle
// for re-registration.
const repo = usernamesRepo(env.DIRECTORY_DB);

describe('usernames directory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('claims a free name once — a second claim loses rather than throwing', async () => {
    expect(await repo.claim({ username: 'firstwins', userId: 'u_a', accountDbId: '1' })).toBe(true);
    expect(await repo.claim({ username: 'firstwins', userId: 'u_b', accountDbId: '1' })).toBe(
      false,
    );

    // The loser must not have overwritten the winner's routing.
    await expect(repo.findByUsername('firstwins')).resolves.toMatchObject({
      userId: 'u_a',
      accountDbId: '1',
      deletedAt: null,
    });
  });

  // Uniqueness is over the CANONICAL form; case-different spellings are the
  // same handle (and the same per-user salt input).
  it('canonicalizes on claim and on lookup', async () => {
    expect(await repo.claim({ username: 'Mixed_Case', userId: 'u_c', accountDbId: '1' })).toBe(
      true,
    );
    expect(await repo.claim({ username: 'mixed_case', userId: 'u_d', accountDbId: '1' })).toBe(
      false,
    );

    await expect(repo.findByUsername('MIXED_CASE')).resolves.toMatchObject({
      username: 'mixed_case',
      userId: 'u_c',
    });
  });

  it('returns null for a name nobody holds', async () => {
    await expect(repo.findByUsername('unheldname')).resolves.toBeNull();
  });

  it('releases our own claim, freeing the name again', async () => {
    await repo.claim({ username: 'released', userId: 'u_e', accountDbId: '1' });

    await repo.release('Released', 'u_e'); // canonicalized like every other path

    await expect(repo.findByUsername('released')).resolves.toBeNull();
    expect(await repo.claim({ username: 'released', userId: 'u_f', accountDbId: '1' })).toBe(true);
  });

  // The compensation runs after a failed shard write; by then the name may
  // already belong to someone else's successful create. Releasing it would hand
  // a live account's handle to the next signup.
  it('never releases a claim held by another account', async () => {
    await repo.claim({ username: 'notyours', userId: 'u_owner', accountDbId: '1' });

    await repo.release('notyours', 'u_intruder');

    await expect(repo.findByUsername('notyours')).resolves.toMatchObject({ userId: 'u_owner' });
  });

  // A tombstone is a permanent record, not a compensatable claim: releasing one
  // would reopen a deleted account's handle for re-registration by anyone.
  it('never releases a tombstone', async () => {
    await repo.claim({ username: 'gonebutkept', userId: 'u_g', accountDbId: '1' });
    await repo.tombstone('gonebutkept', 'u_g');

    await repo.release('gonebutkept', 'u_g');

    await expect(repo.findByUsername('gonebutkept')).resolves.toMatchObject({
      userId: 'u_g',
      deletedAt: expect.any(Number),
    });
  });

  it('tombstones in place, keeping the handle occupied', async () => {
    await repo.claim({ username: 'deleteduser', userId: 'u_h', accountDbId: '1' });

    await repo.tombstone('deleteduser', 'u_h');

    const row = await repo.findByUsername('deleteduser');
    expect(row?.deletedAt).toEqual(expect.any(Number));
    // The row surviving is the point: the PK keeps re-registration failing.
    expect(await repo.claim({ username: 'deleteduser', userId: 'u_i', accountDbId: '1' })).toBe(
      false,
    );
  });

  // Account teardown is resumable (routes/auth.spec.ts drives a resumed one), so
  // this runs more than once — the deletion TIME must stay the first one.
  it('keeps the first deletion time on a retried teardown', async () => {
    await repo.claim({ username: 'retriedteardown', userId: 'u_j', accountDbId: '1' });
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000).mockReturnValueOnce(9_000_000);

    await repo.tombstone('retriedteardown', 'u_j');
    await repo.tombstone('retriedteardown', 'u_j');

    await expect(repo.findByUsername('retriedteardown')).resolves.toMatchObject({
      deletedAt: 1_000_000,
    });
  });

  it('never tombstones another account’s handle', async () => {
    await repo.claim({ username: 'stillactive', userId: 'u_k', accountDbId: '1' });

    await repo.tombstone('stillactive', 'u_someone_else');

    await expect(repo.findByUsername('stillactive')).resolves.toMatchObject({ deletedAt: null });
  });
});
