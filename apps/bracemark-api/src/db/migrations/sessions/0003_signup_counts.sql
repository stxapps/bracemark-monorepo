-- Migration 0003 (sessions) — the per-network daily signup counter. Mirrors
-- db/schemas/sessions.sql.
--
-- services/signup-cap.ts counts the accounts each caller network (an IPv4
-- address, or an IPv6 /64) creates per UTC day, and refuses past the env's cap.
-- It lives here rather than in the directory because it is the same kind of
-- state as a session: high-churn and disposable. Losing it resets today's counts
-- and nothing else, and it stays out of the Tier-0 backups (docs/server-backups.md).
--
-- network_hash is HMAC-SHA-256 of the network under a key derived from a server
-- secret, so a dump of this table does not name an address. Rows older than
-- today are deleted by the daily cron (worker.ts).
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Apply it before deploying the code that writes the table.

CREATE TABLE IF NOT EXISTS signup_counts (
  network_hash TEXT NOT NULL,
  day          INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (network_hash, day)
);
CREATE INDEX IF NOT EXISTS idx_signup_counts_day ON signup_counts(day);
