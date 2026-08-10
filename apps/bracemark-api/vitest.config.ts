import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// bracemark-api's tests run INSIDE the Workers runtime (workerd via miniflare), not
// on Node — so `env.DIRECTORY_DB` & co. are real local D1, `env.USER_DATA` is a
// real SQLite-backed Durable Object, and R2 is real. That's the whole reason we
// don't use a Node runner (jest) here: the binding-dependent logic
// (createAccount's claim-then-write, the DO's op log) can only be exercised
// honestly against the actual runtime, where a mock would just encode our
// assumptions back at us.
//
// We point the pool at the committed wrangler config's `development` env —
// bindings live ONLY under `env.*` there (none at top level), so `environment`
// is required. Local emulation means storage is ephemeral and per-run.
export default defineConfig(async () => {
  // D1 migrations are NOT auto-applied by the pool. We read each role's history
  // here in Node (each D1 role has its own dir — see src/db/migrations/README.md)
  // and hand the SQL to the worker as a binding; test/apply-migrations.ts applies
  // them to the (isolated) test databases before each test file.
  const migrationsDir = path.join(import.meta.dirname, 'src/db/migrations');
  const [directoryMigrations, accountsMigrations, sessionsMigrations] = await Promise.all([
    readD1Migrations(path.join(migrationsDir, 'directory')),
    readD1Migrations(path.join(migrationsDir, 'accounts')),
    readD1Migrations(path.join(migrationsDir, 'sessions')),
  ]);

  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: './wrangler.jsonc',
          environment: 'development',
        },
        miniflare: {
          // Surfaced to the worker as plain-JSON env bindings so the setup file
          // can apply them. Each is a D1Migration[] of { name, queries }.
          bindings: {
            DIRECTORY_MIGRATIONS: directoryMigrations,
            ACCOUNTS_MIGRATIONS: accountsMigrations,
            SESSIONS_MIGRATIONS: sessionsMigrations,
            // In deployed envs this is a wrangler SECRET (never in wrangler.jsonc),
            // so the test pool provides a known value for the webhook signature
            // tests (routes/iap.spec.ts) to sign with.
            PADDLE_WEBHOOK_SECRET: 'test-webhook-secret',
            // Store-IAP secrets (also `wrangler secret put` in deployed envs).
            // The private keys must be REAL keys — lib/appstore.ts /
            // lib/playstore.ts import them via crypto.subtle before signing the
            // store-API JWTs — but the store endpoints themselves are fetchMock'd
            // in routes/iap.spec.ts, so throwaway per-run keys are exactly right.
            APPSTORE_PRIVATE_KEY: generateKeyPairSync('ec', { namedCurve: 'P-256' })
              .privateKey.export({ type: 'pkcs8', format: 'pem' })
              .toString(),
            PLAY_SA_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 })
              .privateKey.export({ type: 'pkcs8', format: 'pem' })
              .toString(),
            PLAY_NOTIFY_TOKEN: 'test-notify-token',
          },
        },
      }),
    ],
  };
});
