/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from 'cloudflare:test';

import type { Bindings } from '../src/lib/env';

// `cloudflare:test`'s `env` is typed as `Cloudflare.Env`. We don't run `wrangler
// types` to generate that, so declare it here: the app's runtime Bindings (so
// tests get the same typed `env.DIRECTORY_DB` & co. the app sees) plus the
// migration arrays injected as bindings in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      DIRECTORY_MIGRATIONS: D1Migration[];
      ACCOUNTS_MIGRATIONS: D1Migration[];
      SESSIONS_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
