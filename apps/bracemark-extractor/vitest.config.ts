import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// bracemark-extractor's tests run INSIDE the Workers runtime (workerd via miniflare),
// not on Node — so the handlers exercise the REAL `HTMLRewriter`, `fetch`,
// `AbortSignal.timeout`, and stream primitives they use in production, rather than
// Node polyfills that would encode our assumptions back at us.
//
// Unlike bracemark-api there are NO storage bindings to migrate (no D1/R2/DO): the
// extractor is a pure function. We point the pool at the committed `development`
// env, where the rate-limit bindings live (under env.*), so `environment` is
// required. Tests that fetch arbitrary URLs stub `globalThis.fetch`.
export default defineConfig({
  test: {},
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
        environment: 'development',
      },
    }),
  ],
});
