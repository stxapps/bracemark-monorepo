-- Migration 0002 (directory) — an index on usernames.created_at. Mirrors
-- db/schemas/directory.sql.
--
-- The daily cron counts the accounts made in the last 24 h
-- (services/signup-report.ts: `COUNT(*) … WHERE created_at >= ?`). Without this
-- index that count scans the whole directory every day, so it costs one read
-- per account ever made, and that grows forever. With it, the count is a range
-- over the covering index and reads only the day's new rows. Signup pays one
-- extra index write, which is nothing next to the rest of create-account.
--
-- Append-only: the directory database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Old code ignores the index, so this is safe to apply before
-- or after the deploy.

CREATE INDEX IF NOT EXISTS idx_usernames_created_at ON usernames(created_at);
