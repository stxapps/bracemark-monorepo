-- Migration 0004 (sessions) — one index for cleanup's two clocks. Mirrors
-- db/schemas/sessions.sql.
--
-- The daily purge (sessionsRepo.purge) deletes
--   (revoked_at IS NULL AND expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)
-- With one index per column, SQLite answered the first branch from
-- idx_sessions_revoked_at (revoked_at IS NULL), which is every live session,
-- then checked expires_at row by row. So each run read the whole live table,
-- inside the write lock that the auth guard's renewals wait on. On
-- (revoked_at, expires_at) both branches are ranges over the covering index,
-- and a run reads only the rows it deletes.
--
-- The two single-column indexes go. No other query filters on expires_at or
-- revoked_at (renewal and revocation find their row by id or user_id), and the
-- composite's leading column serves anything that only wants revoked_at. Every
-- renewal rewrites expires_at, so this also leaves the hottest write in the
-- table updating one index instead of two.
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). No query names an index, so old code runs the same against
-- this schema, and it is safe to apply before or after the deploy.

CREATE INDEX IF NOT EXISTS idx_sessions_purge ON sessions(revoked_at, expires_at);
DROP INDEX IF EXISTS idx_sessions_expires_at;
DROP INDEX IF EXISTS idx_sessions_revoked_at;
