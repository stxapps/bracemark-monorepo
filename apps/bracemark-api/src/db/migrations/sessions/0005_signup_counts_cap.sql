-- Migration 0005 (sessions) — each signup counter row carries the cap it was
-- counted against. Mirrors db/schemas/sessions.sql.
--
-- The cap became two settings (services/signup-cap.ts), one for an IPv4 address
-- and one for an IPv6 /64, which may be set apart. The row holds an HMAC of the
-- network, never the network, so the daily report (services/signup-report.ts)
-- can't tell from the row which family it was and which cap it reached. The writer stamps the cap
-- instead, and the report counts `count > cap`. That stays right even when a
-- cap changes mid-day, because each row is judged by the cap it was refused
-- under.
--
-- Nullable: a row written by the code before this one has no cap, and the
-- report skips it. Those rows last until the next cron purges them.
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Apply it before deploying the code that writes the column;
-- the code before it never names the column, so it runs the same either way.

ALTER TABLE signup_counts ADD COLUMN cap INTEGER;
