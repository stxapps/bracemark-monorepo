// Account-keys repository — the "doors". One wrapped-DEK blob per access method,
// living in the SAME ACCOUNTS_DB_N shard as this account's `users` row, so the
// credential and its Tier-0 key material commit together in one batch.

import type { DoorType } from '@stxapps/shared';

// Public domain entity (camelCase). Bytes are surfaced as Uint8Array; D1 returns
// BLOBs as ArrayBuffer, converted in toEntity.
export type AccountKeyEntity = {
  userId: string;
  doorType: DoorType;
  wrappedDek: Uint8Array;
  iv: Uint8Array;
  version: number;
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type AccountKeyRow = {
  user_id: string;
  door_type: DoorType;
  wrapped_dek: ArrayBuffer;
  iv: ArrayBuffer;
  version: number;
};

function toEntity(r: AccountKeyRow): AccountKeyEntity {
  return {
    userId: r.user_id,
    doorType: r.door_type,
    wrappedDek: new Uint8Array(r.wrapped_dek),
    iv: new Uint8Array(r.iv),
    version: r.version,
  };
}

export function accountKeysRepo(db: D1Database) {
  return {
    // All doors for an account — settings UIs that list every door. Sign-in wants
    // only ONE door, so it uses findByUserIdAndDoorType (a point-lookup) instead of
    // fetching every door's wrapped DEK here and discarding all but one.
    async findByUserId(userId: string): Promise<AccountKeyEntity[]> {
      const { results } = await db
        .prepare(
          `SELECT user_id, door_type, wrapped_dek, iv, version
             FROM account_keys WHERE user_id = ?`,
        )
        .bind(userId)
        .all<AccountKeyRow>();
      return results.map(toEntity);
    },

    // One specific door by its FULL primary key (user_id, door_type) — an exact
    // index point-lookup, not a scan, so it reads just that door's wrapped DEK
    // without pulling the others over the wire (matters on the pre-auth password-
    // door fetch). Returns null when the user has no door of that type.
    async findByUserIdAndDoorType(
      userId: string,
      doorType: DoorType,
    ): Promise<AccountKeyEntity | null> {
      const r = await db
        .prepare(
          `SELECT user_id, door_type, wrapped_dek, iv, version
             FROM account_keys WHERE user_id = ? AND door_type = ?`,
        )
        .bind(userId, doorType)
        .first<AccountKeyRow>();
      return r ? toEntity(r) : null;
    },

    // Returns the prepared DELETE of EVERY door so account deletion can batch it
    // atomically with the users delete. This is the cryptographic kill: with all
    // wrapped DEKs gone, no door can ever recover the DEK, so any stray
    // ciphertext is permanently unreadable.
    deleteAllByUserIdStmt(userId: string): D1PreparedStatement {
      return db.prepare(`DELETE FROM account_keys WHERE user_id = ?`).bind(userId);
    },

    // Returns the prepared INSERT so create-account can batch it atomically with
    // the users/account_keys writes. `version` starts at 1 and is bumped on each
    // re-wrap (e.g. password change) so the row is auditable.
    insertStmt(k: {
      userId: string;
      doorType: DoorType;
      wrappedDek: Uint8Array;
      iv: Uint8Array;
      version?: number;
    }): D1PreparedStatement {
      const now = Date.now();
      return db
        .prepare(
          `INSERT INTO account_keys (user_id, door_type, wrapped_dek, iv, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(k.userId, k.doorType, k.wrappedDek, k.iv, k.version ?? 1, now, now);
    },

    // Prepared UPSERT for re-wrapping a door in place — the tier-1 door rotation
    // (change password, generate/regenerate recovery). Inserts the door if the
    // account has none of that type, or replaces the wrapped DEK + IV if it does.
    // `created_at` is preserved across re-wraps (the door is the "same" door,
    // stable since first created); `version` starts at 1 and increments on every
    // re-wrap so the row stays auditable. Same PK (user_id, door_type) drives the
    // conflict target.
    upsertStmt(k: {
      userId: string;
      doorType: DoorType;
      wrappedDek: Uint8Array;
      iv: Uint8Array;
    }): D1PreparedStatement {
      const now = Date.now();
      return db
        .prepare(
          `INSERT INTO account_keys (user_id, door_type, wrapped_dek, iv, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(user_id, door_type) DO UPDATE SET
             wrapped_dek = excluded.wrapped_dek,
             iv = excluded.iv,
             version = account_keys.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(k.userId, k.doorType, k.wrappedDek, k.iv, now, now);
    },
  };
}
