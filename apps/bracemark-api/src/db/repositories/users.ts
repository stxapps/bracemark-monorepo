// User repository — the account identity + credential, in an ACCOUNTS_DB_N shard
// (always the same shard as this account's account_keys). The username is NOT
// here — it lives in the `usernames` directory (DIRECTORY_DB); this row is keyed
// by the random user_id. The user's actual data lives in the durable object keyed
// by that same user_id.

// Public domain entity (camelCase).
export type UserEntity = {
  id: string;
  // Ed25519 credential (hex). Stable across password changes under the DEK model.
  publicKey: string;
  createdAt: number;
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type UserRow = {
  id: string;
  public_key: string;
  created_at: number;
};

function toEntity(r: UserRow): UserEntity {
  return { id: r.id, publicKey: r.public_key, createdAt: r.created_at };
}

export function usersRepo(db: D1Database) {
  return {
    async findById(id: string): Promise<UserEntity | null> {
      const r = await db
        .prepare(`SELECT id, public_key, created_at FROM users WHERE id = ?`)
        .bind(id)
        .first<UserRow>();
      return r ? toEntity(r) : null;
    },

    // Returns the prepared INSERT so create-account can batch it atomically with
    // the users/account_keys writes.
    insertStmt(u: { id: string; publicKey: string }): D1PreparedStatement {
      const now = Date.now();
      return db
        .prepare(`INSERT INTO users (id, public_key, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .bind(u.id, u.publicKey, now, now);
    },

    // Returns the prepared DELETE so account deletion can batch it atomically
    // with the account_keys delete (the credential and its doors leave together,
    // the same all-or-nothing pairing create-account writes them with).
    deleteStmt(id: string): D1PreparedStatement {
      return db.prepare(`DELETE FROM users WHERE id = ?`).bind(id);
    },
  };
}
