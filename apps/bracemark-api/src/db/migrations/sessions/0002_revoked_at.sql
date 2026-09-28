-- Migration 0002 (sessions) — the explicit revocation marker. Mirrors
-- db/schemas/sessions.sql.
--
-- A revoked session KEEPS its row, stamped with when it was revoked, so an old
-- token can still be told `session_revoked` — the one answer a client may wipe
-- its local copy on. Deleting the row can't carry that message: a missing row is
-- also what cleanup, a lost or restored database, a bug, or a stranger's deploy
-- at our domain looks like, and none of those may erase a device
-- (docs/sessions.md, _revocation, expiry and unknown tokens_). NULL = not revoked.
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Apply it before deploying the guard that reads the column.

ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;

-- Cleanup's second retention clock: revoked rows are purged by `revoked_at`,
-- unrevoked ones by `expires_at` (idx_sessions_expires_at).
CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions(revoked_at);
