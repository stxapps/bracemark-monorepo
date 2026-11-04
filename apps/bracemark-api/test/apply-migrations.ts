import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs in the Workers runtime before each test file (vitest `setupFiles`). The
// pool's D1 databases start EMPTY — vitest-pool-workers does not auto-apply
// migrations — so we apply each role's SQL (read in vitest.config.ts, handed
// over as the *_MIGRATIONS bindings) to its database.
//
// Storage is NOT reset between the tests of one file: a row one test writes is
// there for the next (measured, vitest-pool-workers 0.16). A spec that counts
// rows works on keys of its own — a username, an address, a day — rather than
// assuming an empty table (services/signup-cap.spec.ts).
//
// Each D1 role has its own migration history, mirroring how `nx run
// bracemark-api:migrate` applies them to the live databases.
await applyD1Migrations(env.DIRECTORY_DB, env.DIRECTORY_MIGRATIONS);
await applyD1Migrations(env.ACCOUNTS_DB_1, env.ACCOUNTS_MIGRATIONS);
await applyD1Migrations(env.SESSIONS_DB, env.SESSIONS_MIGRATIONS);
