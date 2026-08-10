// Session repository — lives in SESSIONS_DB (its own database; see
// schemas/sessions.sql for why). We store the token HASH (never the raw token;
// see lib/ids.ts) and carry user_id + account_db_id so the auth guard resolves
// "bearer token -> user -> which accounts db" in a single read, with no
// directory hop.

// Public domain entity (camelCase). Behavior can hang off this later; for now
// it's the shape services/routes consume.
export type SessionEntity = {
  id: string;
  userId: string;
  // The accounts shard holding this user's rows (e.g. '1'); resolve via db-routes.
  accountDbId: string;
  expiresAt: number; // epoch ms
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type SessionRow = {
  id: string;
  token_hash: string;
  user_id: string;
  account_db_id: string;
  expires_at: number;
};

function toEntity(r: Omit<SessionRow, 'token_hash'>): SessionEntity {
  return {
    id: r.id,
    userId: r.user_id,
    accountDbId: r.account_db_id,
    expiresAt: r.expires_at,
  };
}

export function sessionsRepo(db: D1Database) {
  return {
    // Looked up by the auth guard on every protected request. Returns null when
    // no row matches (unknown/revoked token).
    async findByTokenHash(tokenHash: string): Promise<SessionEntity | null> {
      const row = await db
        .prepare(
          `SELECT id, user_id, account_db_id, expires_at
             FROM sessions WHERE token_hash = ?`,
        )
        .bind(tokenHash)
        .first<Omit<SessionRow, 'token_hash'>>();
      return row ? toEntity(row) : null;
    },

    async insert(s: {
      id: string;
      tokenHash: string;
      userId: string;
      accountDbId: string;
      expiresAt: number;
    }): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sessions (id, token_hash, user_id, account_db_id, created_at, expires_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(s.id, s.tokenHash, s.userId, s.accountDbId, Date.now(), s.expiresAt, Date.now())
        .run();
    },

    async deleteById(id: string): Promise<void> {
      await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    },

    // Revoke EVERY session for a user — account deletion (the account is gone, so
    // the caller's own session goes too). Indexed by idx_sessions_user_id, so it's
    // a range delete, not a scan.
    async deleteByUserId(userId: string): Promise<void> {
      await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    },

    // Revoke every OTHER session for a user, keeping the caller's own (exceptId)
    // alive — change-password's forward-cut-off, and "sign out other devices"
    // (POST /v1/auth/sign-out-others). Same idx_sessions_user_id range delete.
    // deleteByUserId is the sibling that spares nothing (account deletion).
    async deleteByUserIdExcept(userId: string, exceptId: string): Promise<void> {
      await db
        .prepare(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`)
        .bind(userId, exceptId)
        .run();
    },

    // Housekeeping: drop expired rows so the sessions table stays small. Call
    // from a scheduled handler (cron trigger) once that's wired.
    async deleteExpired(now: number = Date.now()): Promise<void> {
      await db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();
    },
  };
}
