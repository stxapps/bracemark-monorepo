import { canonicalizeUsername } from '@stxapps/shared';

// Username directory repository — lives in DIRECTORY_DB (the global, never-sharded
// uniqueness namespace). Maps a canonical username → the account it resolves to,
// plus the `account_db_id` routing seam. Always queried via env.DIRECTORY_DB,
// never through db-routes.
//
// Because the directory and the account rows are in SEPARATE databases, the
// username can't be claimed in the same transaction as the account write. So
// create-account is claim-then-write: claim() here (the authoritative uniqueness
// gate), then the shard write, then release() to compensate if that write fails.

// Public domain entity (camelCase).
export type UsernameEntity = {
  username: string;
  userId: string;
  // The accounts shard holding this user's rows (e.g. '1'); resolve via db-routes.
  accountDbId: string;
  // Non-null = TOMBSTONE: the account was deleted but the name stays occupied
  // (docs/data-lifecycle.md). Callers branch on it — sign-in treats a tombstone
  // as "no account" (opaquely), the availability check as taken.
  deletedAt: number | null;
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type UsernameRow = {
  username: string;
  user_id: string;
  account_db_id: string;
  deleted_at: number | null;
};

function toEntity(r: UsernameRow): UsernameEntity {
  return {
    username: r.username,
    userId: r.user_id,
    accountDbId: r.account_db_id,
    deletedAt: r.deleted_at,
  };
}

export function usernamesRepo(db: D1Database) {
  return {
    // Authoritative username lookup (the GET /v1/auth/username-available endpoint
    // is only a cheap pre-check). Canonicalizes so the lookup matches the stored
    // form and the per-user salt input.
    async findByUsername(username: string): Promise<UsernameEntity | null> {
      const r = await db
        .prepare(
          `SELECT username, user_id, account_db_id, deleted_at FROM usernames WHERE username = ?`,
        )
        .bind(canonicalizeUsername(username))
        .first<UsernameRow>();
      return r ? toEntity(r) : null;
    },

    // CLAIM the name for this account — the race-free uniqueness gate. ON CONFLICT
    // DO NOTHING makes a contended claim resolve without throwing: a concurrent
    // claim of the same name writes 0 rows. Returns true if WE claimed it, false
    // if it was already taken. (Single constrained INSERT, not a read-then-write,
    // so two simultaneous claims can't both win.)
    async claim(u: { username: string; userId: string; accountDbId: string }): Promise<boolean> {
      const res = await db
        .prepare(
          `INSERT INTO usernames (username, user_id, account_db_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(username) DO NOTHING`,
        )
        .bind(canonicalizeUsername(u.username), u.userId, u.accountDbId, Date.now())
        .run();
      return res.meta.changes > 0;
    },

    // RELEASE a claim — the compensating action when the shard account write fails
    // after a successful claim, so a crash mid-create doesn't orphan the name. The
    // `user_id` guard ensures we only delete OUR claim, never one a (re)created
    // account legitimately holds. The `deleted_at IS NULL` guard keeps it off
    // tombstones — a tombstone is a deliberate permanent record, never a
    // compensatable claim (release is only ever called on the create path, but
    // the guard makes the invariant structural rather than call-site discipline).
    async release(username: string, userId: string): Promise<void> {
      await db
        .prepare(`DELETE FROM usernames WHERE username = ? AND user_id = ? AND deleted_at IS NULL`)
        .bind(canonicalizeUsername(username), userId)
        .run();
    },

    // TOMBSTONE the name on account deletion: the row STAYS (so the PK keeps
    // re-claims failing and the handle can't be re-registered by someone else),
    // marked deleted. Idempotent — COALESCE keeps the first deletion time on a
    // retried teardown. The `user_id` guard scopes it to the account being
    // deleted, mirroring release().
    async tombstone(username: string, userId: string): Promise<void> {
      await db
        .prepare(
          `UPDATE usernames SET deleted_at = COALESCE(deleted_at, ?)
            WHERE username = ? AND user_id = ?`,
        )
        .bind(Date.now(), canonicalizeUsername(username), userId)
        .run();
    },
  };
}
