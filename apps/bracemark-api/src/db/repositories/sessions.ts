// Session repository — lives in SESSIONS_DB (its own database; see
// schemas/sessions.sql for why). We store the token HASH (never the raw token;
// see lib/ids.ts) and carry user_id + account_db_id so the auth guard resolves
// "bearer token -> user -> which accounts db" in a single read, with no
// directory hop.
//
// Every write here is an UPDATE except insert and purge, and that's the design,
// not an accident: a session that ends keeps its row, so an old token still gets
// a verdict — `session_revoked` from the marker, `session_expired` from the
// deadline. Only cleanup deletes, and only after SESSION_PURGE_MS; a missing row
// is never evidence of anything (docs/sessions.md, _revocation, expiry and
// unknown tokens_).

// Public domain entity (camelCase). Behavior can hang off this later; for now
// it's the shape services/routes consume.
export type SessionEntity = {
  id: string;
  userId: string;
  // The accounts shard holding this user's rows (e.g. '1'); resolve via db-routes.
  accountDbId: string;
  expiresAt: number; // epoch ms — the idle deadline
  revokedAt: number | null; // epoch ms of the explicit revocation, or null
};

// Raw row as it sits in D1 (snake_case columns). Internal to this repo.
type SessionRow = {
  id: string;
  token_hash: string;
  user_id: string;
  account_db_id: string;
  expires_at: number;
  revoked_at: number | null;
};

function toEntity(r: Omit<SessionRow, 'token_hash'>): SessionEntity {
  return {
    id: r.id,
    userId: r.user_id,
    accountDbId: r.account_db_id,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

export function sessionsRepo(db: D1Database) {
  return {
    // Looked up by the auth guard on every protected request. Returns null when
    // no row matches — an unknown token, which the guard answers
    // `session_unknown`. Revoked and expired rows ARE returned: telling them
    // apart is the guard's job.
    async findByTokenHash(tokenHash: string): Promise<SessionEntity | null> {
      const row = await db
        .prepare(
          `SELECT id, user_id, account_db_id, expires_at, revoked_at
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
      now?: number;
    }): Promise<void> {
      const now = s.now ?? Date.now();
      await db
        .prepare(
          `INSERT INTO sessions (id, token_hash, user_id, account_db_id, created_at, expires_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(s.id, s.tokenHash, s.userId, s.accountDbId, now, s.expiresAt, now)
        .run();
    },

    // Slide the idle deadline to `now + idleMs`, at most once per `slideMs`.
    // The throttle and the liveness checks are IN THE PREDICATE, not in the
    // caller's read: concurrent requests can all read the same old deadline, and
    // only the first UPDATE to land still matches `expires_at < now + idle -
    // slide`, so one renewal changes the row however many are attempted. The
    // same predicate refuses revoked or expired rows. Matching the observed
    // expiry also rejects a password change that landed after this request's
    // timestamp: that newly expired deadline can still be later than `now`.
    // Returns whether it renewed.
    async renew(
      id: string,
      now: number,
      idleMs: number,
      slideMs: number,
      observedExpiresAt: number,
    ): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE sessions SET expires_at = ?, last_seen_at = ?
            WHERE id = ?
              AND revoked_at IS NULL
              AND expires_at >= ?
              AND expires_at < ?
              AND expires_at = ?`,
        )
        .bind(now + idleMs, now, id, now, now + idleMs - slideMs, observedExpiresAt)
        .run();
      return res.meta.changes > 0;
    },

    // Mark one session revoked — sign-out. COALESCE keeps the ORIGINAL
    // revocation time on a retry, so a repeated sign-out can't restart the
    // marker's retention clock. Applies to an already-expired row too: a device
    // that signs out after idling past its deadline still leaves a marker.
    async revokeById(id: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
        .bind(now, id)
        .run();
    },

    // Revoke EVERY session for a user — account deletion (the account is gone, so
    // the caller's own session goes too). The rows stay, so each device that
    // comes back learns the account's copy must go. Indexed by
    // idx_sessions_user_id, so it's a range update, not a scan.
    async revokeByUserId(userId: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`)
        .bind(now, userId)
        .run();
    },

    // Revoke every OTHER session for a user, keeping the caller's own (exceptId)
    // alive — "sign out other devices" (POST /v1/auth/sign-out-others). Same
    // range update; revokeByUserId is the sibling that spares nothing.
    async revokeByUserIdExcept(userId: string, exceptId: string, now: number): Promise<void> {
      await db
        .prepare(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
            WHERE user_id = ? AND id <> ?`,
        )
        .bind(now, userId, exceptId)
        .run();
    },

    // EXPIRE every other unrevoked session for a user — the password change.
    // Moves the deadline into the past (`now - 1`, so the guard's `expires_at <
    // now` holds even within the same millisecond), NEVER forward (MIN), and
    // never touches `revoked_at`: those devices get `session_expired`, keep
    // their copy and resume with the new password, where a revocation would
    // have made them erase it (docs/sessions.md, _changing the password expires
    // the other sessions_). A revoked row is left as it is — its verdict is the
    // stronger one.
    async expireByUserIdExcept(userId: string, exceptId: string, now: number): Promise<void> {
      await db
        .prepare(
          `UPDATE sessions SET expires_at = MIN(expires_at, ?)
            WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
        )
        .bind(now - 1, userId, exceptId)
        .run();
    },

    // Cleanup, from the daily cron (worker.ts → services/session.ts). Two
    // retention clocks, one per kind of ending: an unrevoked row is purged
    // `purgeMs` after its deadline, a revoked one `purgeMs` after its
    // revocation. A token whose row is gone answers `session_unknown`, which
    // keeps the device's library — so a longer idle can never turn into a wipe;
    // the retention only bounds how long a REVOCATION can still be delivered.
    // Returns the number of rows removed.
    async purge(now: number, purgeMs: number): Promise<number> {
      const cutoff = now - purgeMs;
      const res = await db
        .prepare(
          `DELETE FROM sessions
            WHERE (revoked_at IS NULL AND expires_at < ?)
               OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
        )
        .bind(cutoff, cutoff)
        .run();
      return res.meta.changes;
    },
  };
}
