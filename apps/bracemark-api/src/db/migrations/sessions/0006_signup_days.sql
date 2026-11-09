-- Migration 0006 (sessions) — the signup cap's figures, one row of totals per
-- UTC day. Mirrors db/schemas/sessions.sql.
--
-- signup_counts holds one row per network per day, and the daily cron deletes
-- every past day (worker.ts), so the figures the cap is decided from — how many
-- networks went past it, and the busiest network's signups — would otherwise
-- last only as a log line. The cron writes this row from signup_counts just
-- before that purge (services/signup-report.ts).
--
-- Totals only: no network and no HMAC of one. The caps in force are stored so a
-- row can be read without the wrangler.jsonc of its day. Every finished day gets
-- a row, zeros included, so a missing day means the cron didn't run rather than
-- that nobody signed up. Rows are kept SIGNUP_DAYS_KEPT days.
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Apply it before deploying the code that writes the table.

CREATE TABLE IF NOT EXISTS signup_days (
  day             INTEGER PRIMARY KEY,
  capped_networks INTEGER NOT NULL,
  busiest         INTEGER NOT NULL,
  cap_ipv4        INTEGER,
  cap_ipv6        INTEGER,
  enforced        INTEGER NOT NULL
);
