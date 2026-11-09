import type { Bindings } from './lib/env';
import { purgeSessions } from './services/session';
import { purgeSignupCounts } from './services/signup-cap';
import { purgeSignupDays, reportSignups } from './services/signup-report';
import { purgeTransferDays } from './services/transfer-budget';
import { app } from './app';

// Durable Object classes must be EXPORTED from the entry module so the Workers
// runtime can discover and instantiate them for the `USER_DATA` binding
// (wrangler.jsonc → durable_objects + migrations). See src/do/user-data.ts.
export { UserDataDO } from './do/user-data';

// The daily cron (wrangler.jsonc → `triggers.crons`, per env). It runs three jobs.
// Session cleanup, on the two retention clocks (docs/sessions.md); the signup
// figures — written down as one row of totals per finished day, then the past
// days of the per-network counter dropped (services/signup-report.ts,
// services/signup-cap.ts); and dropping the daily totals tables' old rows
// (signup_days, transfer_days). On session cleanup: a
// purged token answers `session_unknown`, which keeps the device's library, so
// this job can shorten how long a revocation stays deliverable but can never
// cause a wipe. It is also the home for the orphan-claim and tombstone-teardown
// sweepers when they land (docs/data-lifecycle.md, _deferred_).
export async function scheduled(
  _controller: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    purgeSessions(env).then(
      (purged) => console.log(`scheduled: purged ${purged} session rows`),
      (err: unknown) => console.error('scheduled: session purge failed', err),
    ),
  );
  // The report writes the finished days' totals from the per-network counts, so
  // it runs before the purge that drops them. A failed report must not stop the
  // purge: /privacy promises the per-network rows go shortly after their day,
  // and that outranks a day's totals. A day lost that way has no signup_days
  // row, which is how it shows.
  ctx.waitUntil(
    reportSignups(env)
      .catch((err: unknown) => console.error('scheduled: signup report failed', err))
      .then(() => purgeSignupCounts(env))
      .then(
        (purged) => console.log(`scheduled: purged ${purged} signup-count rows`),
        (err: unknown) => console.error('scheduled: signup-count purge failed', err),
      ),
  );
  ctx.waitUntil(
    Promise.all([purgeSignupDays(env), purgeTransferDays(env)]).then(
      ([days, transfers]) =>
        console.log(`scheduled: purged ${days} signup-day and ${transfers} transfer-day rows`),
      (err: unknown) => console.error('scheduled: totals purge failed', err),
    ),
  );
}

// Cloudflare Workers entry. The runtime calls `fetch(request, env, ctx)` on the
// default export — Hono's `app.fetch` — and `scheduled(controller, env, ctx)`
// for each cron trigger. This is the only entry — bracemark-api runs solely on
// Workers (no Node entry), so config always comes from `c.env` (wrangler.jsonc
// vars/bindings); see app.ts.
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Bindings>;
