import type { Bindings } from './lib/env';
import { purgeSessions } from './services/session';
import { app } from './app';

// Durable Object classes must be EXPORTED from the entry module so the Workers
// runtime can discover and instantiate them for the `USER_DATA` binding
// (wrangler.jsonc → durable_objects + migrations). See src/do/user-data.ts.
export { UserDataDO } from './do/user-data';

// The daily cron (wrangler.jsonc → `triggers.crons`, per env). Today it runs one
// sweep: session cleanup, on the two retention clocks (docs/sessions.md). A
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
