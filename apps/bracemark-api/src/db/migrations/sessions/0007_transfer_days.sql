-- Migration 0007 (sessions) — daily totals of accounts passing a step of the
-- monthly transfer count. Mirrors db/schemas/sessions.sql.
--
-- The per-account counts live in each user's Durable Object
-- (do/repositories/transfer-budget.ts), where no cron can reach them. So the
-- call that moves a count past a step adds one to that day's total here
-- (services/transfer-budget.ts). Counts only rise within a month, so an account
-- passes each step at most once a month, and a month's rows for a step add up to
-- how many accounts reached it.
--
-- Totals only: no user id, and no row per account. `budget` marks the step that
-- is the plan's own threshold (TRANSFER_BUDGET_*_PER_MONTH); the others are the
-- fixed ladder the thresholds are tuned from. Rows are kept TRANSFER_DAYS_KEPT
-- days, deleted by the daily cron (worker.ts).
--
-- Append-only: the sessions database is already deployed (docs/local-first-sync.md,
-- _schema changes_). Apply it before deploying the code that writes the table.

CREATE TABLE IF NOT EXISTS transfer_days (
  day      INTEGER NOT NULL,
  counter  TEXT    NOT NULL,
  plan     TEXT    NOT NULL,
  step     INTEGER NOT NULL,
  budget   INTEGER NOT NULL,
  accounts INTEGER NOT NULL,
  PRIMARY KEY (day, counter, plan, step)
);
